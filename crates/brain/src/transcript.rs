//! The full-transcript index: every conversation's lines, searchable by FTS5, so a reborn
//! orchestrator can find what was said before its briefing.

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::{Result, TranscriptEntry, TranscriptHit, retrieve};

/// About how much of an entry a hit shows, around its first match.
const SNIPPET_BYTES: usize = 600;
/// Marks a match in `highlight()` output; control characters never occur in the text
/// tokens, so they can't be confused with it.
const OPEN: char = '\u{2}';
const CLOSE: char = '\u{3}';

pub(crate) fn index(tx: &Transaction, entries: &[TranscriptEntry]) -> Result<()> {
    let mut insert = tx.prepare_cached(
        "INSERT OR IGNORE INTO transcript (conversation_id, seq, role, request_id, at_ms, text) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for entry in entries {
        insert.execute(params![
            entry.conversation_id,
            entry.seq,
            entry.role,
            entry.request_id,
            entry.at_ms,
            entry.text
        ])?;
    }
    Ok(())
}

pub(crate) fn forget(tx: &Transaction, conversation_id: &str) -> Result<()> {
    tx.prepare_cached("DELETE FROM transcript WHERE conversation_id = ?1")?
        .execute([conversation_id])?;
    Ok(())
}

pub(crate) fn watermark(conn: &Connection, conversation_id: &str) -> Result<Option<i64>> {
    Ok(conn
        .prepare_cached("SELECT MAX(seq) FROM transcript WHERE conversation_id = ?1")?
        .query_row([conversation_id], |row| row.get::<_, Option<i64>>(0))
        .optional()?
        .flatten())
}

pub(crate) fn search(
    conn: &Connection,
    conversation_id: &str,
    query: &str,
    limit: u32,
) -> Result<Vec<TranscriptHit>> {
    let Some(expression) = retrieve::fts_expression(query) else {
        return Ok(Vec::new());
    };
    let mut statement = conn.prepare_cached(
        "SELECT t.seq, t.role, t.request_id, t.at_ms, \
                highlight(transcript_fts, 0, char(2), char(3)) \
         FROM transcript_fts JOIN transcript t ON t.rid = transcript_fts.rowid \
         WHERE transcript_fts MATCH ?1 AND t.conversation_id = ?2 \
         ORDER BY bm25(transcript_fts), t.at_ms DESC LIMIT ?3",
    )?;
    let rows = statement.query_map(
        params![expression, conversation_id, limit.clamp(1, 100)],
        |row| {
            let marked: String = row.get(4)?;
            Ok(TranscriptHit {
                seq: row.get(0)?,
                role: row.get(1)?,
                request_id: row.get(2)?,
                at_ms: row.get(3)?,
                snippet: snippet(&marked),
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// About [`SNIPPET_BYTES`] of `marked` (text with its matches between [`OPEN`] and
/// [`CLOSE`]) around the first match, cut at word boundaries, without the marks.
fn snippet(marked: &str) -> String {
    let text: String = marked.chars().filter(|c| !is_mark(*c)).collect();
    // Where the first match starts in `text`: the marks before it are one byte each.
    let first = marked.find(OPEN).map_or(0, |at| {
        at - marked[..at].chars().filter(|c| is_mark(*c)).count()
    });
    if text.len() <= SNIPPET_BYTES {
        return text;
    }
    // A third of the room before the match, the rest after it.
    let start = first.saturating_sub(SNIPPET_BYTES / 3);
    let end = (start + SNIPPET_BYTES).min(text.len());
    let start = end.saturating_sub(SNIPPET_BYTES).min(start);
    let mut start = floor_char(&text, start);
    let mut end = floor_char(&text, end);
    if start > 0
        && let Some(space) = text[start..first.max(start)].find(char::is_whitespace)
    {
        start += space + 1;
    }
    if end < text.len()
        && let Some(space) = text[first.min(end)..end].rfind(char::is_whitespace)
    {
        end = first.min(end) + space;
    }
    let mut out = String::with_capacity(end - start + 8);
    if start > 0 {
        out.push('…');
    }
    out.push_str(text[start..end].trim());
    if end < text.len() {
        out.push('…');
    }
    out
}

fn is_mark(c: char) -> bool {
    c == OPEN || c == CLOSE
}

fn floor_char(text: &str, mut index: usize) -> usize {
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}
