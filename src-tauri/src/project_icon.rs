//! Bounded local icon discovery. No network, scripts, or paths outside the repository.
use crate::{error::AppError, state::AppState};
use base64::Engine;
use std::path::Path;
use tauri::State;

fn discover(root: &Path) -> Option<String> {
    let root = root.canonicalize().ok()?;
    let candidates = [
        "public/favicon.svg",
        "app/icon.svg",
        "src/app/icon.svg",
        "public/icon.svg",
        "public/logo.svg",
        "assets/logo.svg",
        "src/assets/logo.svg",
        "logo.svg",
        "public/brand/fold.svg",
        "public/favicon.png",
        "public/icon.png",
        "public/logo.png",
        "src-tauri/icons/icon.png",
        "app/icon.png",
        "src/app/icon.png",
        "public/favicon.ico",
        "favicon.ico",
        "app/favicon.ico",
        "src/app/favicon.ico",
        "static/favicon.png",
        "static/favicon.ico",
        "static/logo.svg",
        "assets/icon.png",
    ];
    for candidate in candidates {
        let Ok(path) = root.join(candidate).canonicalize() else {
            continue;
        };
        if !path.starts_with(&root) {
            continue;
        }
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > 256 * 1024 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let mime = match path.extension().and_then(|e| e.to_str()) {
            Some("svg") => {
                let Ok(svg) = std::str::from_utf8(&bytes) else {
                    continue;
                };
                let lower = svg.to_lowercase();
                if !lower.contains("<svg")
                    || [
                        "<script",
                        "<foreignobject",
                        "<!entity",
                        "<!doctype",
                        "@import",
                        "url(",
                    ]
                    .iter()
                    .any(|s| lower.contains(s))
                {
                    continue;
                }
                // xmlns URLs are harmless; external resource references are not allowed.
                let external = regex::Regex::new(
                    r#"(?:href|src)\s*=\s*["']\s*(?:https?:|//|data:|javascript:)"#,
                )
                .ok()?;
                if external.is_match(&lower) {
                    continue;
                }
                "image/svg+xml"
            }
            Some("png") if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
            Some("ico") if bytes.starts_with(&[0, 0, 1, 0]) => "image/x-icon",
            _ => continue,
        };
        return Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
    }
    None
}
#[tauri::command]
pub(crate) async fn project_icon(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, AppError> {
    let p = state
        .get()?
        .supervisor
        .project(&project_id)
        .await?
        .ok_or_else(|| AppError::invalid_argument("Project no longer exists"))?;
    tauri::async_runtime::spawn_blocking(move || discover(&p.root_path))
        .await
        .map_err(|e| AppError::io(e.to_string()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_local_svg_and_rejects_external_resources() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("public")).unwrap();
        let path = dir.path().join("public/favicon.svg");
        std::fs::write(
            &path,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>"#,
        )
        .unwrap();
        assert!(discover(dir.path())
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        std::fs::write(
            &path,
            r#"<svg><image href="https://example.com/icon.png"/></svg>"#,
        )
        .unwrap();
        assert!(discover(dir.path()).is_none());
    }
    #[cfg(unix)]
    #[test]
    fn ignores_symlinks_outside_repository() {
        let repo = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("icon.svg"), "<svg/>").unwrap();
        std::fs::create_dir(repo.path().join("public")).unwrap();
        std::os::unix::fs::symlink(
            other.path().join("icon.svg"),
            repo.path().join("public/favicon.svg"),
        )
        .unwrap();
        assert!(discover(repo.path()).is_none());
    }
}
