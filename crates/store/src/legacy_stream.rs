//! Repair the old Claude split-block projection using its recorded provider envelopes.
//! Raw evidence and completed items remain intact; never deduplicate ordinary prose.
use crate::Result;
use brigadier_core::event::{Envelope, Event, ItemKind};
use rusqlite::Connection;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::Path,
};

pub(crate) fn repair(conn: &Connection, root: &Path) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT session_id FROM chat_items WHERE id LIKE session_id || ':stream:%'",
    )?;
    let sessions = statement
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for session in sessions {
        let key = format!("split-stream-repair-v1:{session}");
        let done: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM meta WHERE key=?1)",
            [&key],
            |r| r.get(0),
        )?;
        if done {
            continue;
        }
        // Rotated/missing logs are deliberately left alone: content equality is not proof.
        let file = match std::fs::File::open(root.join("raw").join(format!("{session}.ndjson"))) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let mut pending: HashMap<String, (String, ItemKind, String, u64)> = HashMap::new();
        let mut generations: HashMap<String, String> = HashMap::new();
        let mut removed = 0;
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { break };
            let Ok(env) = serde_json::from_str::<Envelope>(&line) else {
                continue;
            };
            if env.session_id.as_str() != session {
                continue;
            }
            match env.event {
                Event::TurnStarted { .. } | Event::SessionStarted { .. } => {
                    pending.clear();
                    generations.clear();
                }
                Event::ItemStarted {
                    item_id,
                    kind,
                    parent_item_id,
                    ..
                } => {
                    let id = item_id.as_str();
                    let prefix = format!("{session}:stream:");
                    // Legacy IDs omit the start sequence. New IDs must never enter this repair.
                    if id
                        .strip_prefix(&prefix)
                        .is_some_and(|tail| tail.split(':').count() == 3)
                        && matches!(kind, ItemKind::AssistantText | ItemKind::Thinking)
                    {
                        let parent = parent_item_id.map(|i| i.to_string()).unwrap_or_default();
                        let generation = id
                            .strip_prefix(&prefix)
                            .unwrap()
                            .split(':')
                            .next()
                            .unwrap()
                            .to_owned();
                        if generations
                            .get(&parent)
                            .is_some_and(|old| old != &generation)
                        {
                            pending.retain(|_, (p, _, _, _)| p != &parent);
                        }
                        generations.insert(parent.clone(), generation);
                        pending.insert(id.into(), (parent, kind, String::new(), env.seq));
                    }
                }
                Event::ContentDelta { item_id, text } => {
                    if let Some((_, _, body, seq)) = pending.get_mut(item_id.as_str()) {
                        if body.len() + text.len() <= 128 * 1024 {
                            body.push_str(&text);
                        }
                        *seq = env.seq;
                    }
                }
                Event::ItemCompleted {
                    item_id,
                    kind,
                    parent_item_id,
                    ..
                } => {
                    // A correctly correlated completion owns its stream ID. It must never
                    // be mistaken for an orphan's completion merely because text repeats.
                    if pending.remove(item_id.as_str()).is_some() {
                        continue;
                    }

                    let Some(raw) = env
                        .raw
                        .as_deref()
                        .and_then(|r| serde_json::from_str::<serde_json::Value>(r).ok())
                    else {
                        continue;
                    };
                    if raw["type"] != "assistant" {
                        continue;
                    }
                    let parent = parent_item_id.map(|i| i.to_string()).unwrap_or_default();
                    let Some((candidate, (_, _, body, seq))) = pending
                        .iter()
                        .filter(|(_, (p, k, _, _))| p == &parent && k == &kind)
                        .min_by_key(|(_, (_, _, _, seq))| *seq)
                        .map(|(id, v)| (id.clone(), v.clone()))
                    else {
                        continue;
                    };
                    pending.remove(&candidate);
                    if candidate == item_id.as_str()
                        || body.is_empty()
                        || env.body.as_deref() != Some(&body)
                    {
                        continue;
                    }
                    // Delete only the exact orphan projection, and only when the authoritative
                    // completed row is present unchanged. Rewinds and later edits win.
                    removed += conn.execute("DELETE FROM chat_items WHERE session_id=?1 AND id=?2 AND seq=?3 AND body=?4 AND EXISTS(SELECT 1 FROM chat_items AS final WHERE final.session_id=?1 AND final.id=?5 AND final.seq=?6 AND final.body=?4)", (&session,&candidate,seq,&body,item_id.as_str(),env.seq))?;
                }
                _ => {}
            }
        }
        conn.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES (?1,'complete')",
            [key],
        )?;
        if removed > 0 {
            tracing::info!(%session,removed,"repaired legacy split-stream projection; raw history retained");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn later_identical_stream_completion_cannot_consume_an_earlier_orphan() {
        for second in ["s:stream:1::2", "s:stream:2::1"] {
            let dir = tempfile::tempdir().unwrap();
            let conn = crate::schema::open_connection(&dir.path().join("test.sqlite")).unwrap();
            conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
            let first = "s:stream:1::1";
            let mut frames = Vec::new();
            for (seq, id, typ) in [
                (1, first, "item-started"),
                (2, first, "content-delta"),
                (3, second, "item-started"),
                (4, second, "content-delta"),
                (5, second, "item-completed"),
            ] {
                let event = if typ == "content-delta" {
                    serde_json::json!({"type":typ,"item_id":id,"text":"repeat"})
                } else {
                    serde_json::json!({"type":typ,"item_id":id,"kind":{"type":"assistant-text"},"summary":"repeat","parent_item_id":null})
                };
                frames.push(serde_json::json!({"seq":seq,"at":1,"instance_id":"claude-code:default","session_id":"s","event":event,"body":"repeat","raw":"{\"type\":\"assistant\"}"}).to_string());
            }
            std::fs::create_dir(dir.path().join("raw")).unwrap();
            std::fs::write(dir.path().join("raw/s.ndjson"), frames.join("\n")).unwrap();
            for (id, seq) in [(first, 2), (second, 5)] {
                conn.execute("INSERT INTO chat_items(session_id,id,seq,at,kind,body) VALUES ('s',?1,?2,1,'{}','repeat')",(id,seq)).unwrap();
            }
            repair(&conn, dir.path()).unwrap();
            assert_eq!(
                conn.query_row("SELECT count(*) FROM chat_items", [], |r| r
                    .get::<_, u64>(0))
                    .unwrap(),
                2
            );
        }
    }

    #[test]
    fn repairs_only_proven_stream_duplicates_and_keeps_legitimate_repetition() {
        let dir = tempfile::tempdir().unwrap();
        let conn = crate::schema::open_connection(&dir.path().join("test.sqlite")).unwrap();
        // Projection repair does not touch events/turns; use a minimal projection table here.
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        let stream = "s:stream:1::1";
        let mut frames = Vec::new();
        for (seq, event, body, raw) in [
            (
                1,
                serde_json::json!({"type":"item-started","item_id":stream,"kind":{"type":"assistant-text"},"summary":"","parent_item_id":null}),
                None,
                None,
            ),
            (
                2,
                serde_json::json!({"type":"content-delta","item_id":stream,"text":"hello"}),
                None,
                None,
            ),
            (
                4,
                serde_json::json!({"type":"item-completed","item_id":"final:0","kind":{"type":"assistant-text"},"summary":"hello","parent_item_id":null}),
                Some("hello"),
                Some(r#"{"type":"assistant","uuid":"final"}"#),
            ),
        ] {
            frames.push(serde_json::json!({"seq":seq,"at":1,"instance_id":"claude-code:default","session_id":"s","event":event,"body":body,"raw":raw}).to_string());
        }
        std::fs::create_dir(dir.path().join("raw")).unwrap();
        std::fs::write(dir.path().join("raw/s.ndjson"), frames.join("\n")).unwrap();
        for (id, seq) in [
            (stream, 2),
            ("final:0", 4),
            ("legitimate:0", 6),
            ("s:stream:0:1::1", 8),
        ] {
            conn.execute("INSERT INTO chat_items(session_id,id,seq,at,kind,body) VALUES ('s',?1,?2,1,'{\"type\":\"assistant-text\"}','hello')",(id,seq)).unwrap();
        }
        repair(&conn, dir.path()).unwrap();
        let count: u64 = conn
            .query_row("SELECT count(*) FROM chat_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3);
        repair(&conn, dir.path()).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM chat_items", [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            3
        );
    }
}
