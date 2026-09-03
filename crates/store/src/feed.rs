//! The terse feed row, and the one entry point an adapter's consumer calls per envelope.
//!
//! The feed is the only append table and it is a capped ring, not a log. A row that carries no
//! information still costs a real row out of the cap, so the mapping is deliberately lossy:
//! streaming deltas and intermediate item updates produce nothing at all — no database write of
//! any kind, not merely no feed row.
// see docs/research/persistence.md §3 — t3code persisted per assistant chunk and grew
// 282 KB → 218 MB in 25 h. Never a write per chunk.
//!
//! Raw provider traffic never reaches the database. It goes to [`crate::ndjson`], and the
//! provider's own full transcript is pointed at by `sessions.transcript_path`.
// see docs/research/persistence.md §1 — Claude Code already writes the whole transcript; we
// store a pointer plus a derived summary and treat the file as a cache that may vanish.

use brigadier_core::event::{
    bounded, AbortReason, Envelope, Event, ExitReason, ItemKind, RequestKind, StopReason,
};
use brigadier_core::session::Decision;

use crate::schema::{SessionRow, SessionStatus};
use crate::writer::StoreHandle;

/// Bytes a feed row may occupy. One line in a list, not content.
pub const FEED_LINE_LIMIT: usize = 200;

/// What a feed row *is*, independent of how it reads.
///
/// The webview receives one pre-rendered string per row and must not have to parse its leading
/// label to tell model prose from a tool call: this is the discriminator it styles and filters on.
/// The set is closed. Every value except [`FeedKind::Unknown`] is derived from a variant that
/// exists in `brigadier_core::event` — see [`kind`] for the mapping; `Unknown` is the one value
/// [`kind`] never returns, reserved for a row whose kind was never recorded.
// see docs/plans/ipc-contract.md "Feed channel" — the wire field is `k`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedKind {
    /// A turn ended: [`Event::TurnStarted`], [`Event::TurnCompleted`], [`Event::TurnAborted`].
    Turn,
    /// A tool call or its result: [`ItemKind::ToolCall`], [`ItemKind::ToolResult`].
    Tool,
    /// Model prose: [`ItemKind::AssistantText`] and [`Event::ContentDelta`].
    Text,
    /// Model reasoning: [`ItemKind::Thinking`].
    Think,
    /// What the operator sent: [`ItemKind::UserText`].
    User,
    /// A nested agent's item: [`ItemKind::Subagent`].
    Sub,
    /// An approval or a question and its answer: [`Event::RequestOpened`],
    /// [`Event::RequestResolved`].
    Appr,
    /// [`Event::RuntimeWarning`].
    Warn,
    /// [`Event::RuntimeError`], fatal or not.
    Err,
    /// Session lifetime and housekeeping: [`Event::SessionStarted`], [`Event::SessionExited`],
    /// [`Event::SessionCompacted`]. Nothing else: this is a real class, not a bucket.
    Sys,
    /// The row's kind was never recorded — it predates `feed.kind`, or its slug was written by a
    /// build that knows a class this one does not.
    ///
    /// Deliberately *not* [`FeedKind::Sys`]. A row of unknown kind and a session-lifetime row are
    /// different facts, and collapsing them would have a UI filter classify 10,037 of the owner's
    /// existing rows as session housekeeping. A consumer should leave `unknown` rows alone rather
    /// than assign them a class.
    #[default]
    Unknown,
}

impl FeedKind {
    /// The slug stored in `feed.kind` and sent as the wire's `k`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Tool => "tool",
            Self::Text => "text",
            Self::Think => "think",
            Self::User => "user",
            Self::Sub => "sub",
            Self::Appr => "appr",
            Self::Warn => "warn",
            Self::Err => "err",
            Self::Sys => "sys",
            Self::Unknown => "unknown",
        }
    }

    /// Parse a stored slug. One this build does not know is [`FeedKind::Unknown`] rather than an
    /// error: a row written by a newer build must still render, and the line itself is never lost.
    pub fn from_slug(s: &str) -> Self {
        match s {
            "turn" => Self::Turn,
            "tool" => Self::Tool,
            "text" => Self::Text,
            "think" => Self::Think,
            "user" => Self::User,
            "sub" => Self::Sub,
            "appr" => Self::Appr,
            "warn" => Self::Warn,
            "err" => Self::Err,
            "sys" => Self::Sys,
            _ => Self::Unknown,
        }
    }
}

/// The [`FeedKind`] this event's row carries.
///
/// Total on purpose, where [`terse_line`] is not: the two are called together on the events that
/// do produce a row, and a total function cannot drift out of step with the union the way a
/// second `Option` would. Never returns [`FeedKind::Unknown`] — every event has a class.
pub fn kind(event: &Event) -> FeedKind {
    match event {
        Event::SessionStarted { .. }
        | Event::SessionExited { .. }
        | Event::SessionCompacted { .. } => FeedKind::Sys,
        Event::TurnStarted { .. } | Event::TurnCompleted { .. } | Event::TurnAborted { .. } => {
            FeedKind::Turn
        }
        Event::ItemStarted { kind, .. }
        | Event::ItemUpdated { kind, .. }
        | Event::ItemCompleted { kind, .. } => item_kind(kind),
        Event::ContentDelta { .. } => FeedKind::Text,
        Event::RequestOpened { .. } | Event::RequestResolved { .. } => FeedKind::Appr,
        Event::RuntimeWarning { .. } => FeedKind::Warn,
        Event::RuntimeError { .. } => FeedKind::Err,
    }
}

fn item_kind(kind: &ItemKind) -> FeedKind {
    match kind {
        ItemKind::AssistantText => FeedKind::Text,
        ItemKind::Thinking => FeedKind::Think,
        ItemKind::ToolCall { .. } | ItemKind::ToolResult { .. } => FeedKind::Tool,
        ItemKind::UserText => FeedKind::User,
        ItemKind::Subagent { .. } => FeedKind::Sub,
    }
}

/// The one-line, bounded row this event contributes to the UI feed, or `None` when it
/// contributes nothing.
///
/// `None` for [`Event::ContentDelta`] (a fragment of a line already summarised by its item),
/// [`Event::ItemUpdated`] (superseded by the item's completion) and [`Event::TurnStarted`]
/// (the turn's accounting arrives with its completion).
///
/// The canonical schema gives [`Event::RuntimeWarning`] no severity field, so no threshold can
/// be applied here and every warning gets a row; if warnings ever become chatty the threshold
/// belongs on the event, not in this function.
pub fn terse_line(event: &Event) -> Option<String> {
    let line = match event {
        Event::SessionStarted { model, cwd, .. } => {
            format!("session started · {model} · {}", cwd.display())
        }
        Event::SessionExited { reason, exit_code } => match exit_code {
            Some(code) => format!("session exited · {} · exit {code}", exit_str(reason)),
            None => format!("session exited · {}", exit_str(reason)),
        },
        Event::TurnStarted { .. } => return None,
        // No dollar figure: the user runs on their own subscription and is never billed this
        // number, so rendering it would be a lie in their favour.
        // see docs/vision.md §6 "Economics — usage windows, never dollars". `cost_usd_cumulative`
        // stays on the event and in `sessions.cost_usd_cumulative`; only the row drops it.
        Event::TurnCompleted { stop_reason, usage, .. } => format!(
            "turn done · {} · {} in / {} out",
            stop_str(stop_reason),
            usage.input_tokens,
            usage.output_tokens
        ),
        Event::TurnAborted { reason, .. } => format!("turn aborted · {}", abort_str(reason)),
        Event::ItemStarted { kind, summary, .. } => join(&item_label(kind), summary),
        Event::ItemUpdated { .. } => return None,
        Event::ItemCompleted { kind, summary, .. } => {
            join(&format!("{} done", item_label(kind)), summary)
        }
        Event::ContentDelta { .. } => return None,
        Event::RequestOpened { kind, .. } => match kind {
            RequestKind::ToolPermission { tool_name, .. } => {
                format!("approval asked · {tool_name}")
            }
            RequestKind::UserInput { prompt, .. } => join("question", prompt),
        },
        Event::RequestResolved { decision, .. } => match decision {
            Decision::Allow { .. } => "approval allowed".to_owned(),
            Decision::Deny { reason, .. } => join("approval denied", reason),
        },
        Event::SessionCompacted { trigger, pre_tokens } => {
            let trigger = match trigger {
                brigadier_core::event::CompactTrigger::Manual => "manual",
                brigadier_core::event::CompactTrigger::Auto => "auto",
            };
            match pre_tokens {
                Some(n) => format!("context compacted · {trigger} · {n} tokens before"),
                None => format!("context compacted · {trigger}"),
            }
        }
        Event::RuntimeWarning { message } => join("warning", message),
        Event::RuntimeError { message, fatal } => {
            join(if *fatal { "fatal error" } else { "error" }, message)
        }
    };
    Some(bounded(&line, FEED_LINE_LIMIT))
}

fn join(label: &str, tail: &str) -> String {
    let tail = tail.trim();
    if tail.is_empty() {
        label.to_owned()
    } else {
        format!("{label} · {tail}")
    }
}

fn item_label(kind: &ItemKind) -> String {
    match kind {
        ItemKind::AssistantText => "assistant".to_owned(),
        ItemKind::Thinking => "thinking".to_owned(),
        ItemKind::ToolCall { name } => format!("tool {name}"),
        ItemKind::ToolResult { is_error, .. } => {
            if *is_error { "tool failed" } else { "tool result" }.to_owned()
        }
        ItemKind::UserText => "user".to_owned(),
        ItemKind::Subagent { task_id, subagent_type, .. } => {
            format!("subagent {}", subagent_type.as_deref().unwrap_or(task_id.as_str()))
        }
    }
}

fn exit_str(reason: &ExitReason) -> String {
    match reason {
        ExitReason::Graceful => "graceful".to_owned(),
        ExitReason::Killed => "killed".to_owned(),
        ExitReason::Crashed => "crashed".to_owned(),
        ExitReason::Error(e) => format!("error: {e}"),
    }
}

fn abort_str(reason: &AbortReason) -> String {
    match reason {
        AbortReason::Interrupted => "interrupted".to_owned(),
        AbortReason::Killed => "killed".to_owned(),
        AbortReason::Error(e) => format!("error: {e}"),
    }
}

fn stop_str(reason: &StopReason) -> String {
    match reason {
        StopReason::EndTurn => "end-turn".to_owned(),
        StopReason::MaxTokens => "max-tokens".to_owned(),
        StopReason::MaxTurns => "max-turns".to_owned(),
        StopReason::Refusal => "refusal".to_owned(),
        StopReason::Error(e) => format!("error: {e}"),
        StopReason::Other(s) => s.clone(),
    }
}

/// Persist one envelope: the single call an adapter's consumer makes per event.
///
/// Errors are swallowed on purpose — a closed store must not take a session down with it, and
/// [`StoreHandle`] already logs. Nothing here awaits a commit; the writer coalesces.
///
/// `sessions.transcript_path` is **not** filled in here: reconstructing the provider's own
/// transcript path is provider-specific, so the adapter sets it with
/// [`StoreHandle::upsert_session`] at spawn time.
// see docs/research/persistence.md §1 — the pointer needs the cwd recorded at spawn, and the
// file is a cache the provider sweeps after `cleanupPeriodDays`.
pub async fn apply(env: &Envelope, handle: &StoreHandle) {
    match &env.event {
        Event::SessionStarted { provider_session_id, model, cwd, resume_token, .. } => {
            let mut row = SessionRow::new(env.session_id.clone());
            row.instance_id = Some(env.instance_id.clone());
            row.provider_session_id = Some(provider_session_id.clone());
            row.model = Some(model.clone());
            row.cwd = Some(cwd.clone());
            row.resume_token = resume_token.clone();
            row.status = Some(SessionStatus::Running);
            row.started_at = Some(env.at);
            let _ = handle.upsert_session(row).await;
        }
        Event::TurnCompleted { turn_id, stop_reason, usage, cost_usd_cumulative } => {
            let _ = handle
                .set_usage(env.session_id.clone(), *usage, *cost_usd_cumulative)
                .await;
            // The bounded derived summary is a whole-value overwrite, not a merge: it describes
            // the latest completed turn and nothing else, so there is nothing to accumulate.
            let mut row = SessionRow::new(env.session_id.clone());
            row.summary_json = Some(
                serde_json::json!({
                    "last_turn_id": turn_id.as_str(),
                    "last_stop_reason": stop_str(stop_reason),
                    "last_turn_at": crate::schema::to_millis(env.at),
                })
                .to_string(),
            );
            let _ = handle.upsert_session(row).await;
        }
        Event::RequestOpened { request_id, kind, .. } => {
            let approval = brigadier_core::approval::PendingApproval {
                request_id: request_id.clone(),
                kind: kind.clone(),
                opened_at: env.at,
            };
            let _ = handle.approval_opened(env.session_id.clone(), approval).await;
        }
        Event::RequestResolved { request_id, decision } => {
            let _ = handle
                .approval_resolved(request_id.clone(), decision.clone(), env.at)
                .await;
        }
        Event::SessionExited { reason, exit_code } => {
            let _ = handle
                .session_ended(env.session_id.clone(), reason.clone(), *exit_code, env.at)
                .await;
        }
        _ => {}
    }
    if let Some(line) = terse_line(&env.event) {
        let _ = handle
            .feed(env.session_id.clone(), env.seq, env.at, kind(&env.event), line)
            .await;
    }
}
