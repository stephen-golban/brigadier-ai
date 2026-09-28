//! The Brain's writes, each run in one transaction on the writer thread. Each returns the
//! changes to the in-memory vectors it made, applied once it commits.

use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, Transaction, params};

use crate::db::{self, edge_kind_str, kind_str};
use crate::vectors::Change;
use crate::{Error, FileRef, NewEdge, NewNode, Result, embed};

pub(crate) fn record(
    tx: &Transaction,
    node: &NewNode,
    embedding: Option<Vec<u8>>,
    now: i64,
    changes: &mut Vec<Change>,
) -> Result<String> {
    let provenance = serde_json::to_string(&node.provenance)
        .map_err(|err| Error::Invalid(format!("provenance: {err}")))?;
    let session = node.provenance.session_id.as_deref();
    let model = embedding.as_ref().map(|_| embed::MODEL_ID);
    let existing = match &node.key {
        Some(key) => tx
            .prepare_cached("SELECT id FROM nodes WHERE kind = ?1 AND key = ?2")?
            .query_row(params![kind_str(node.kind), key], |row| {
                row.get::<_, String>(0)
            })
            .optional()?,
        None => None,
    };
    let id = match existing {
        Some(id) => {
            tx.prepare_cached(
                "UPDATE nodes SET title = ?2, body = ?3, state = 'fresh', stale_reason = NULL, \
                 stale_since_ms = NULL, superseded_by = NULL, provenance = ?4, \
                 session_id = ?5, updated_ms = ?6, expires_ms = ?7, embedding = ?8, \
                 embed_model = ?9 WHERE id = ?1",
            )?
            .execute(params![
                id,
                node.title,
                node.body,
                provenance,
                session,
                now,
                node.expires_at_ms,
                embedding,
                model
            ])?;
            tx.prepare_cached("DELETE FROM node_files WHERE node_id = ?1")?
                .execute([&id])?;
            id
        }
        None => {
            let id = uuid::Uuid::now_v7().to_string();
            tx.prepare_cached(
                "INSERT INTO nodes (id, kind, key, title, body, provenance, session_id, \
                 created_ms, updated_ms, expires_ms, embedding, embed_model) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10, ?11)",
            )?
            .execute(params![
                id,
                kind_str(node.kind),
                node.key,
                node.title,
                node.body,
                provenance,
                session,
                now,
                node.expires_at_ms,
                embedding,
                model
            ])?;
            id
        }
    };
    // A path listed twice keeps its last hash.
    let files: BTreeMap<&str, Option<&str>> = node
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.hash.as_deref()))
        .collect();
    let mut insert =
        tx.prepare_cached("INSERT INTO node_files (node_id, path, hash) VALUES (?1, ?2, ?3)")?;
    for (path, hash) in files {
        insert.execute(params![id, path, hash])?;
    }
    changes.push(match embedding {
        Some(blob) => Change::Set {
            id: id.clone(),
            kind: node.kind,
            superseded: false,
            blob,
        },
        None => Change::Remove(id.clone()),
    });
    Ok(id)
}

pub(crate) fn link(tx: &Transaction, edges: &[NewEdge]) -> Result<()> {
    let mut insert = tx
        .prepare_cached("INSERT OR IGNORE INTO edges (from_id, to_id, kind) VALUES (?1, ?2, ?3)")?;
    for edge in edges {
        let from = db::resolve(tx, &edge.from)?;
        let to = db::resolve(tx, &edge.to)?;
        if from == to {
            return Err(Error::Invalid(format!(
                "a node can't link to itself ({from})"
            )));
        }
        insert.execute(params![from, to, edge_kind_str(edge.kind)])?;
    }
    Ok(())
}

/// Replaces the structural edges (`contains`, `dependsOn`) from each of `sources` to modules
/// and services with `edges`. Their other edges (a module's file summaries) stay.
pub(crate) fn relink_structure(
    tx: &Transaction,
    sources: &[String],
    edges: &[NewEdge],
) -> Result<()> {
    let mut clear = tx.prepare_cached(
        "DELETE FROM edges WHERE from_id = ?1 AND kind IN (?2, ?3) \
         AND to_id IN (SELECT id FROM nodes WHERE kind IN (?4, ?5))",
    )?;
    for source in sources {
        let from = db::resolve(tx, source)?;
        clear.execute(params![
            from,
            edge_kind_str(crate::EdgeKind::Contains),
            edge_kind_str(crate::EdgeKind::DependsOn),
            kind_str(crate::NodeKind::Module),
            kind_str(crate::NodeKind::Service)
        ])?;
    }
    link(tx, edges)
}

pub(crate) fn supersede(
    tx: &Transaction,
    old: &str,
    new: &str,
    changes: &mut Vec<Change>,
) -> Result<()> {
    let old = db::resolve(tx, old)?;
    let new = db::resolve(tx, new)?;
    if old == new {
        return Err(Error::Invalid(format!("{old} can't supersede itself")));
    }
    // A chain that loops would leave no current version of either.
    let mut next = tx.prepare_cached("SELECT superseded_by FROM nodes WHERE id = ?1")?;
    let (mut at, mut seen) = (new.clone(), std::collections::HashSet::new());
    while let Some(by) = next
        .query_row([&at], |row| row.get::<_, Option<String>>(0))
        .optional()?
        .flatten()
        .filter(|by| seen.insert(by.clone()))
    {
        if by == old {
            return Err(Error::Invalid(format!(
                "{new} is already superseded by {old}, directly or through later versions"
            )));
        }
        at = by;
    }
    tx.prepare_cached(
        "UPDATE nodes SET state = 'superseded', superseded_by = ?2, stale_reason = NULL, \
         stale_since_ms = NULL WHERE id = ?1",
    )?
    .execute(params![old, new])?;
    tx.prepare_cached("INSERT OR IGNORE INTO edges (from_id, to_id, kind) VALUES (?1, ?2, ?3)")?
        .execute(params![
            new,
            old,
            edge_kind_str(crate::EdgeKind::Supersedes)
        ])?;
    changes.push(Change::Superseded {
        id: old,
        superseded: true,
    });
    Ok(())
}

/// Nodes superseded by one about to be deleted are current again.
fn revive(tx: &Transaction, ids: &[String], changes: &mut Vec<Change>) -> Result<()> {
    let mut revive = tx.prepare_cached(
        "UPDATE nodes SET state = 'fresh', superseded_by = NULL WHERE superseded_by = ?1 \
         RETURNING id",
    )?;
    for id in ids {
        let revived = revive
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        changes.extend(revived.into_iter().map(|id| Change::Superseded {
            id,
            superseded: false,
        }));
    }
    Ok(())
}

pub(crate) fn delete(tx: &Transaction, id: &str, changes: &mut Vec<Change>) -> Result<()> {
    let ids = [id.to_owned()];
    revive(tx, &ids, changes)?;
    if tx
        .prepare_cached("DELETE FROM nodes WHERE id = ?1")?
        .execute([id])?
        == 0
    {
        return Err(Error::NotFound(format!("no node has the id {id}")));
    }
    changes.push(Change::Remove(id.to_owned()));
    Ok(())
}

pub(crate) fn forget_session(
    tx: &Transaction,
    session: &str,
    changes: &mut Vec<Change>,
) -> Result<u64> {
    let ids = tx
        .prepare_cached("SELECT id FROM nodes WHERE session_id = ?1")?
        .query_map([session], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    revive(tx, &ids, changes)?;
    tx.prepare_cached("DELETE FROM nodes WHERE session_id = ?1")?
        .execute([session])?;
    tx.prepare_cached("DELETE FROM transcript WHERE conversation_id = ?1")?
        .execute([session])?;
    // A node revived above but deleted too is simply gone.
    changes.extend(ids.iter().cloned().map(Change::Remove));
    Ok(ids.len() as u64)
}

pub(crate) fn forget_origins(
    tx: &Transaction,
    origins: &[String],
    changes: &mut Vec<Change>,
) -> Result<u64> {
    let mut select =
        tx.prepare_cached("SELECT id FROM nodes WHERE json_extract(provenance, '$.origin') = ?1")?;
    let mut ids = Vec::new();
    for origin in origins {
        ids.extend(
            select
                .query_map([origin], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
    }
    revive(tx, &ids, changes)?;
    let mut delete = tx.prepare_cached("DELETE FROM nodes WHERE id = ?1")?;
    for id in &ids {
        delete.execute([id])?;
    }
    // A node revived above but deleted too is simply gone.
    changes.extend(ids.iter().cloned().map(Change::Remove));
    Ok(ids.len() as u64)
}

pub(crate) fn files_changed(
    tx: &Transaction,
    changes: &[FileRef],
    now: i64,
) -> Result<Vec<String>> {
    let mut recorded = tx.prepare_cached(
        "SELECT n.id, f.hash FROM node_files f JOIN nodes n ON n.id = f.node_id \
         WHERE f.path = ?1 AND f.hash IS NOT NULL AND n.state = 'fresh'",
    )?;
    let mut mark = tx.prepare_cached(
        "UPDATE nodes SET state = 'stale', stale_reason = ?2, stale_since_ms = ?3 \
         WHERE id = ?1 AND state = 'fresh'",
    )?;
    let mut stale = Vec::new();
    for change in changes {
        let rows = recorded
            .query_map([&change.path], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let reason = match change.hash {
            Some(_) => format!("{} changed", change.path),
            None => format!("{} was deleted", change.path),
        };
        for (id, hash) in rows {
            if change.hash.as_deref() == Some(hash.as_str()) {
                continue;
            }
            if mark.execute(params![id, reason, now])? > 0 {
                stale.push(id);
            }
        }
    }
    Ok(stale)
}

pub(crate) fn expire(tx: &Transaction, now: i64) -> Result<u64> {
    let expired = tx
        .prepare_cached(
            "UPDATE nodes SET state = 'stale', stale_reason = 'older than its TTL', \
             stale_since_ms = ?1 WHERE expires_ms IS NOT NULL AND expires_ms <= ?1 \
             AND state = 'fresh'",
        )?
        .execute([now])?;
    Ok(expired as u64)
}

/// A node's text as it was read for embedding, and its embedding.
pub(crate) struct Embedded {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) blob: Vec<u8>,
}

/// Stores embeddings; a node whose text changed since it was read keeps what its own write
/// gave it. Returns how many were stored.
pub(crate) fn set_embeddings(
    tx: &Transaction,
    embedded: Vec<Embedded>,
    changes: &mut Vec<Change>,
) -> Result<u32> {
    let mut update = tx.prepare_cached(
        "UPDATE nodes SET embedding = ?4, embed_model = ?5 \
         WHERE id = ?1 AND title = ?2 AND body = ?3 \
         RETURNING kind, state = 'superseded'",
    )?;
    let mut stored = 0;
    for node in embedded {
        let updated = update
            .query_row(
                params![node.id, node.title, node.body, node.blob, embed::MODEL_ID],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        let Some((kind, superseded)) = updated else {
            continue;
        };
        stored += 1;
        if let Some(kind) = db::parse_kind(&kind) {
            changes.push(Change::Set {
                id: node.id,
                kind,
                superseded,
                blob: node.blob,
            });
        }
    }
    Ok(stored)
}
