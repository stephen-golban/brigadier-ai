//! Immutable project attachments used by user turns and peer delegation.
use crate::{Error, Result, StoreHandle};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Image storage limit, also enforced at the IPC import boundary.
pub const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;
/// Text attachments remain small enough for the explicitly selected message context.
pub const MAX_TEXT_ATTACHMENT_BYTES: usize = 1024 * 1024;

/// Durable metadata returned after an attachment import commits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMetadata {
    /// App-minted immutable identity.
    pub id: String,
    /// Project allowed to use these bytes.
    pub project_id: String,
    /// Original display name, never interpreted as a path.
    pub name: String,
    /// Validated image or UTF-8 text MIME type.
    pub media_type: String,
    /// Exact byte count.
    pub size: u64,
    /// Import wall clock in milliseconds.
    pub created_at: i64,
}

/// Original bytes and metadata, resolved under an explicit project scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAttachment {
    /// Durable metadata.
    pub metadata: AttachmentMetadata,
    /// Full original attachment; callers validate image decoding at import.
    pub bytes: Vec<u8>,
}

fn invalid(message: &str) -> Error {
    Error::ConversationData(message.into())
}

impl StoreHandle {
    /// Permanently preserve a checkout explicitly borrowed by a task, even after its history is deleted.
    pub async fn protect_workspace(&self, path: String) -> Result<()> {
        self.durable(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO borrowed_workspaces(path) VALUES (?1)",
                [&path],
            )?;
            Ok(())
        })
        .await
    }
    /// Whether automatic cleanup must preserve this checkout.
    pub async fn workspace_is_protected(&self, path: String) -> Result<bool> {
        self.query(move |conn| {
            Ok(conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM borrowed_workspaces WHERE path=?1)",
                [&path],
                |r| r.get(0),
            )?)
        })
        .await
    }

    /// Replace execution settings exactly, including clearing a model or effort override.
    /// Partial row merges intentionally cannot clear these fields.
    pub async fn replace_execution_settings(
        &self,
        session_id: String,
        model: Option<String>,
        effort: Option<String>,
        permission: String,
    ) -> Result<()> {
        self.durable(move |conn| {
            conn.execute("UPDATE sessions SET model=?2, effort=?3, permission_mode=?4, provider_session_id=NULL, resume_token=NULL WHERE id=?1", (&session_id, &model, &effort, &permission))?;
            Ok(())
        }).await
    }

    /// Commit attachment bytes before returning an import reference. IDs cannot be overwritten.
    pub async fn import_attachment(
        &self,
        project_id: String,
        id: String,
        name: String,
        media_type: String,
        bytes: Vec<u8>,
    ) -> Result<AttachmentMetadata> {
        if id.trim().is_empty() || project_id.trim().is_empty() || name.trim().is_empty() {
            return Err(invalid("attachment ID, project and name are required"));
        }
        validate_attachment(&media_type, &bytes)?;
        let metadata = AttachmentMetadata {
            id,
            project_id,
            name,
            media_type,
            size: bytes.len() as u64,
            created_at: crate::schema::to_millis(std::time::SystemTime::now()),
        };
        let row = metadata.clone();
        self.durable(move |conn| {
            conn.execute("INSERT INTO conversation_attachments(id,project_id,name,media_type,size,created_at,bytes,lineage_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?1)",
                (&row.id, &row.project_id, &row.name, &row.media_type, row.size, row.created_at, &bytes))?;
            Ok(())
        }).await?;
        Ok(metadata)
    }

    /// Resolve full attachment bytes only for the owning project.
    pub async fn attachment(
        &self,
        project_id: String,
        id: String,
    ) -> Result<Option<StoredAttachment>> {
        self.query(move |conn| read_attachment(conn, &project_id, &id))
            .await
    }

    /// Resolve an ordered list atomically; a missing or foreign reference is an explicit error.
    pub async fn attachments(
        &self,
        project_id: String,
        ids: Vec<String>,
    ) -> Result<Vec<StoredAttachment>> {
        self.query(move |conn| {
            ids.iter()
                .map(|id| {
                    read_attachment(conn, &project_id, id)?.ok_or_else(|| {
                        invalid("attachment is missing or belongs to another project")
                    })
                })
                .collect()
        })
        .await
    }

    /// Copy explicitly authorized references atomically into a destination project.
    /// Each project retains one copy per import lineage, including repeated multi-hop returns.
    /// IDs remain project-scoped and destination bytes survive deletion of earlier copies.
    pub async fn copy_attachments(
        &self,
        source_project: String,
        destination_project: String,
        ids: Vec<String>,
    ) -> Result<Vec<AttachmentMetadata>> {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.durable(move |conn| {
            let destination_exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [&destination_project], |r| r.get(0))?;
            if !destination_exists { return Err(invalid("attachment destination project does not exist")); }
            let mut copies = Vec::with_capacity(ids.len());
            for id in ids {
                let source=read_attachment(conn,&source_project,&id)?.ok_or_else(||invalid("attachment is missing or belongs to another project"))?;
                // Lineage is an opaque immutable value, not a foreign key to the original:
                // deleting any earlier hop must not lose the identity used for future reuse.
                let lineage:String=conn.query_row("SELECT lineage_id FROM conversation_attachments WHERE id=?1 AND project_id=?2", (&id,&source_project), |r|r.get(0))?;
                let existing:Option<String>=conn.query_row("SELECT id FROM conversation_attachments WHERE project_id=?1 AND lineage_id=?2", (&destination_project,&lineage), |r|r.get(0)).optional()?;
                if let Some(copy_id)=existing {
                    let existing=read_attachment(conn,&destination_project,&copy_id)?.ok_or_else(||invalid("attachment copy is missing"))?;
                    copies.push(existing.metadata);
                    continue;
                }
                let metadata=AttachmentMetadata {id:uuid::Uuid::new_v4().to_string(),project_id:destination_project.clone(),name:source.metadata.name,media_type:source.metadata.media_type,size:source.metadata.size,created_at:crate::schema::to_millis(std::time::SystemTime::now())};
                conn.execute("INSERT INTO conversation_attachments(id,project_id,name,media_type,size,created_at,bytes,lineage_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    (&metadata.id,&metadata.project_id,&metadata.name,&metadata.media_type,metadata.size,metadata.created_at,&source.bytes,&lineage))?;
                conn.execute("INSERT INTO conversation_attachment_copies(source_id,destination_project,id) VALUES (?1,?2,?3)",(&id,&destination_project,&metadata.id))?;
                copies.push(metadata);
            }
            let _=reply.send(copies);
            Ok(())
        }).await?;
        result.await.map_err(|_| Error::Closed)
    }

    /// Keep destination bytes while a peer message is queued or its delivery is uncertain.
    /// Ownership is the destination session, so deleting a source or another session cannot
    /// collect a queued attachment before its actual user item arrives.
    pub async fn retain_attachments(&self, session_id: String, ids: Vec<String>) -> Result<()> {
        self.durable(move |conn| {
            for id in &ids {
                let owned:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM conversation_attachments a JOIN sessions s ON s.project_id=a.project_id WHERE a.id=?1 AND s.id=?2)",(id,&session_id),|r|r.get(0))?;
                if !owned { return Err(invalid("queued attachment is missing or belongs to another project")); }
            }
            for id in ids { conn.execute("INSERT OR IGNORE INTO conversation_attachment_refs(session_id,attachment_id) VALUES (?1,?2)",(&session_id,id))?; }
            Ok(())
        }).await
    }

    /// Replace the current incoming request attachment set, retaining its bytes atomically.
    pub async fn set_session_attachment_ids(
        &self,
        session_id: String,
        ids: Vec<String>,
    ) -> Result<()> {
        self.durable(move |conn| {
            for id in &ids {
                let owned:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM conversation_attachments a JOIN sessions s ON s.project_id=a.project_id WHERE a.id=?1 AND s.id=?2)",(id,&session_id),|r|r.get(0))?;
                if !owned { return Err(invalid("request attachment is missing or belongs to another project")); }
            }
            for id in &ids { conn.execute("INSERT OR IGNORE INTO conversation_attachment_refs(session_id,attachment_id) VALUES (?1,?2)",(&session_id,id))?; }
            conn.execute("INSERT INTO session_attachment_inputs(session_id,ids_json) VALUES (?1,?2) ON CONFLICT(session_id) DO UPDATE SET ids_json=excluded.ids_json",(&session_id,serde_json::to_string(&ids)?))?;
            Ok(())
        }).await
    }
    /// Metadata for every source retained by a conversation, including earlier owner turns
    /// and queued peer inputs. Does not load attachment bytes or confuse current input with history.
    pub async fn session_sources(&self, session_id: String) -> Result<Vec<AttachmentMetadata>> {
        self.query(move |conn| {
            let mut statement = conn.prepare_cached("SELECT a.id,a.project_id,a.name,a.media_type,a.size,a.created_at FROM conversation_attachment_refs r JOIN sessions s ON s.id=r.session_id JOIN conversation_attachments a ON a.id=r.attachment_id AND a.project_id=s.project_id WHERE r.session_id=?1 ORDER BY a.created_at,a.id")?;
            let rows = statement.query_map([session_id], |row| Ok(AttachmentMetadata {
                id:row.get(0)?, project_id:row.get(1)?, name:row.get(2)?, media_type:row.get(3)?, size:row.get(4)?, created_at:row.get(5)?,
            }))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        }).await
    }

    /// Only attachments belonging to the current request, never the full session history.
    pub async fn session_attachment_ids(&self, session_id: String) -> Result<Vec<String>> {
        self.query(move |conn| {
            let json: Option<String> = conn
                .query_row(
                    "SELECT ids_json FROM session_attachment_inputs WHERE session_id=?1",
                    [session_id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(json
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or_default())
        })
        .await
    }
}

fn validate_attachment(media_type: &str, bytes: &[u8]) -> Result<()> {
    let max = if media_type == "text/plain" {
        std::str::from_utf8(bytes).map_err(|_| invalid("text attachment is not UTF-8"))?;
        MAX_TEXT_ATTACHMENT_BYTES
    } else if matches!(
        media_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/octet-stream"
    ) {
        MAX_ATTACHMENT_BYTES
    } else {
        return Err(invalid("unsupported attachment MIME type"));
    };
    if bytes.is_empty() || bytes.len() > max {
        return Err(invalid(
            "attachment is empty or exceeds its type's size limit",
        ));
    }
    Ok(())
}

fn read_attachment(conn: &Connection, project: &str, id: &str) -> Result<Option<StoredAttachment>> {
    Ok(conn.query_row("SELECT id,project_id,name,media_type,size,created_at,bytes FROM conversation_attachments WHERE project_id=?1 AND id=?2", (project,id), |r| Ok(StoredAttachment {
        metadata: AttachmentMetadata {id:r.get(0)?,project_id:r.get(1)?,name:r.get(2)?,media_type:r.get(3)?,size:r.get(4)?,created_at:r.get(5)?}, bytes:r.get(6)?,
    })).optional()?)
}
