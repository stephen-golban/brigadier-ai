//! The text a query answers with: each hit as a header, a warning when it is stale, its body
//! and where it came from, best first, within a byte budget.

use std::fmt::Write as _;

use crate::{BrainHit, Node, NodeKind, NodeState, Origin, Provenance};

/// About four bytes per token.
pub(crate) const BYTES_PER_TOKEN: usize = 4;
/// One body never takes more than this, so a long report can't crowd out the rest.
const MAX_BODY: usize = 1_600;
/// A hit is left out rather than shown with less body than this.
const MIN_BODY: usize = 120;

pub(crate) fn answer(hits: &[BrainHit], budget: usize) -> String {
    if hits.is_empty() {
        return "Nothing in the Brain matches.".into();
    }
    let mut out = String::new();
    for hit in hits {
        let node = &hit.node;
        let mut head = header(node);
        head.push('\n');
        let tail = format!("{}\n", provenance(&node.provenance));
        let separator = if out.is_empty() { 0 } else { 1 };
        let fixed = separator + head.len() + tail.len();
        let room = budget.saturating_sub(out.len() + fixed);
        let body = node.body.trim();
        if room < MIN_BODY.min(body.len()) {
            if out.is_empty() {
                // The best hit shows at least its header, whatever the budget.
                out.push_str(&head);
            }
            break;
        }
        if separator == 1 {
            out.push('\n');
        }
        out.push_str(&head);
        if !body.is_empty() {
            out.push_str(&cut(body, room.min(MAX_BODY)));
            out.push('\n');
        }
        out.push_str(&tail);
    }
    out.truncate(out.trim_end().len());
    out
}

fn kind_label(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Module => "module",
        NodeKind::Service => "service",
        NodeKind::FileSummary => "file summary",
        NodeKind::Decision => "decision",
        NodeKind::Convention => "convention",
        NodeKind::Preference => "preference",
        NodeKind::Task => "task",
        NodeKind::Report => "report",
        NodeKind::Research => "research",
        NodeKind::Contract => "contract",
    }
}

/// `[decision <id> · fresh] Title`, plus a warning line for a stale node.
fn header(node: &Node) -> String {
    let state = match &node.state {
        NodeState::Fresh => "fresh",
        NodeState::Stale { .. } => "stale",
        NodeState::Superseded { .. } => "superseded",
    };
    let mut out = format!(
        "[{} {} · {}] {}",
        kind_label(node.kind),
        node.id,
        state,
        node.title.trim()
    );
    if let NodeState::Stale { reason, .. } = &node.state {
        let _ = write!(out, "\nSTALE: {reason} — re-check before relying on it");
    }
    out
}

/// `— from report task-7 (codex gpt-…), session …, commit abc1234, 2026-09-28`.
fn provenance(provenance: &Provenance) -> String {
    let mut out = String::from("— from ");
    out.push_str(match provenance.origin {
        Origin::Index => "the code index",
        Origin::Skeleton => "the skeleton pass",
        Origin::Enrichment => "enrichment",
        Origin::Report => "report",
        Origin::Orchestrator => "the orchestrator",
        Origin::User => "the user",
    });
    if let Some(task) = &provenance.task_id {
        let _ = write!(out, " {task}");
    }
    if let Some(worker) = &provenance.worker {
        match &worker.model {
            Some(model) => {
                let _ = write!(out, " ({} {model})", worker.provider);
            }
            None => {
                let _ = write!(out, " ({})", worker.provider);
            }
        }
    }
    if let Some(session) = &provenance.session_id {
        let _ = write!(out, ", session {session}");
    }
    if let Some(commit) = &provenance.commit {
        let short: String = commit.chars().take(7).collect();
        let _ = write!(out, ", commit {short}");
    }
    let _ = write!(out, ", {}", date(provenance.recorded_at_ms));
    out
}

/// `text` within `max` bytes, cut at the end of a sentence if one ends in the second half,
/// else at a word, with an ellipsis.
fn cut(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max.saturating_sub('…'.len_utf8());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let head = &text[..end];
    let sentence = head
        .char_indices()
        .filter(|(at, c)| {
            matches!(c, '.' | '!' | '?' | '\n')
                && head[at + c.len_utf8()..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
        })
        .map(|(at, c)| at + c.len_utf8())
        .next_back();
    if let Some(at) = sentence.filter(|at| *at >= end / 2) {
        return head[..at].trim_end().to_owned();
    }
    let word = head.rfind(char::is_whitespace).filter(|at| *at >= end / 2);
    format!("{}…", head[..word.unwrap_or(end)].trim_end())
}

/// The UTC date of a Unix time in milliseconds, `YYYY-MM-DD`.
fn date(ms: i64) -> String {
    // Howard Hinnant's days-to-civil algorithm.
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}
