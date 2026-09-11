//! Canonical event schema: the one shape every provider adapter emits.
//!
//! A small shared core, not a union of every provider's protocol.
//! see docs/research/provider-driver.md §4 and §6 #13 — 24 of t3code's 49 event types have
//! exactly one emitter; only the ~15 genuinely shared ones are copied here.

use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Deserializer, Serialize};

use crate::session::Decision;

/// Maximum bytes of provider payload kept in [`Envelope::raw`].
// see docs/research/provider-driver.md §6 #14 — t3code's `raw` is unbounded and rides into persistence.
pub const RAW_EXCERPT_LIMIT: usize = 4 * 1024;

/// Maximum bytes of tool input kept in [`RequestKind::ToolPermission::input_excerpt`].
// see docs/research/persistence.md §6 — a `Write` approval carries the whole file body.
pub const INPUT_EXCERPT_LIMIT: usize = 8 * 1024;

/// Maximum bytes of an item `summary`; summaries are one terse line, not content.
pub const SUMMARY_LIMIT: usize = 240;

/// Truncate `s` to at most `max_bytes` bytes on a UTF-8 boundary, marking a cut with `…`.
pub fn bounded(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_owned();
    }
    const ELLIPSIS: &str = "…";
    if max_bytes < ELLIPSIS.len() {
        // No room for the marker: hard-cut back to a boundary.
        let mut hard = max_bytes;
        while hard > 0 && !s.is_char_boundary(hard) {
            hard -= 1;
        }
        return s[..hard].to_owned();
    }
    let mut end = max_bytes - ELLIPSIS.len();
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(max_bytes);
    out.push_str(&s[..end]);
    out.push_str(ELLIPSIS);
    out
}

/// Milliseconds-since-epoch serde codec for [`SystemTime`].
pub(crate) mod millis {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    pub fn serialize<S: Serializer>(t: &SystemTime, s: S) -> Result<S::Ok, S::Error> {
        let raw = t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
        u64::try_from(raw).unwrap_or(u64::MAX).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<SystemTime, D::Error> {
        let ms = u64::deserialize(d)?;
        Ok(UNIX_EPOCH + Duration::from_millis(ms))
    }
}

macro_rules! string_id {
    ($(#[$m:meta])* $name:ident) => {
        $(#[$m])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Wrap a string as this id. Ids are opaque and never validated.
            pub fn new(s: impl Into<String>) -> Self { Self(s.into()) }
            /// Borrow the underlying string.
            pub fn as_str(&self) -> &str { &self.0 }
            /// Consume the id, yielding the underlying string.
            pub fn into_inner(self) -> String { self.0 }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl From<String> for $name { fn from(s: String) -> Self { Self(s) } }
        impl From<&str> for $name { fn from(s: &str) -> Self { Self(s.to_owned()) } }
    };
}

string_id! {
    /// Routing key for one materialized provider instance (one account, one binary).
    // see docs/research/provider-driver.md §6 #3, #27 — never defaults to the driver kind.
    InstanceId
}
string_id! {
    /// Our id for one supervised session; distinct from the provider's own session id.
    SessionId
}
string_id! {
    /// Our id for one turn; minted locally, not the provider's.
    TurnId
}
string_id! {
    /// Our id for one timeline item (a message, a tool call, a subagent).
    ItemId
}
string_id! {
    /// Our id for one parked request awaiting a human decision.
    // see docs/research/provider-driver.md §6 #5 — mint our own, never reuse the tool-use or RPC id.
    RequestId
}

/// One event on one session's ordered stream.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    /// Monotonic per-session sequence number; gaps mean a lost event, never a reorder.
    pub seq: u64,
    /// Host wall clock at emission, on the wire as milliseconds since the Unix epoch.
    #[serde(with = "millis")]
    pub at: SystemTime,
    /// Which provider instance produced it.
    pub instance_id: InstanceId,
    /// Which session produced it.
    pub session_id: SessionId,
    /// The event itself.
    pub event: Event,
    /// Untranslated provider payload excerpt, bounded by [`RAW_EXCERPT_LIMIT`].
    ///
    /// Prefer [`Envelope::with_raw`] and [`Envelope::raw`] over touching the field: both ends
    /// the crate controls are bounded — `with_raw` truncates on the way in, and the field's
    /// `deserialize_with` truncates again on the way off the wire, so a 20 KB `raw` in a
    /// persisted line cannot re-enter the process at full size. The field stays public only
    /// because `brigadier-store`'s tests build envelopes with a struct literal.
    // see docs/research/provider-driver.md §6 #14 — keep the wire payload, but bound it.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "bounded_raw")]
    pub raw: Option<String>,
    /// Display body, separate from diagnostic excerpts and terse summaries (128 KiB maximum).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "bounded_body")]
    pub body: Option<String>,
}

/// Bound display content at the wire boundary as well as when emitting it.
fn bounded_body<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(Option::<String>::deserialize(d)?.map(|body| bounded(&body, 128 * 1024)))
}

/// Bounds [`Envelope::raw`] on the way in, matching [`Envelope::with_raw`].
fn bounded_raw<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(Option::<String>::deserialize(d)?.map(|raw| bounded(&raw, RAW_EXCERPT_LIMIT)))
}

impl Envelope {
    /// Build an envelope with no raw excerpt.
    pub fn new(seq: u64, instance_id: InstanceId, session_id: SessionId, event: Event) -> Self {
        Self { seq, at: SystemTime::now(), instance_id, session_id, event, raw: None, body: None }
    }

    /// Attach a provider payload excerpt, truncated to [`RAW_EXCERPT_LIMIT`].
    pub fn with_raw(mut self, raw: &str) -> Self {
        self.raw = Some(bounded(raw, RAW_EXCERPT_LIMIT));
        self
    }

    /// Attach display content without expanding the lightweight feed.
    pub fn with_body(mut self, body: &str) -> Self {
        self.body = Some(bounded(body, 128 * 1024));
        self
    }

    /// The provider payload excerpt, if one was kept.
    pub fn raw(&self) -> Option<&str> {
        self.raw.as_deref()
    }
}

/// The canonical event union.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    /// The provider accepted the session and reported its identity and feature set.
    SessionStarted {
        /// The provider's own session id (Claude: `system/init.session_id`).
        provider_session_id: String,
        /// Model slug in effect at start.
        model: String,
        /// Working directory handed to the child.
        cwd: PathBuf,
        /// Feature slugs the provider advertises.
        // see docs/research/agent-sdk.md §1 — `system/init.capabilities` is the intended handshake.
        capabilities: Vec<String>,
        /// Token to hand back to `resume_session`, when the provider supports resume.
        resume_token: Option<String>,
    },
    /// The session ended; nothing further will arrive on this stream.
    SessionExited {
        /// Why it ended.
        reason: ExitReason,
        /// Child process exit code, when one was observed.
        exit_code: Option<i32>,
    },
    /// A turn began.
    TurnStarted {
        /// The turn.
        turn_id: TurnId,
    },
    /// A turn ended normally, with the provider's terminal accounting.
    TurnCompleted {
        /// The turn.
        turn_id: TurnId,
        /// Why the model stopped.
        stop_reason: StopReason,
        /// Session-cumulative token usage as of this turn.
        usage: Usage,
        /// Session-cumulative cost in USD; read from the latest result, never summed.
        // see docs/research/agent-sdk.md §6 — `total_cost_usd`/`modelUsage` are cumulative.
        cost_usd_cumulative: f64,
    },
    /// A turn was cut short; the provider may or may not have emitted a terminal frame.
    // see docs/research/agent-sdk.md §10 — kill yields no result, so the adapter synthesises this.
    TurnAborted {
        /// The turn.
        turn_id: TurnId,
        /// How it was cut short.
        reason: AbortReason,
    },
    /// A timeline item appeared.
    ItemStarted {
        /// The item.
        item_id: ItemId,
        /// What kind of item it is.
        kind: ItemKind,
        /// One terse line, bounded by [`SUMMARY_LIMIT`].
        summary: String,
        /// The item this one nests under, when a subagent produced it.
        // see docs/research/agent-sdk.md §6 — Claude's `parent_tool_use_id` is the `Task`
        // tool-use id of the subagent that emitted the frame, `null` on the main loop.
        parent_item_id: Option<ItemId>,
    },
    /// A timeline item changed without completing.
    ItemUpdated {
        /// The item.
        item_id: ItemId,
        /// What kind of item it is.
        kind: ItemKind,
        /// One terse line, bounded by [`SUMMARY_LIMIT`].
        summary: String,
        /// The item this one nests under, when a subagent produced it.
        parent_item_id: Option<ItemId>,
    },
    /// A timeline item reached its final state.
    ItemCompleted {
        /// The item.
        item_id: ItemId,
        /// What kind of item it is.
        kind: ItemKind,
        /// One terse line, bounded by [`SUMMARY_LIMIT`].
        summary: String,
        /// The item this one nests under, when a subagent produced it.
        parent_item_id: Option<ItemId>,
    },
    /// Streamed text appended to an item.
    ContentDelta {
        /// The item being appended to.
        item_id: ItemId,
        /// The appended fragment.
        text: String,
    },
    /// The provider is blocked awaiting a decision from us.
    RequestOpened {
        /// The parked request.
        request_id: RequestId,
        /// What is being asked.
        kind: RequestKind,
        /// The turn it blocks, when the adapter knows it.
        turn_id: Option<TurnId>,
    },
    /// A parked request was answered, timed out, or cancelled.
    RequestResolved {
        /// The request.
        request_id: RequestId,
        /// The answer that unblocked it.
        decision: Decision,
    },
    /// The provider compacted its own context.
    // see docs/research/agent-sdk.md §6 — `system/compact_boundary.compact_metadata`.
    SessionCompacted {
        /// What caused the compaction.
        trigger: CompactTrigger,
        /// Token count before compaction, when reported.
        pre_tokens: Option<u64>,
    },
    /// Something the operator should see that did not stop the session.
    RuntimeWarning {
        /// Human-readable text.
        message: String,
    },
    /// An error. `fatal` means the session is over.
    RuntimeError {
        /// Human-readable text.
        message: String,
        /// True when the session cannot continue.
        fatal: bool,
    },
    /// The provider reported where the operator stands against their own usage windows.
    ///
    /// Arrives once per turn, early. **There is no cost field and none is ever added**: the user
    /// runs on their own subscription and is never billed a dollar figure, so the gauge is the
    /// window, not the money (`docs/vision.md` §6).
    // see docs/plans/codex-thread-rebuild-2026-09-11.md §4.3 — `rate_limit_event.unifiedWindows`.
    UsageWindows {
        /// `"allowed"`, `"rejected"`, or a value a future CLI adds. A string, not an enum: the
        /// UI renders what it is given rather than switching on a closed set.
        status: String,
        /// One entry per key present in `unifiedWindows`. The set is **open** — an unrecognised
        /// window name is passed through, never dropped.
        windows: Vec<UsageWindow>,
    },
}

/// One usage window: how much of it is spent, and when it refills.
// see docs/plans/codex-thread-rebuild-2026-09-11.md §4.3 for the measured frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsageWindow {
    /// `"five_hour"`, `"seven_day"`, or a future key, verbatim.
    pub name: String,
    /// Fraction of the window consumed, 0.0–1.0, at two-decimal resolution. **Not a percentage.**
    pub utilization: f64,
    /// When the window resets, in **unix seconds** — not the milliseconds the rest of this module
    /// uses, because that is what the provider sends.
    pub resets_at: i64,
}

impl Event {
    /// [`Event::ItemStarted`] with the summary bounded to [`SUMMARY_LIMIT`].
    ///
    /// The three item constructors are the only way an adapter should build these: a summary is
    /// one terse line, and the variants' public fields would otherwise let a whole tool output
    /// ride into persistence under that name.
    pub fn item_started(
        item_id: ItemId,
        kind: ItemKind,
        summary: &str,
        parent_item_id: Option<ItemId>,
    ) -> Self {
        Self::ItemStarted {
            item_id,
            kind,
            summary: bounded(summary, SUMMARY_LIMIT),
            parent_item_id,
        }
    }

    /// [`Event::ItemUpdated`] with the summary bounded to [`SUMMARY_LIMIT`].
    pub fn item_updated(
        item_id: ItemId,
        kind: ItemKind,
        summary: &str,
        parent_item_id: Option<ItemId>,
    ) -> Self {
        Self::ItemUpdated {
            item_id,
            kind,
            summary: bounded(summary, SUMMARY_LIMIT),
            parent_item_id,
        }
    }

    /// [`Event::ItemCompleted`] with the summary bounded to [`SUMMARY_LIMIT`].
    pub fn item_completed(
        item_id: ItemId,
        kind: ItemKind,
        summary: &str,
        parent_item_id: Option<ItemId>,
    ) -> Self {
        Self::ItemCompleted {
            item_id,
            kind,
            summary: bounded(summary, SUMMARY_LIMIT),
            parent_item_id,
        }
    }
}

/// Why a session ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExitReason {
    /// We ended it and the child left cleanly.
    Graceful,
    /// We killed the process group.
    Killed,
    /// The child died without us asking.
    Crashed,
    /// The adapter gave up; the string is the cause.
    Error(String),
}

/// Why a turn was cut short.
// see docs/research/agent-sdk.md §10 — interrupt and kill are two first-class shapes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AbortReason {
    /// Graceful interrupt; the session survives.
    Interrupted,
    /// The process was killed; no provider terminal frame exists.
    Killed,
    /// The adapter failed mid-turn.
    Error(String),
}

/// Why the model stopped producing on a completed turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    /// The model finished.
    EndTurn,
    /// The output token cap was reached.
    MaxTokens,
    /// The turn cap was reached.
    MaxTurns,
    /// The model refused.
    Refusal,
    /// The turn ended in an error; the string is the provider's message.
    Error(String),
    /// A provider reason we do not model, verbatim.
    // see docs/research/provider-driver.md §6 #21 — never substring-sniff; an unmapped value is loud.
    Other(String),
}

/// What a timeline item is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ItemKind {
    /// Assistant prose.
    AssistantText,
    /// Extended thinking.
    Thinking,
    /// A tool invocation.
    ToolCall {
        /// Tool name as the provider reports it.
        name: String,
    },
    /// The result of a tool invocation.
    ToolResult {
        /// The tool call this answers.
        tool_call_id: String,
        /// True when the tool reported failure. **Also true for an interrupt and for a rejected
        /// tool use**, so it is never on its own evidence that a command failed — pair it with
        /// `interrupted` below. `is_error && !interrupted` is the field a renderer should key a
        /// failure color off, not `exit_code`: a genuine failure whose body doesn't parse (a
        /// non-Bash tool's error text, or an unrecognised shape) still has `exit_code: None`.
        is_error: bool,
        /// On failure, parsed from the literal first line `Exit code N` of the result body.
        /// On success, `Some(0)`: a successful shell result carries no `Exit code` line at all
        /// (measured, `docs/research/cli-steer-and-exit-codes.md` row 3), so the zero is read off
        /// `is_error == false` rather than parsed. `None` for an interrupted or denied result, and
        /// always `None` for a tool that is not a shell — see `is_error` above for the coloring
        /// field a renderer should key off instead of this one, since a genuine failure whose body
        /// does not parse also leaves this `None`.
        // see docs/plans/codex-thread-rebuild-2026-09-11.md §4.1 — there is no numeric exit-code
        // field anywhere on the wire; that first line is the only carrier on failure, and absence
        // of the line is the only carrier of success.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        /// Set when the operator stopped this rather than the command failing: an interrupt, or
        /// a **denial**. Renders as a decision, never as a failure.
        ///
        /// A denial's source is brigadier's own [`crate::session::Decision::Deny`], not the
        /// provider: the CLI echoes the deny *reason* verbatim, so there is no marker in the
        /// error text to match and matching it would be a parser pointed at human input.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        interrupted: bool,
    },
    /// Text we sent on the operator's behalf.
    UserText,
    /// A subagent's lifetime, collapsed to one item.
    // see docs/research/agent-sdk.md §6 — `system/task_started`.
    Subagent {
        /// The provider's task id.
        task_id: String,
        /// Subagent type slug, when reported.
        subagent_type: Option<String>,
        /// The task description, when reported.
        description: Option<String>,
    },
    /// A lifecycle note the store synthesises so the thread can show it inline: a compaction, a
    /// runtime warning or error, a session exit.
    ///
    /// Never emitted by an adapter — `brigadier_store::chat::project` mints these from the
    /// matching [`Event`] with a deterministic synthetic id, so a replay cannot duplicate one.
    // see docs/plans/codex-thread-rebuild-2026-09-11.md §4.4.
    Notice {
        /// How loud it is.
        level: NoticeLevel,
        /// A stable slug for what happened: `compacted`, `runtime`, `exited`.
        code: String,
        /// Structured extras the row may render — `pre_tokens`, `exit_code` — or `None`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<serde_json::Value>,
    },
}

/// How loud an [`ItemKind::Notice`] is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    /// Housekeeping: a compaction, a clean exit.
    Info,
    /// Something the operator should see that did not stop the session.
    Warning,
    /// An error the session survived.
    Error,
    /// An error the session did not survive.
    Fatal,
}

/// What a parked request is asking for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RequestKind {
    /// The provider wants permission to run a tool.
    // see docs/research/agent-sdk.md §3 — the `canUseTool` callback.
    ToolPermission {
        /// Tool name as the provider reports it.
        tool_name: String,
        /// Tool input, bounded by [`INPUT_EXCERPT_LIMIT`].
        input_excerpt: String,
        /// Opaque provider permission updates to echo back verbatim for "always allow".
        // see docs/research/agent-sdk.md §3 — `suggestions` are echoed as `updatedPermissions`.
        suggestions: Vec<serde_json::Value>,
        /// The tool call this prompt gates, correlating it with its [`ItemKind::ToolCall`].
        // see docs/research/claude-direct-spike.md "The exact frames that worked" — the CLI's
        // `can_use_tool` carries `tool_use_id`, and it is the same id as the `tool_use` block's
        // and the answering `tool_result`'s. Optional: `sdk.d.ts:4174` types it nullable.
        tool_call_id: Option<String>,
    },
    /// The provider is asking the operator a question.
    UserInput {
        /// The question.
        prompt: String,
        /// Offered answers; empty means free text.
        options: Vec<String>,
    },
}

impl RequestKind {
    /// A [`RequestKind::ToolPermission`] whose `input_excerpt` is bounded to
    /// [`INPUT_EXCERPT_LIMIT`].
    ///
    /// The only way an adapter should build one: a `Write` approval carries the whole file body,
    /// and an unbounded excerpt rides from the park into persistence and back out to the UI.
    // see docs/research/persistence.md §6.
    pub fn tool_permission(
        tool_name: impl Into<String>,
        input_json: &str,
        suggestions: Vec<serde_json::Value>,
        tool_call_id: Option<String>,
    ) -> Self {
        Self::ToolPermission {
            tool_name: tool_name.into(),
            input_excerpt: bounded(input_json, INPUT_EXCERPT_LIMIT),
            suggestions,
            tool_call_id,
        }
    }
}

/// What triggered a compaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompactTrigger {
    /// The operator or the agent asked for it.
    Manual,
    /// The provider hit its own threshold.
    Auto,
}

/// Token accounting for a session.
///
/// Every field is **cumulative across the session**, read from the provider's latest terminal
/// frame and never summed across frames.
// see docs/research/agent-sdk.md §6 — `usage`/`modelUsage`/`total_cost_usd` are cumulative;
// a resumed session restarts at zero and a mid-session `/clear` resets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    /// Cumulative uncached input tokens.
    pub input_tokens: u64,
    /// Cumulative output tokens.
    pub output_tokens: u64,
    /// Cumulative tokens served from the prompt cache.
    pub cache_read_tokens: u64,
    /// Cumulative tokens written to the prompt cache.
    pub cache_creation_tokens: u64,
    /// Model context window in tokens, when the provider reports it.
    pub context_window: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(event: Event) -> Envelope {
        Envelope {
            seq: 7,
            at: std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_000_123),
            instance_id: InstanceId::new("claude-code:work"),
            session_id: SessionId::new("s1"),
            event,
            raw: None,
            body: None,
        }
    }

    fn wire(event: Event) -> String {
        serde_json::to_string(&event).expect("event serializes")
    }

    fn round_trip(event: Event) {
        let e = env(event);
        let json = serde_json::to_string(&e).expect("envelope serializes");
        let back: Envelope = serde_json::from_str(&json).expect("envelope deserializes");
        assert_eq!(e, back);
    }

    #[test]
    fn bounded_leaves_short_strings_alone() {
        assert_eq!(bounded("abc", 8), "abc");
        assert_eq!(bounded("abc", 3), "abc");
        assert_eq!(bounded("", 0), "");
    }

    #[test]
    fn bounded_truncates_within_budget() {
        let out = bounded(&"x".repeat(100), 10);
        assert!(out.len() <= 10, "len {}", out.len());
        assert_eq!(out, "xxxxxxx…");
        assert!(bounded(&"y".repeat(9000), RAW_EXCERPT_LIMIT).len() <= RAW_EXCERPT_LIMIT);
    }

    #[test]
    fn bounded_never_splits_a_codepoint() {
        // 'é' is two bytes; a naive cut at 5 would split the third one.
        let out = bounded("ééé", 5);
        assert!(out.is_char_boundary(out.len()));
        assert_eq!(out, "é…");
        // No room for the marker at all: hard-cut back to a boundary, still valid UTF-8.
        assert_eq!(bounded("ééé", 2), "é");
        assert_eq!(bounded("ééé", 1), "");
        assert_eq!(bounded("ééé", 0), "");
    }

    #[test]
    fn envelope_wire_shape_and_raw_bounding() {
        let e = env(Event::TurnStarted { turn_id: TurnId::new("t1") }).with_raw(&"z".repeat(9000));
        let json = serde_json::to_string(&e).expect("serializes");
        assert!(json.starts_with(
            r#"{"seq":7,"at":1700000000123,"instance_id":"claude-code:work","session_id":"s1","#
        ));
        assert!(json.contains(r#""event":{"type":"turn-started","turn_id":"t1"}"#));
        let back: Envelope = serde_json::from_str(&json).expect("deserializes");
        assert_eq!(back.raw.expect("raw kept").len(), RAW_EXCERPT_LIMIT);
    }

    /// A `raw` that never went through [`Envelope::with_raw`] — a hand-written line, a row from
    /// an older build, a peer that did not bound it — is bounded on the way in too.
    #[test]
    fn a_deserialized_raw_is_bounded_by_the_type() {
        let json = serde_json::json!({
            "seq": 1,
            "at": 1_700_000_000_123u64,
            "instance_id": "i",
            "session_id": "s",
            "event": {"type": "runtime-warning", "message": "hi"},
            "raw": "z".repeat(20_000),
        })
        .to_string();
        let back: Envelope = serde_json::from_str(&json).expect("deserializes");
        let raw = back.raw().expect("raw kept");
        assert!(raw.len() <= RAW_EXCERPT_LIMIT, "{} bytes survived", raw.len());
        assert!(raw.ends_with('…'), "a cut is marked");
    }

    #[test]
    fn tool_permission_bounds_a_100_kb_input() {
        let input = serde_json::json!({"content": "x".repeat(100 * 1024)}).to_string();
        assert!(input.len() > 100 * 1024);
        let kind = RequestKind::tool_permission("Write", &input, Vec::new(), None);
        let RequestKind::ToolPermission { input_excerpt, tool_name, .. } = &kind else {
            panic!("expected a tool permission: {kind:?}");
        };
        assert_eq!(tool_name, "Write");
        assert!(input_excerpt.len() <= INPUT_EXCERPT_LIMIT, "{} bytes", input_excerpt.len());
        assert!(input_excerpt.len() <= 8 * 1024);
    }

    #[test]
    fn item_constructors_bound_a_10_kb_summary() {
        let long = "s".repeat(10 * 1024);
        for event in [
            Event::item_started(ItemId::new("i"), ItemKind::AssistantText, &long, None),
            Event::item_updated(ItemId::new("i"), ItemKind::AssistantText, &long, None),
            Event::item_completed(ItemId::new("i"), ItemKind::AssistantText, &long, None),
        ] {
            let summary = match &event {
                Event::ItemStarted { summary, .. }
                | Event::ItemUpdated { summary, .. }
                | Event::ItemCompleted { summary, .. } => summary,
                other => panic!("expected an item event: {other:?}"),
            };
            assert!(summary.len() <= SUMMARY_LIMIT, "{} bytes", summary.len());
        }
    }

    #[test]
    fn envelope_omits_absent_raw() {
        let json = serde_json::to_string(&env(Event::RuntimeWarning { message: "hi".into() }))
            .expect("serializes");
        assert!(!json.contains("raw"), "{json}");
    }

    #[test]
    fn session_events_wire_shape() {
        assert_eq!(
            wire(Event::SessionStarted {
                provider_session_id: "abc".into(),
                model: "claude-opus-4-8".into(),
                cwd: PathBuf::from("/w"),
                capabilities: vec!["interrupt_receipt_v1".into()],
                resume_token: None,
            }),
            r#"{"type":"session-started","provider_session_id":"abc","model":"claude-opus-4-8","cwd":"/w","capabilities":["interrupt_receipt_v1"],"resume_token":null}"#
        );
        assert_eq!(
            wire(Event::SessionExited { reason: ExitReason::Graceful, exit_code: Some(0) }),
            r#"{"type":"session-exited","reason":"graceful","exit_code":0}"#
        );
        assert_eq!(
            wire(Event::SessionExited {
                reason: ExitReason::Error("pipe closed".into()),
                exit_code: None
            }),
            r#"{"type":"session-exited","reason":{"error":"pipe closed"},"exit_code":null}"#
        );
        assert_eq!(
            wire(Event::SessionCompacted {
                trigger: CompactTrigger::Auto,
                pre_tokens: Some(180_000)
            }),
            r#"{"type":"session-compacted","trigger":"auto","pre_tokens":180000}"#
        );
    }

    #[test]
    fn turn_events_wire_shape() {
        assert_eq!(
            wire(Event::TurnStarted { turn_id: TurnId::new("t1") }),
            r#"{"type":"turn-started","turn_id":"t1"}"#
        );
        assert_eq!(
            wire(Event::TurnCompleted {
                turn_id: TurnId::new("t1"),
                stop_reason: StopReason::EndTurn,
                usage: Usage { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 4, context_window: Some(200_000) },
                cost_usd_cumulative: 0.25,
            }),
            r#"{"type":"turn-completed","turn_id":"t1","stop_reason":"end-turn","usage":{"input_tokens":1,"output_tokens":2,"cache_read_tokens":3,"cache_creation_tokens":4,"context_window":200000},"cost_usd_cumulative":0.25}"#
        );
        assert_eq!(
            wire(Event::TurnCompleted {
                turn_id: TurnId::new("t2"),
                stop_reason: StopReason::Other("aborted_tools".into()),
                usage: Usage::default(),
                cost_usd_cumulative: 0.0,
            }),
            r#"{"type":"turn-completed","turn_id":"t2","stop_reason":{"other":"aborted_tools"},"usage":{"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_creation_tokens":0,"context_window":null},"cost_usd_cumulative":0.0}"#
        );
        assert_eq!(
            wire(Event::TurnAborted { turn_id: TurnId::new("t1"), reason: AbortReason::Killed }),
            r#"{"type":"turn-aborted","turn_id":"t1","reason":"killed"}"#
        );
    }

    #[test]
    fn item_events_wire_shape() {
        assert_eq!(
            wire(Event::ItemStarted {
                item_id: ItemId::new("i1"),
                kind: ItemKind::ToolCall { name: "Bash".into() },
                summary: "Bash: ls".into(),
                parent_item_id: None,
            }),
            r#"{"type":"item-started","item_id":"i1","kind":{"type":"tool-call","name":"Bash"},"summary":"Bash: ls","parent_item_id":null}"#
        );
        assert_eq!(
            wire(Event::ItemUpdated {
                item_id: ItemId::new("i1"),
                kind: ItemKind::AssistantText,
                summary: "…".into(),
                parent_item_id: Some(ItemId::new("toolu_task")),
            }),
            r#"{"type":"item-updated","item_id":"i1","kind":{"type":"assistant-text"},"summary":"…","parent_item_id":"toolu_task"}"#
        );
        assert_eq!(
            wire(Event::ItemCompleted {
                item_id: ItemId::new("i2"),
                kind: ItemKind::ToolResult {
                    tool_call_id: "tu_1".into(),
                    is_error: true,
                    exit_code: None,
                    interrupted: false,
                },
                summary: "exit 1".into(),
                parent_item_id: None,
            }),
            r#"{"type":"item-completed","item_id":"i2","kind":{"type":"tool-result","tool_call_id":"tu_1","is_error":true},"summary":"exit 1","parent_item_id":null}"#
        );
        // Both new fields are skipped when they carry nothing, so a consumer built against the
        // shape above still reads the frame above byte for byte.
        assert_eq!(
            wire(Event::ItemCompleted {
                item_id: ItemId::new("i3"),
                kind: ItemKind::ToolResult {
                    tool_call_id: "tu_2".into(),
                    is_error: true,
                    exit_code: Some(3),
                    interrupted: true,
                },
                summary: "exit 3".into(),
                parent_item_id: None,
            }),
            r#"{"type":"item-completed","item_id":"i3","kind":{"type":"tool-result","tool_call_id":"tu_2","is_error":true,"exit_code":3,"interrupted":true},"summary":"exit 3","parent_item_id":null}"#
        );
        assert_eq!(
            wire(Event::ItemCompleted {
                item_id: ItemId::new("i4"),
                kind: ItemKind::Notice {
                    level: NoticeLevel::Warning,
                    code: "runtime".into(),
                    detail: None,
                },
                summary: "shadowed".into(),
                parent_item_id: None,
            }),
            r#"{"type":"item-completed","item_id":"i4","kind":{"type":"notice","level":"warning","code":"runtime"},"summary":"shadowed","parent_item_id":null}"#
        );
        assert_eq!(
            wire(Event::ContentDelta { item_id: ItemId::new("i1"), text: "hel".into() }),
            r#"{"type":"content-delta","item_id":"i1","text":"hel"}"#
        );
        assert_eq!(
            wire(Event::ItemStarted {
                item_id: ItemId::new("i3"),
                kind: ItemKind::Subagent {
                    task_id: "task_1".into(),
                    subagent_type: Some("explore".into()),
                    description: None,
                },
                summary: "explore".into(),
                parent_item_id: None,
            }),
            r#"{"type":"item-started","item_id":"i3","kind":{"type":"subagent","task_id":"task_1","subagent_type":"explore","description":null},"summary":"explore","parent_item_id":null}"#
        );
    }

    #[test]
    fn request_events_wire_shape() {
        assert_eq!(
            wire(Event::RequestOpened {
                request_id: RequestId::new("r1"),
                kind: RequestKind::ToolPermission {
                    tool_name: "Write".into(),
                    input_excerpt: "{\"path\":\"a\"}".into(),
                    suggestions: vec![],
                    tool_call_id: Some("toolu_1".into()),
                },
                turn_id: Some(TurnId::new("t1")),
            }),
            r#"{"type":"request-opened","request_id":"r1","kind":{"type":"tool-permission","tool_name":"Write","input_excerpt":"{\"path\":\"a\"}","suggestions":[],"tool_call_id":"toolu_1"},"turn_id":"t1"}"#
        );
        assert_eq!(
            wire(Event::RequestOpened {
                request_id: RequestId::new("r2"),
                kind: RequestKind::UserInput {
                    prompt: "which?".into(),
                    options: vec!["a".into(), "b".into()],
                },
                turn_id: None,
            }),
            r#"{"type":"request-opened","request_id":"r2","kind":{"type":"user-input","prompt":"which?","options":["a","b"]},"turn_id":null}"#
        );
        assert_eq!(
            wire(Event::RequestResolved {
                request_id: RequestId::new("r1"),
                decision: Decision::deny("timeout"),
            }),
            r#"{"type":"request-resolved","request_id":"r1","decision":{"type":"deny","reason":"timeout","interrupt":false}}"#
        );
    }

    #[test]
    fn runtime_events_wire_shape() {
        assert_eq!(
            wire(Event::RuntimeWarning { message: "shadowed".into() }),
            r#"{"type":"runtime-warning","message":"shadowed"}"#
        );
        assert_eq!(
            wire(Event::RuntimeError { message: "boom".into(), fatal: true }),
            r#"{"type":"runtime-error","message":"boom","fatal":true}"#
        );
    }

    #[test]
    fn every_variant_round_trips() {
        for event in [
            Event::SessionStarted {
                provider_session_id: "abc".into(),
                model: "m".into(),
                cwd: PathBuf::from("/w"),
                capabilities: vec!["c".into()],
                resume_token: Some("rt".into()),
            },
            Event::SessionExited { reason: ExitReason::Crashed, exit_code: Some(9) },
            Event::TurnStarted { turn_id: TurnId::new("t1") },
            Event::TurnCompleted {
                turn_id: TurnId::new("t1"),
                stop_reason: StopReason::Error("api".into()),
                usage: Usage::default(),
                cost_usd_cumulative: 1.5,
            },
            Event::TurnAborted {
                turn_id: TurnId::new("t1"),
                reason: AbortReason::Error("eof".into()),
            },
            Event::ItemStarted {
                item_id: ItemId::new("i1"),
                kind: ItemKind::Thinking,
                summary: "s".into(),
                parent_item_id: None,
            },
            Event::ItemUpdated {
                item_id: ItemId::new("i1"),
                kind: ItemKind::UserText,
                summary: "s".into(),
                parent_item_id: Some(ItemId::new("p")),
            },
            Event::ItemCompleted {
                item_id: ItemId::new("i1"),
                kind: ItemKind::Subagent {
                    task_id: "k".into(),
                    subagent_type: None,
                    description: Some("d".into()),
                },
                summary: "s".into(),
                parent_item_id: None,
            },
            Event::ContentDelta { item_id: ItemId::new("i1"), text: "t".into() },
            Event::RequestOpened {
                request_id: RequestId::new("r1"),
                kind: RequestKind::ToolPermission {
                    tool_name: "Bash".into(),
                    input_excerpt: "{}".into(),
                    suggestions: vec![serde_json::json!({"type": "addRules"})],
                    tool_call_id: None,
                },
                turn_id: Some(TurnId::new("t1")),
            },
            Event::RequestResolved {
                request_id: RequestId::new("r1"),
                decision: Decision::allow(),
            },
            Event::SessionCompacted { trigger: CompactTrigger::Manual, pre_tokens: None },
            Event::RuntimeWarning { message: "w".into() },
            Event::RuntimeError { message: "e".into(), fatal: false },
            Event::ItemCompleted {
                item_id: ItemId::new("i2"),
                kind: ItemKind::ToolResult {
                    tool_call_id: "tu_1".into(),
                    is_error: true,
                    exit_code: Some(3),
                    interrupted: true,
                },
                summary: "s".into(),
                parent_item_id: None,
            },
            Event::ItemCompleted {
                item_id: ItemId::new("i3"),
                kind: ItemKind::Notice {
                    level: NoticeLevel::Fatal,
                    code: "runtime".into(),
                    detail: Some(serde_json::json!({"exit_code": 9})),
                },
                summary: "s".into(),
                parent_item_id: None,
            },
            Event::UsageWindows {
                status: "allowed".into(),
                windows: vec![UsageWindow {
                    name: "five_hour".into(),
                    utilization: 0.25,
                    resets_at: 1_789_068_000,
                }],
            },
        ] {
            round_trip(event);
        }
    }

    #[test]
    fn ids_are_transparent_strings() {
        assert_eq!(serde_json::to_string(&SessionId::new("s1")).expect("ser"), r#""s1""#);
        assert_eq!(SessionId::new("s1").to_string(), "s1");
        assert_eq!(TurnId::from("t").as_str(), "t");
        assert_eq!(ItemId::from("i".to_owned()).into_inner(), "i");
    }
}
