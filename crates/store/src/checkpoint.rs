//! Durable workspace epochs and recovery operations; never cascade away recoverable files.
use crate::{Result, StoreHandle};
use brigadier_core::checkpoint::{Epoch, RestorePlan};
use serde::{Deserialize, Serialize};

/// Separately journaled filesystem/provider/send transaction.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceRewind {
    /// Operation identity (opaque preview ticket).
    pub id: String,
    /// Session whose native context is affected.
    pub session: String,
    /// Canonical workspace, used to block every overlapping session.
    pub workspace: String,
    /// Persisted phase; unknown outcomes are never retried automatically.
    pub phase: String,
    /// Exact recovery and intended path states.
    pub plan: RestorePlan,
    /// Edited draft survives native success and app restart.
    pub draft: String,
    /// Original human UI row identity.
    pub target_id: String,
    /// Verified provider target UUID.
    pub target_uuid: String,
    /// Provider concurrency guard.
    pub latest_uuid: String,
    /// Adapter response-time boundary, if confirmed.
    pub through_seq: Option<u64>,
    /// Number of path intents durably issued; recovery still checks actual path state.
    pub paths_started: usize,
    /// Prepared edited-message ID, if reserved.
    pub new_turn: Option<String>,
    /// Failure detail retained for recovery.
    pub error: Option<String>,
}
/// Durable apply-to-project preview and progress. It never commits the project index.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceApply {
    /// Preview identity and durable recovery marker.
    pub id: String,
    /// Owning session.
    pub session: String,
    /// Expected source state.
    pub source: brigadier_core::checkpoint::Snapshot,
    /// Project file delta and recovery state.
    pub plan: RestorePlan,
    /// preview, applying, complete, or failed.
    pub phase: String,
    /// Issued file changes.
    pub paths_started: usize,
    /// Last failure.
    pub error: Option<String>,
}
impl StoreHandle {
    /// Store before returning a preview or mutating a path.
    pub async fn save_workspace_apply(&self, op: WorkspaceApply) -> Result<()> {
        let body = serde_json::to_string(&op).expect("apply plain values");
        self.durable(move |conn| {
            conn.execute("INSERT INTO workspace_applies(id,session_id,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body",(&op.id,&op.session,body))?;
            Ok(())
        }).await
    }
    /// Saved previews include incomplete applies for explicit retry after restart.
    pub async fn workspace_applies(&self, session: String) -> Result<Vec<WorkspaceApply>> {
        self.query(move |conn| {
            let mut stmt = conn
                .prepare("SELECT body FROM workspace_applies WHERE session_id=?1 ORDER BY rowid")?;
            let rows = stmt.query_map([session], |r| r.get::<_, String>(0))?;
            rows.map(|row| {
                serde_json::from_str(&row?).map_err(|e| crate::Error::Io(std::io::Error::other(e)))
            })
            .collect()
        })
        .await
    }

    /// Called only after the supervisor has stopped and drained session writers.
    pub async fn delete_workspace_checkpoints(&self, session: String) -> Result<()> {
        self.durable(move |conn| {
            conn.execute(
                "DELETE FROM workspace_epochs WHERE session_id=?1",
                [&session],
            )?;
            conn.execute(
                "DELETE FROM workspace_applies WHERE session_id=?1",
                [&session],
            )?;
            conn.execute(
                "DELETE FROM workspace_rewinds WHERE session_id=?1",
                [&session],
            )?;
            Ok(())
        })
        .await
    }

    /// FULL synchronous commit before a provider message can be dispatched.
    pub async fn save_workspace_epoch(&self, session: String, epoch: Epoch) -> Result<()> {
        let body = serde_json::to_string(&epoch).expect("checkpoint plain values");
        self.durable(move |conn| {
            conn.execute("INSERT INTO workspace_epochs(session_id,turn_id,body,updated_at) VALUES(?1,?2,?3,unixepoch()) ON CONFLICT(session_id,turn_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",(&session,&epoch.turn_id,&body))?;
            Ok(())
        }).await
    }
    /// Ordered capture history, including incomplete epochs. Caller checks exact message coverage.
    pub async fn workspace_epochs(&self, session: String) -> Result<Vec<Epoch>> {
        self.query(move |conn| {
            let mut stmt = conn
                .prepare("SELECT body FROM workspace_epochs WHERE session_id=?1 ORDER BY rowid")?;
            let rows = stmt.query_map([session], |r| r.get::<_, String>(0))?;
            rows.map(|r| {
                let raw = r?;
                serde_json::from_str(&raw).map_err(|e| {
                    crate::Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
                })
            })
            .collect()
        })
        .await
    }
    /// FULL synchronous commit before each externally observable transaction step.
    /// Only epochs whose user message remains in the visible conversation.
    pub async fn visible_workspace_epochs(&self, session: String) -> Result<Vec<Epoch>> {
        self.query(move |conn| {
            let mut stmt=conn.prepare("SELECT body FROM workspace_epochs e WHERE session_id=?1 AND EXISTS (SELECT 1 FROM chat_items c WHERE c.session_id=e.session_id AND c.provider_uuid=e.turn_id) ORDER BY rowid")?;
            let rows=stmt.query_map([session], |r| r.get::<_,String>(0))?;
            rows.map(|row| serde_json::from_str(&row?).map_err(|e|crate::Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidData,e)))).collect()
        }).await
    }
    /// Commit recovery state before each externally observable transaction step.
    pub async fn save_workspace_rewind(&self, op: WorkspaceRewind) -> Result<()> {
        let body = serde_json::to_string(&op).expect("checkpoint plain values");
        self.durable(move |conn| {
            conn.execute("INSERT INTO workspace_rewinds(id,session_id,workspace,phase,body,updated_at) VALUES(?1,?2,?3,?4,?5,unixepoch()) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,body=excluded.body,updated_at=excluded.updated_at",(&op.id,&op.session,&op.workspace,&op.phase,&body))?;
            Ok(())
        }).await
    }
    /// Recovery records stay available even if their source session was removed.
    pub async fn workspace_rewinds(&self, workspace: String) -> Result<Vec<WorkspaceRewind>> {
        let workspace = std::fs::canonicalize(&workspace)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(workspace);
        self.query(move |conn| {
            let mut stmt = conn
                .prepare("SELECT body FROM workspace_rewinds WHERE workspace=?1 ORDER BY rowid")?;
            let rows = stmt.query_map([workspace], |r| r.get::<_, String>(0))?;
            rows.map(|r| {
                let raw = r?;
                serde_json::from_str(&raw).map_err(|e| {
                    crate::Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
                })
            })
            .collect()
        })
        .await
    }
}

impl StoreHandle {
    /// Expire resolved archived checkpoints after 30 days. Active messages, uncategorized
    /// history, and every checkpoint while any recovery is unresolved remain protected.
    pub async fn checkpoint_retention(&self) -> Result<std::collections::BTreeSet<String>> {
        self.durable(|conn| {
            let pending:i64=conn.query_row("SELECT count(*) FROM workspace_rewinds WHERE phase NOT IN ('complete','rolled-back','rewound-unsent')",[],|r|r.get(0))?;
            if pending==0 {
                conn.execute("DELETE FROM workspace_epochs WHERE NOT EXISTS (SELECT 1 FROM chat_items c WHERE c.session_id=workspace_epochs.session_id AND c.provider_uuid=workspace_epochs.turn_id) AND EXISTS (SELECT 1 FROM chat_archive a JOIN chat_rewinds r ON r.id=a.rewind_id WHERE a.session_id=workspace_epochs.session_id AND json_extract(a.item_json,'$.provider_uuid')=workspace_epochs.turn_id AND r.state='applied' AND r.created_at<unixepoch()-2592000)",[])?;
                conn.execute("DELETE FROM workspace_rewinds WHERE phase IN ('complete','rolled-back') AND updated_at<unixepoch()-2592000",[])?;
            }
            Ok(())
        }).await?;
        self.query(|conn| {
            let mut keep = std::collections::BTreeSet::new();
            let mut stmt = conn.prepare("SELECT body FROM workspace_epochs")?;
            for body in stmt.query_map([], |r| r.get::<_, String>(0))? {
                let epoch: Epoch = serde_json::from_str(&body?)
                    .map_err(|e| crate::Error::Io(std::io::Error::other(e)))?;
                keep.insert(epoch.pre.id);
                if let Some(post) = epoch.post {
                    keep.insert(post.id);
                }
            }
            let mut stmt = conn.prepare("SELECT body FROM workspace_rewinds")?;
            for body in stmt.query_map([], |r| r.get::<_, String>(0))? {
                let op: WorkspaceRewind = serde_json::from_str(&body?)
                    .map_err(|e| crate::Error::Io(std::io::Error::other(e)))?;
                keep.insert(op.id);
                keep.insert(op.plan.current.id);
            }
            let mut stmt = conn.prepare("SELECT body FROM workspace_applies")?;
            for body in stmt.query_map([], |r| r.get::<_, String>(0))? {
                let op: WorkspaceApply = serde_json::from_str(&body?)
                    .map_err(|e| crate::Error::Io(std::io::Error::other(e)))?;
                keep.insert(op.source.id);
                keep.insert(op.plan.current.id);
            }
            Ok(keep)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn visible_deltas_exclude_archived_messages() {
        use brigadier_core::checkpoint::{Coverage, GitState, Snapshot};
        let dir = tempfile::tempdir().unwrap();
        let store = crate::Store::open(dir.path()).unwrap();
        let db = store.handle();
        let snapshot = Snapshot {
            id: "snapshot".into(),
            root: "/unused".into(),
            identity: "fixture".into(),
            tree: "tree".into(),
            files: Default::default(),
            git: GitState {
                head: "head".into(),
                index: vec![],
                policy: vec![],
            },
            coverage: Coverage::default(),
        };
        for turn in ["visible", "archived"] {
            db.save_workspace_epoch(
                "s".into(),
                Epoch {
                    turn_id: turn.into(),
                    pre: snapshot.clone(),
                    post: Some(snapshot.clone()),
                    error: None,
                },
            )
            .await
            .unwrap();
        }
        db.query(|conn| {
            conn.execute("INSERT INTO sessions(id) VALUES('s')",[])?;
            conn.execute("INSERT INTO chat_items(session_id,id,seq,at,kind,body,provider_uuid) VALUES('s','message',1,0,'{}','hello','visible')",[])?;
            Ok(())
        }).await.unwrap();
        let visible = db.visible_workspace_epochs("s".into()).await.unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].turn_id, "visible");
        assert_eq!(db.workspace_epochs("s".into()).await.unwrap().len(), 2);
    }
}
