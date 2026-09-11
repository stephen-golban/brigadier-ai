//! Bounded display projection, separate from the fixed-height activity feed.
use crate::Result;
use brigadier_core::event::{bounded, Envelope, Event, ItemKind, NoticeLevel};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Recorded lifecycle boundaries, independent of message delivery and the telemetry ring.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatTurn {
    /// Harness turn identity.
    pub id: String,
    /// Sequence of the start event.
    pub start_seq: u64,
    /// Sequence of the terminal event, absent while open.
    pub end_seq: Option<u64>,
    /// Start wall clock in milliseconds.
    pub started_at: i64,
    /// Terminal wall clock in milliseconds, absent while open.
    pub ended_at: Option<i64>,
    /// Recorded lifecycle outcome, independent of individual tool failures.
    pub status: String,
}

pub(crate) fn write_turn(conn: &Connection, env: &Envelope) -> Result<()> {
    use brigadier_core::event::{AbortReason, ExitReason, StopReason};
    let session = env.session_id.as_str();
    let at = crate::schema::to_millis(env.at);
    if let Event::TurnStarted { turn_id } = &env.event {
        conn.execute("INSERT OR IGNORE INTO chat_turns(session_id,id,start_seq,started_at,status) VALUES (?1,?2,?3,?4,'running')",
            (session, turn_id.as_str(), env.seq, at))?;
    } else {
        let (id, status) = match &env.event {
            Event::TurnCompleted {
                turn_id,
                stop_reason,
                ..
            } => (
                Some(turn_id.as_str()),
                match stop_reason {
                    StopReason::EndTurn => "completed",
                    StopReason::Error(_) => "failed",
                    _ => "stopped",
                },
            ),
            Event::TurnAborted { turn_id, reason } => (
                Some(turn_id.as_str()),
                match reason {
                    AbortReason::Error(_) => "failed",
                    _ => "interrupted",
                },
            ),
            Event::SessionExited { reason, .. } => (
                None,
                match reason {
                    ExitReason::Crashed | ExitReason::Error(_) => "failed",
                    _ => "interrupted",
                },
            ),
            _ => return Ok(()),
        };
        // Replays cannot overwrite a recorded terminal outcome; a process exit closes
        // only open turns. A missing start never fabricates a duration.
        conn.execute("UPDATE chat_turns SET end_seq=?3,ended_at=?4,status=?5 WHERE session_id=?1 AND (?2 IS NULL OR id=?2) AND end_seq IS NULL AND start_seq<=?3",
            (session, id, env.seq, at, status))?;
    }
    Ok(())
}

pub(crate) fn read_turns(conn: &Connection, session: &str) -> Result<Vec<ChatTurn>> {
    let mut statement = conn.prepare_cached("SELECT id,start_seq,end_seq,started_at,ended_at,status FROM chat_turns WHERE session_id=?1 ORDER BY start_seq DESC LIMIT 2000")?;
    let rows = statement.query_map([session], |r| {
        Ok(ChatTurn {
            id: r.get(0)?,
            start_seq: r.get(1)?,
            end_seq: r.get(2)?,
            started_at: r.get(3)?,
            ended_at: r.get(4)?,
            status: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Lifecycle spans overlapping the mounted history window, regardless of their age.
pub(crate) fn read_turns_in_range(
    conn: &Connection,
    session: &str,
    start: u64,
    end: u64,
) -> Result<Vec<ChatTurn>> {
    let mut statement = conn.prepare_cached("SELECT id,start_seq,end_seq,started_at,ended_at,status FROM chat_turns WHERE session_id=?1 AND start_seq<=?3 AND (end_seq IS NULL OR end_seq>=?2) ORDER BY start_seq DESC LIMIT 600")?;
    let rows = statement.query_map(
        (
            session,
            start.min(i64::MAX as u64) as i64,
            end.min(i64::MAX as u64) as i64,
        ),
        |row| {
            Ok(ChatTurn {
                id: row.get(0)?,
                start_seq: row.get(1)?,
                end_seq: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                status: row.get(5)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// A completed provider item. Kind is structured, never inferred from display text.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatItem {
    /// Owning session.
    pub session_id: String,
    /// Stable provider item identity.
    pub id: String,
    /// Last update cursor.
    pub seq: u64,
    /// Wall clock milliseconds.
    pub at: i64,
    /// Typed renderer discriminator, including tool correlation.
    pub kind: ItemKind,
    /// Display body; at most 128 KiB, visibly truncated beyond that.
    pub body: String,
    /// Parent tool for nested agent work.
    pub parent_id: Option<String>,
    /// Host-supplied native UUID, absent on legacy history and synthetic messages.
    #[serde(default)]
    pub provider_uuid: Option<String>,
}

/// A lifecycle event's synthetic [`ChatItem`], or `None` when the event is not one.
///
/// **The id is deterministic** — `"{session}:notice:{code}:{seq}"` — so a replay of the same
/// envelope upserts the same row rather than appending a second one. The seq is in the id on
/// purpose: two warnings in one session are two notices, and only their seq tells them apart.
///
/// `session-started` deliberately gets no notice: `system/init` is re-emitted at the start of
/// **every turn** on the same `session_id` (landmine 2), so a row per init would be a row per turn.
// see docs/plans/codex-thread-rebuild-2026-09-11.md §4.4 for the table this implements.
fn notice(env: &Envelope) -> Option<(String, ItemKind, String)> {
    let session = env.session_id.as_str();
    let seq = env.seq;
    match &env.event {
        Event::SessionCompacted {
            trigger,
            pre_tokens,
            post_tokens,
            cumulative_dropped_tokens,
            duration_ms,
        } => {
            let trigger = match trigger {
                brigadier_core::event::CompactTrigger::Manual => "manual",
                brigadier_core::event::CompactTrigger::Auto => "auto",
            };
            // One object, keys present only where the provider reported a number, and `None`
            // when it reported none at all — so a renderer can test for a key rather than for a
            // sentinel, and `{"pre_tokens":n}` from before 2026-09-11 still parses.
            let mut detail = serde_json::Map::new();
            for (key, value) in [
                ("pre_tokens", pre_tokens),
                ("post_tokens", post_tokens),
                ("cumulative_dropped_tokens", cumulative_dropped_tokens),
                ("duration_ms", duration_ms),
            ] {
                if let Some(n) = value {
                    detail.insert(key.to_owned(), serde_json::json!(n));
                }
            }
            Some((
                format!("{session}:notice:compacted:{seq}"),
                ItemKind::Notice {
                    level: NoticeLevel::Info,
                    code: "compacted".to_owned(),
                    detail: (!detail.is_empty()).then_some(serde_json::Value::Object(detail)),
                },
                trigger.to_owned(),
            ))
        }
        // A **warning**, not an error: the session continues and the CLI retries on a later
        // turn, so nothing stopped and nothing was lost — but it is no longer silent.
        //
        // The body is a sentence rather than the discriminator the two older notices carry,
        // because `ThreadView::noticeSentence` falls back to the body verbatim for a code it
        // does not know, and `too_few_groups` alone is not a sentence.
        Event::SessionCompactFailed { error } => Some((
            format!("{session}:notice:compact-failed:{seq}"),
            ItemKind::Notice {
                level: NoticeLevel::Warning,
                code: "compact-failed".to_owned(),
                detail: error
                    .as_ref()
                    .map(|reason| serde_json::json!({ "error": reason })),
            },
            match error {
                Some(reason) => format!("Context compaction failed: {reason}"),
                None => "Context compaction failed".to_owned(),
            },
        )),
        Event::RuntimeWarning { message } => Some((
            format!("{session}:notice:warning:{seq}"),
            ItemKind::Notice {
                level: NoticeLevel::Warning,
                code: "runtime".to_owned(),
                detail: None,
            },
            message.clone(),
        )),
        Event::RuntimeError { message, fatal } => Some((
            format!("{session}:notice:error:{seq}"),
            ItemKind::Notice {
                level: if *fatal {
                    NoticeLevel::Fatal
                } else {
                    NoticeLevel::Error
                },
                code: "runtime".to_owned(),
                detail: None,
            },
            message.clone(),
        )),
        Event::SessionExited { reason, exit_code } => Some((
            format!("{session}:notice:exited:{seq}"),
            ItemKind::Notice {
                level: NoticeLevel::Info,
                code: "exited".to_owned(),
                detail: exit_code.map(|c| serde_json::json!({ "exit_code": c })),
            },
            exit_text(reason),
        )),
        _ => None,
    }
}

/// One word for why a session ended, for a notice body.
fn exit_text(reason: &brigadier_core::event::ExitReason) -> String {
    use brigadier_core::event::ExitReason;
    match reason {
        ExitReason::Graceful => "graceful".to_owned(),
        ExitReason::Killed => "killed".to_owned(),
        ExitReason::Crashed => "crashed".to_owned(),
        ExitReason::Error(e) => format!("error: {e}"),
    }
}

/// Only completed items have authoritative content in the current Claude adapter.
pub fn project(env: &Envelope) -> Option<ChatItem> {
    if let Some((id, kind, body)) = notice(env) {
        return Some(ChatItem {
            session_id: env.session_id.to_string(),
            id,
            seq: env.seq,
            at: crate::schema::to_millis(env.at),
            kind,
            body: bounded(&body, 128 * 1024),
            parent_id: None,
            // Synthesised here, not by the provider: there is no provider frame to take a uuid
            // from, and `provider_uuid` is documented as absent on synthetic messages.
            provider_uuid: None,
        });
    }
    let (item_id, kind, summary, parent_item_id) = match &env.event {
        Event::ItemStarted {
            item_id,
            kind,
            summary,
            parent_item_id,
        }
        | Event::ItemUpdated {
            item_id,
            kind,
            summary,
            parent_item_id,
        }
        | Event::ItemCompleted {
            item_id,
            kind,
            summary,
            parent_item_id,
        } => (item_id, kind, summary, parent_item_id),
        _ => return None,
    };
    Some(ChatItem {
        provider_uuid: env
            .raw
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("user"))
            .and_then(|v| v.get("uuid").and_then(|u| u.as_str()).map(str::to_owned)),
        session_id: env.session_id.to_string(),
        id: item_id.to_string(),
        seq: env.seq,
        at: crate::schema::to_millis(env.at),
        kind: kind.clone(),
        body: bounded(env.body.as_deref().unwrap_or(summary), 128 * 1024),
        parent_id: parent_item_id.as_ref().map(ToString::to_string),
    })
}

pub(crate) fn write(conn: &Connection, item: &ChatItem) -> Result<()> {
    // Late queued projection writes from the discarded native range must never resurrect it.
    let rewind: Option<String> = conn.query_row(
        "SELECT id FROM chat_rewinds WHERE session_id=?1 AND state='applied' AND ?2 BETWEEN target_seq AND through_seq LIMIT 1",
        (&item.session_id, item.seq), |r| r.get(0)).optional()?;
    if let Some(id) = rewind {
        conn.execute(
            "INSERT INTO chat_archive(rewind_id,session_id,item_json) VALUES (?1,?2,?3)",
            (
                id,
                &item.session_id,
                serde_json::to_string(item).expect("chat item"),
            ),
        )?;
        return Ok(());
    }
    conn.execute("INSERT INTO chat_items(session_id,id,seq,at,kind,body,parent_id,provider_uuid) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(session_id,id) DO UPDATE SET seq=excluded.seq,kind=excluded.kind,body=excluded.body,parent_id=excluded.parent_id,provider_uuid=excluded.provider_uuid
        WHERE excluded.seq > chat_items.seq",
        (&item.session_id, &item.id, item.seq as i64, item.at, serde_json::to_string(&item.kind).expect("item kind"), bounded(&item.body, 128 * 1024), &item.parent_id, &item.provider_uuid))?;
    Ok(())
}

pub(crate) fn append_delta(conn: &Connection, env: &Envelope) -> Result<()> {
    let Event::ContentDelta { item_id, text } = &env.event else {
        return Ok(());
    };
    let existing: Option<(String,u64)> = conn.query_row("SELECT body,seq FROM chat_items WHERE session_id=?1 AND id=?2 AND seq<?3 AND NOT EXISTS(SELECT 1 FROM chat_rewinds WHERE session_id=?1 AND state='applied' AND ?3 BETWEEN target_seq AND through_seq)", (env.session_id.as_str(),item_id.as_str(),env.seq), |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((body, _)) = existing {
        let next = bounded(&format!("{body}{text}"), 128 * 1024);
        conn.execute(
            "UPDATE chat_items SET body=?4,seq=?3 WHERE session_id=?1 AND id=?2",
            (env.session_id.as_str(), item_id.as_str(), env.seq, next),
        )?;
        conn.execute(
            "UPDATE sessions SET last_event_seq=MAX(last_event_seq,?2) WHERE id=?1",
            (env.session_id.as_str(), env.seq),
        )?;
    }
    Ok(())
}

pub(crate) fn read(conn: &Connection, session_id: &str, after: u64) -> Result<Vec<ChatItem>> {
    read_page(conn, session_id, after, false)
}

pub(crate) fn recent(
    conn: &Connection,
    session_id: &str,
    after: Option<u64>,
) -> Result<Vec<ChatItem>> {
    let mut items = read_page(conn, session_id, after.unwrap_or(0), after.is_none())?;
    if after.is_none() {
        items.reverse();
    }
    Ok(items)
}

fn read_page(
    conn: &Connection,
    session_id: &str,
    after: u64,
    newest: bool,
) -> Result<Vec<ChatItem>> {
    let sql = if newest {
        "SELECT id,seq,at,kind,body,parent_id,provider_uuid FROM chat_items WHERE session_id=?1 AND seq>?2 ORDER BY seq DESC LIMIT 20"
    } else {
        "SELECT id,seq,at,kind,body,parent_id,provider_uuid FROM chat_items WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT 20"
    };
    let mut statement = conn.prepare_cached(sql)?;
    let rows = statement.query_map((session_id, after as i64), |row| {
        let kind: String = row.get(3)?;
        Ok(ChatItem {
            session_id: session_id.to_owned(),
            id: row.get(0)?,
            seq: row.get::<_, i64>(1)? as u64,
            at: row.get(2)?,
            kind: serde_json::from_str(&kind).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?,
            body: row.get(4)?,
            parent_id: row.get(5)?,
            provider_uuid: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Latest page, a backwards page, or incremental updates after an acknowledged cursor.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    /// Ascending display order; item IDs are stable across updates.
    pub items: Vec<ChatItem>,
    /// Last returned sequence for incremental paging.
    pub next_after: u64,
    /// Oldest returned sequence for backwards paging.
    pub next_before: Option<u64>,
    /// Another page exists in the requested direction.
    pub has_more: bool,
}
pub(crate) fn history_page(
    conn: &Connection,
    session: &str,
    before: Option<u64>,
    after: Option<u64>,
    limit: usize,
) -> Result<HistoryPage> {
    let limit = limit.clamp(1, 100);
    let forward = after.is_some();
    let sql = if forward {
        "SELECT id,seq,at,kind,body,parent_id,provider_uuid FROM chat_items WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3"
    } else {
        "SELECT id,seq,at,kind,body,parent_id,provider_uuid FROM chat_items WHERE session_id=?1 AND seq<?2 ORDER BY seq DESC LIMIT ?3"
    };
    let cursor = if forward {
        after.unwrap_or(0).min(i64::MAX as u64)
    } else {
        before.unwrap_or(i64::MAX as u64).min(i64::MAX as u64)
    };
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map((session, cursor as i64, (limit + 1) as i64), |r| {
        let kind: String = r.get(3)?;
        Ok(ChatItem {
            session_id: session.into(),
            id: r.get(0)?,
            seq: r.get(1)?,
            at: r.get(2)?,
            kind: serde_json::from_str(&kind).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?,
            body: r.get(4)?,
            parent_id: r.get(5)?,
            provider_uuid: r.get(6)?,
        })
    })?;
    let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = items.len() > limit;
    items.truncate(limit);
    if !forward {
        items.reverse();
    }
    Ok(HistoryPage {
        next_after: items.last().map_or(after.unwrap_or(0), |i| i.seq),
        next_before: items.first().map(|i| i.seq),
        items,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_paging_retention_and_cascade() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE sessions(session_id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('s'); CREATE TABLE chat_items(session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,id TEXT,seq INTEGER,at INTEGER,kind TEXT,body TEXT,parent_id TEXT,provider_uuid TEXT,PRIMARY KEY(session_id,id));").unwrap();
        conn.execute_batch("CREATE TABLE chat_rewinds(id TEXT,session_id TEXT,target_seq INTEGER,through_seq INTEGER,state TEXT); CREATE TABLE chat_archive(rewind_id TEXT,session_id TEXT,item_json TEXT);").unwrap();
        let mut item = ChatItem {
            session_id: "s".into(),
            id: "i".into(),
            seq: 1,
            at: 5,
            kind: ItemKind::AssistantText,
            body: "Full body".into(),
            parent_id: None,
            provider_uuid: None,
        };
        write(&conn, &item).unwrap();
        item.body = "stale replay".into();
        write(&conn, &item).unwrap();
        assert_eq!(read(&conn, "s", 0).unwrap()[0].body, "Full body");
        item.seq = 2;
        item.body = "é".repeat(100_000);
        write(&conn, &item).unwrap();
        let body = &read(&conn, "s", 1).unwrap()[0].body;
        assert!(body.len() <= 128 * 1024);
        assert!(body.ends_with('…'));
        assert!(read(&conn, "s", 2).unwrap().is_empty());
        for seq in 3..2005 {
            item.seq = seq;
            item.id = format!("i{seq}");
            item.body = "body".into();
            write(&conn, &item).unwrap();
        }
        assert_eq!(
            conn.query_row("SELECT count(*) FROM chat_items", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2003
        );
        let page = read(&conn, "s", 0).unwrap();
        assert_eq!(page.len(), 20);
        assert_eq!(page[0].seq, 2);
        let tail = recent(&conn, "s", None).unwrap();
        assert_eq!(tail.len(), 20);
        assert_eq!(tail.first().unwrap().seq, 1985);
        assert_eq!(tail.last().unwrap().seq, 2004);
        assert!(recent(&conn, "s", Some(2004)).unwrap().is_empty());
        assert_eq!(
            recent(&conn, "s", Some(1999))
                .unwrap()
                .iter()
                .map(|i| i.seq)
                .collect::<Vec<_>>(),
            vec![2000, 2001, 2002, 2003, 2004]
        );
        conn.execute("DELETE FROM sessions", []).unwrap();
        assert!(read(&conn, "s", 0).unwrap().is_empty());
    }
}
