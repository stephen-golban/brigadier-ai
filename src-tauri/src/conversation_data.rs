//! Durable attachments shared by owner requests and delegated peer tasks.
use crate::{error::AppError, state::AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use brigadier_core::{
    event::SessionId,
    session::{TurnAttachment, TurnInput},
};
use brigadier_store::conversation_data::AttachmentMetadata;
use serde::Serialize;
use tauri::State;

const IMAGE_LIMIT: usize = 5 * 1024 * 1024;
const IMAGE_COUNT: usize = 20;

fn image_type(bytes: &[u8]) -> Result<&'static str, AppError> {
    if bytes.is_empty() || bytes.len() > IMAGE_LIMIT {
        return Err(AppError::invalid_argument(
            "Images must contain 1 byte to 5 MiB",
        ));
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| AppError::invalid_argument(e.to_string()))?;
    let mime = match reader.format() {
        Some(image::ImageFormat::Png) => "image/png",
        Some(image::ImageFormat::Jpeg) => "image/jpeg",
        Some(image::ImageFormat::Gif) => "image/gif",
        Some(image::ImageFormat::WebP) => "image/webp",
        _ => {
            return Err(AppError::invalid_argument(
                "File is not a supported PNG, JPEG, GIF or WebP image",
            ))
        }
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| AppError::invalid_argument(format!("Image cannot be decoded: {e}")))?;
    Ok(mime)
}

#[tauri::command]
pub(crate) async fn import_conversation_attachment(
    project_id: String,
    name: String,
    base64: String,
    state: State<'_, AppState>,
) -> Result<AttachmentMetadata, AppError> {
    crate::navigation::require_available(
        &state.get()?.data_dir,
        crate::navigation::Kind::Project,
        &project_id,
    )?;
    if state
        .get()?
        .supervisor
        .project(&project_id)
        .await?
        .is_none()
    {
        return Err(AppError::invalid_argument("Project no longer exists"));
    }
    if base64.len() > IMAGE_LIMIT.div_ceil(3) * 4 {
        return Err(AppError::invalid_argument("Image exceeds 5 MiB"));
    }
    let bytes = STANDARD
        .decode(base64)
        .map_err(|_| AppError::invalid_argument("Invalid base64 image"))?;
    let mime = match image_type(&bytes) {
        Ok(mime) => mime.to_owned(),
        Err(image_error) => {
            let image_name = std::path::Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| {
                    ["png", "jpg", "jpeg", "gif", "webp"].contains(&e.to_ascii_lowercase().as_str())
                });
            if image_name {
                return Err(image_error);
            }
            let text = std::str::from_utf8(&bytes)
                .ok()
                .filter(|t| !t.contains('\0'));
            if bytes.len() <= 1024 * 1024 && text.is_some() {
                "text/plain".to_owned()
            } else {
                return Err(image_error);
            }
        }
    };
    let name = std::path::Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("image")
        .chars()
        .take(255)
        .collect();
    Ok(state
        .get()?
        .store()
        .import_attachment(
            project_id,
            uuid::Uuid::new_v4().to_string(),
            name,
            mime,
            bytes,
        )
        .await?)
}

#[derive(Serialize)]
pub(crate) struct AttachmentPreview {
    metadata: AttachmentMetadata,
    base64: String,
}
#[tauri::command]
pub(crate) async fn conversation_attachment(
    project_id: String,
    id: String,
    state: State<'_, AppState>,
) -> Result<AttachmentPreview, AppError> {
    let stored = state
        .get()?
        .store()
        .attachment(project_id, id)
        .await?
        .ok_or_else(|| AppError::invalid_argument("Attachment is missing from this project"))?;
    Ok(AttachmentPreview {
        metadata: stored.metadata,
        base64: STANDARD.encode(stored.bytes),
    })
}

pub(crate) async fn attachments(
    state: &AppState,
    project: &str,
    ids: Vec<String>,
) -> Result<Vec<TurnAttachment>, AppError> {
    if ids.len() > IMAGE_COUNT {
        return Err(AppError::invalid_argument("At most 20 images per message"));
    }
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id.clone()) {
            return Err(AppError::invalid_argument("Duplicate attachment ID"));
        }
        let stored = state
            .get()?
            .store()
            .attachment(project.to_owned(), id.clone())
            .await?
            .ok_or_else(|| AppError::invalid_argument("Attachment is missing from this project"))?;
        let mime = if stored.metadata.media_type == "text/plain" {
            if stored.bytes.len() > 1024 * 1024 || std::str::from_utf8(&stored.bytes).is_err() {
                return Err(AppError::invalid_argument(
                    "Text attachment must be UTF-8 and at most 1 MiB",
                ));
            }
            "text/plain"
        } else {
            image_type(&stored.bytes)?
        };
        if mime != stored.metadata.media_type {
            return Err(AppError::invalid_argument(
                "Attachment content no longer matches its media type",
            ));
        }
        let text = if mime == "text/plain" {
            Some(
                String::from_utf8(stored.bytes.clone())
                    .map_err(|_| AppError::invalid_argument("Invalid UTF-8 attachment"))?,
            )
        } else {
            None
        };
        result.push(TurnAttachment {
            id,
            name: stored.metadata.name,
            media_type: mime.into(),
            base64: STANDARD.encode(stored.bytes),
            text,
        });
    }
    Ok(result)
}

/// Slash invocations retain their exact argument text. CLI command/skill expansion owns it.
pub(crate) fn slash_invocation(text: &str) -> bool {
    text.trim_start().starts_with('/')
}
pub(crate) fn contextualize(
    state: &AppState,
    project: &str,
    text: &str,
) -> Result<String, AppError> {
    if slash_invocation(text) {
        Ok(text.to_owned())
    } else {
        crate::workbench_data::contextualize(&state.get()?.data_dir, project, text)
    }
}
pub(crate) fn passive(session: &str, text: &str) -> (String, Vec<String>) {
    if slash_invocation(text) {
        (String::new(), Vec::new())
    } else {
        crate::peers::passive(session).unwrap_or_default()
    }
}

#[tauri::command]
pub(crate) async fn send_conversation_turn(
    session_id: String,
    text: String,
    attachment_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<crate::views::TurnStarted, AppError> {
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    crate::session_archive::require_active(&state.get()?.data_dir, &session_id)?;
    crate::navigation::require_available(
        &state.get()?.data_dir,
        crate::navigation::Kind::Session,
        &session_id,
    )?;
    let id = SessionId::new(session_id);
    let row = state
        .get()?
        .supervisor
        .session(&id)
        .await?
        .ok_or_else(|| AppError::invalid_argument("Session no longer exists"))?;
    let project = row.project_id.as_deref().unwrap_or("");
    let mut attachment_ids = attachment_ids;
    if !slash_invocation(&text) {
        for id in crate::peers::passive_attachment_ids(id.as_str())? {
            if !attachment_ids.contains(&id) {
                attachment_ids.push(id);
            }
        }
    }
    let images = attachments(state.inner(), project, attachment_ids).await?;
    if text.trim().is_empty() && images.is_empty() {
        return Err(AppError::invalid_argument("A message or image is required"));
    }
    if slash_invocation(&text) && !images.is_empty() {
        return Err(AppError::invalid_argument(
            "Send images with a prompt, not a slash command",
        ));
    }
    let contextual = contextualize(state.inner(), project, &text)?;
    let (passive, message_ids) = passive(id.as_str(), &text);
    crate::peers::begin_passive_delivery(&message_ids)?;
    let turn = state
        .get()?
        .supervisor
        .send_input(
            &id,
            TurnInput {
                text: format!("{contextual}{passive}"),
                display_text: Some(text.clone()),
                attachments: images,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| {
            let error = AppError::from(e);
            let _ = crate::peers::fail_passive_delivery(&message_ids, &error);
            error
        })?;
    if let Err(e) = crate::peers::acknowledge(&message_ids) {
        tracing::warn!("Peer acknowledgement failed: {}", e.message);
    }
    Ok(crate::views::TurnStarted {
        turn_id: turn.into_inner(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slash_arguments_are_never_contextualized() {
        assert!(slash_invocation("/effort high"));
        assert!(slash_invocation(" /skill argument"));
        assert!(!slash_invocation("Explain /effort"));
    }
    #[test]
    fn validates_decodable_pixels_and_rejects_truncated_png() {
        let pixels = image::DynamicImage::new_rgba8(2, 2);
        let mut output = std::io::Cursor::new(Vec::new());
        pixels
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        let bytes = output.into_inner();
        assert_eq!(image_type(&bytes).unwrap(), "image/png");
        assert!(image_type(&bytes[..bytes.len() / 2]).is_err());
    }
    #[test]
    fn image_content_not_extension_is_authoritative() {
        assert!(image_type(b"not an image.png").is_err());
        assert!(image_type(&vec![0; IMAGE_LIMIT + 1]).is_err());
        assert!(image_type(&[0xff, 0xd8, 0xff, 0xd9]).is_err());
    }
}
