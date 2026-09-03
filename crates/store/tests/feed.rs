//! A pinned line for every `Event` variant, and what `apply` does with an envelope.

use std::path::PathBuf;
use std::time::SystemTime;

use brigadier_core::event::{
    AbortReason, CompactTrigger, Envelope, Event, ExitReason, InstanceId, ItemId, ItemKind,
    RequestId, RequestKind, SessionId, StopReason, TurnId, Usage,
};
use brigadier_core::session::Decision;
use brigadier_store::feed::{apply, kind, terse_line, FeedKind, FEED_LINE_LIMIT};
use brigadier_store::{SessionStatus, Store};

fn usage() -> Usage {
    Usage {
        input_tokens: 1_200,
        output_tokens: 340,
        cache_read_tokens: 9,
        cache_creation_tokens: 8,
        context_window: Some(200_000),
    }
}

/// Every variant of the canonical union, so a new one cannot be added without deciding here.
fn every_variant() -> Vec<(Event, Option<&'static str>)> {
    vec![
        (
            Event::SessionStarted {
                provider_session_id: "abc".into(),
                model: "claude-opus-4-8".into(),
                cwd: PathBuf::from("/w/repo"),
                capabilities: vec!["interrupt_receipt_v1".into()],
                resume_token: Some("rt".into()),
            },
            Some("session started · claude-opus-4-8 · /w/repo"),
        ),
        (
            Event::SessionExited { reason: ExitReason::Graceful, exit_code: Some(0) },
            Some("session exited · graceful · exit 0"),
        ),
        (
            Event::SessionExited { reason: ExitReason::Error("pipe closed".into()), exit_code: None },
            Some("session exited · error: pipe closed"),
        ),
        (Event::TurnStarted { turn_id: TurnId::new("t1") }, None),
        (
            Event::TurnCompleted {
                turn_id: TurnId::new("t1"),
                stop_reason: StopReason::EndTurn,
                usage: usage(),
                cost_usd_cumulative: 0.25,
            },
            Some("turn done · end-turn · 1200 in / 340 out"),
        ),
        (
            Event::TurnCompleted {
                turn_id: TurnId::new("t2"),
                stop_reason: StopReason::Other("aborted_tools".into()),
                usage: Usage::default(),
                cost_usd_cumulative: 0.0,
            },
            Some("turn done · aborted_tools · 0 in / 0 out"),
        ),
        (
            Event::TurnAborted { turn_id: TurnId::new("t1"), reason: AbortReason::Interrupted },
            Some("turn aborted · interrupted"),
        ),
        (
            Event::TurnAborted { turn_id: TurnId::new("t1"), reason: AbortReason::Killed },
            Some("turn aborted · killed"),
        ),
        (
            Event::ItemStarted {
                parent_item_id: None,
                item_id: ItemId::new("i1"),
                kind: ItemKind::ToolCall { name: "Bash".into() },
                summary: "ls -la".into(),
            },
            Some("tool Bash · ls -la"),
        ),
        (
            Event::ItemStarted {
                parent_item_id: None,
                item_id: ItemId::new("i2"),
                kind: ItemKind::AssistantText,
                summary: "here is the plan".into(),
            },
            Some("assistant · here is the plan"),
        ),
        (
            Event::ItemStarted {
                parent_item_id: None,
                item_id: ItemId::new("i3"),
                kind: ItemKind::Thinking,
                summary: "weighing options".into(),
            },
            Some("thinking · weighing options"),
        ),
        (
            Event::ItemStarted {
                parent_item_id: None,
                item_id: ItemId::new("i4"),
                kind: ItemKind::UserText,
                summary: "fix the build".into(),
            },
            Some("user · fix the build"),
        ),
        (
            Event::ItemStarted {
                parent_item_id: None,
                item_id: ItemId::new("i5"),
                kind: ItemKind::Subagent {
                    task_id: "task_1".into(),
                    subagent_type: Some("explore".into()),
                    description: None,
                },
                summary: "map the repo".into(),
            },
            Some("subagent explore · map the repo"),
        ),
        (
            Event::ItemStarted {
                parent_item_id: None,
                item_id: ItemId::new("i6"),
                kind: ItemKind::Subagent {
                    task_id: "task_2".into(),
                    subagent_type: None,
                    description: None,
                },
                summary: String::new(),
            },
            Some("subagent task_2"),
        ),
        (
            Event::ItemUpdated {
                parent_item_id: None,
                item_id: ItemId::new("i1"),
                kind: ItemKind::AssistantText,
                summary: "half a sentence".into(),
            },
            None,
        ),
        (
            Event::ItemCompleted {
                parent_item_id: None,
                item_id: ItemId::new("i1"),
                kind: ItemKind::ToolResult { tool_call_id: "tu_1".into(), is_error: false },
                summary: "12 lines".into(),
            },
            Some("tool result done · 12 lines"),
        ),
        (
            Event::ItemCompleted {
                parent_item_id: None,
                item_id: ItemId::new("i1"),
                kind: ItemKind::ToolResult { tool_call_id: "tu_1".into(), is_error: true },
                summary: "exit 1".into(),
            },
            Some("tool failed done · exit 1"),
        ),
        (Event::ContentDelta { item_id: ItemId::new("i1"), text: "hel".into() }, None),
        (
            Event::RequestOpened {
                request_id: RequestId::new("r1"),
                kind: RequestKind::ToolPermission {
                    tool_name: "Write".into(),
                    input_excerpt: r#"{"path":"/a"}"#.into(),
                    suggestions: Vec::new(),
                    tool_call_id: Some("tu_1".into()),
                },
                turn_id: Some(TurnId::new("t1")),
            },
            Some("approval asked · Write"),
        ),
        (
            Event::RequestOpened {
                request_id: RequestId::new("r2"),
                kind: RequestKind::UserInput {
                    prompt: "which branch?".into(),
                    options: vec!["main".into()],
                },
                turn_id: None,
            },
            Some("question · which branch?"),
        ),
        (
            Event::RequestResolved {
                request_id: RequestId::new("r1"),
                decision: Decision::allow(),
            },
            Some("approval allowed"),
        ),
        (
            Event::RequestResolved {
                request_id: RequestId::new("r1"),
                decision: Decision::deny("timeout"),
            },
            Some("approval denied · timeout"),
        ),
        (
            Event::SessionCompacted { trigger: CompactTrigger::Auto, pre_tokens: Some(180_000) },
            Some("context compacted · auto · 180000 tokens before"),
        ),
        (
            Event::SessionCompacted { trigger: CompactTrigger::Manual, pre_tokens: None },
            Some("context compacted · manual"),
        ),
        (
            Event::RuntimeWarning { message: "settings.json shadows the mode".into() },
            Some("warning · settings.json shadows the mode"),
        ),
        (
            Event::RuntimeError { message: "boom".into(), fatal: false },
            Some("error · boom"),
        ),
        (
            Event::RuntimeError { message: "pipe closed".into(), fatal: true },
            Some("fatal error · pipe closed"),
        ),
    ]
}

#[test]
fn terse_line_is_pinned_for_every_variant() {
    for (event, expected) in every_variant() {
        let got = terse_line(&event);
        assert_eq!(got.as_deref(), expected, "for {event:?}");
    }
}

/// No feed row carries a dollar figure. The user runs on their own subscription and is never
/// billed the number, so the row must not imply they are.
// see docs/vision.md §6 "Economics — usage windows, never dollars".
#[test]
fn no_variant_renders_a_dollar_figure() {
    for (event, _) in every_variant() {
        if let Some(line) = terse_line(&event) {
            assert!(!line.contains('$'), "{line:?} for {event:?}");
        }
    }
}

/// The wire's `k`, pinned against the event it comes from.
///
/// Exhaustiveness is the compiler's job — `feed::kind` and its `item_kind` helper match without a
/// wildcard, so a new `Event` or `ItemKind` variant fails to build until it is mapped. What this
/// pins is the *slug*, which the webview switches on and which must not drift.
#[test]
fn kind_is_pinned_for_every_variant() {
    let item = |k: ItemKind| Event::ItemStarted {
        parent_item_id: None,
        item_id: ItemId::new("i"),
        kind: k,
        summary: "s".into(),
    };
    let cases: Vec<(Event, &str)> = vec![
        (
            Event::SessionStarted {
                provider_session_id: "abc".into(),
                model: "m".into(),
                cwd: PathBuf::from("/w"),
                capabilities: vec![],
                resume_token: None,
            },
            "sys",
        ),
        (Event::SessionExited { reason: ExitReason::Graceful, exit_code: Some(0) }, "sys"),
        (
            Event::SessionCompacted { trigger: CompactTrigger::Auto, pre_tokens: None },
            "sys",
        ),
        (Event::TurnStarted { turn_id: TurnId::new("t1") }, "turn"),
        (
            Event::TurnCompleted {
                turn_id: TurnId::new("t1"),
                stop_reason: StopReason::EndTurn,
                usage: usage(),
                cost_usd_cumulative: 0.25,
            },
            "turn",
        ),
        (
            Event::TurnAborted { turn_id: TurnId::new("t1"), reason: AbortReason::Interrupted },
            "turn",
        ),
        (item(ItemKind::AssistantText), "text"),
        (item(ItemKind::Thinking), "think"),
        (item(ItemKind::ToolCall { name: "Bash".into() }), "tool"),
        (
            item(ItemKind::ToolResult { tool_call_id: "tu_1".into(), is_error: true }),
            "tool",
        ),
        (item(ItemKind::UserText), "user"),
        (
            item(ItemKind::Subagent {
                task_id: "task_1".into(),
                subagent_type: None,
                description: None,
            }),
            "sub",
        ),
        (
            Event::ItemUpdated {
                parent_item_id: None,
                item_id: ItemId::new("i"),
                kind: ItemKind::ToolCall { name: "Bash".into() },
                summary: String::new(),
            },
            "tool",
        ),
        (
            Event::ItemCompleted {
                parent_item_id: None,
                item_id: ItemId::new("i"),
                kind: ItemKind::AssistantText,
                summary: String::new(),
            },
            "text",
        ),
        (Event::ContentDelta { item_id: ItemId::new("i"), text: "he".into() }, "text"),
        (
            Event::RequestOpened {
                request_id: RequestId::new("r1"),
                kind: RequestKind::ToolPermission {
                    tool_name: "Write".into(),
                    input_excerpt: "{}".into(),
                    suggestions: Vec::new(),
                    tool_call_id: None,
                },
                turn_id: None,
            },
            "appr",
        ),
        (
            Event::RequestResolved {
                request_id: RequestId::new("r1"),
                decision: Decision::allow(),
            },
            "appr",
        ),
        (Event::RuntimeWarning { message: "w".into() }, "warn"),
        (Event::RuntimeError { message: "e".into(), fatal: true }, "err"),
    ];
    for (event, expected) in cases {
        assert_eq!(kind(&event).as_str(), expected, "for {event:?}");
        // The slug is the whole serialization; nothing else crosses the wire.
        assert_eq!(
            serde_json::to_string(&kind(&event)).expect("serialize"),
            format!("\"{expected}\""),
        );
        assert_eq!(FeedKind::from_slug(expected), kind(&event));
    }
    // A slug from a newer build degrades to `sys` rather than failing the row.
    assert_eq!(FeedKind::from_slug("something-new"), FeedKind::Sys);
}

#[test]
fn terse_line_is_bounded() {
    let long = Event::RuntimeWarning { message: "w".repeat(10_000) };
    let line = terse_line(&long).expect("a warning always gets a row");
    assert!(line.len() <= FEED_LINE_LIMIT, "{} bytes", line.len());
    assert!(line.ends_with('…'));
}

fn env(seq: u64, event: Event) -> Envelope {
    Envelope {
        seq,
        at: SystemTime::now(),
        instance_id: InstanceId::new("claude-code:work"),
        session_id: SessionId::new("s1"),
        event,
        raw: Some("{\"raw\":\"never reaches the database\"}".into()),
    }
}

#[tokio::test]
async fn apply_maps_a_session_lifetime_onto_the_store() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(dir.path()).expect("open");
    let h = store.handle();
    let id = SessionId::new("s1");

    apply(
        &env(
            1,
            Event::SessionStarted {
                provider_session_id: "prov-1".into(),
                model: "claude-opus-4-8".into(),
                cwd: PathBuf::from("/w/repo"),
                capabilities: vec![],
                resume_token: Some("rt".into()),
            },
        ),
        h,
    )
    .await;
    apply(&env(2, Event::TurnStarted { turn_id: TurnId::new("t1") }), h).await;
    apply(&env(3, Event::ContentDelta { item_id: ItemId::new("i1"), text: "he".into() }), h).await;
    apply(
        &env(
            4,
            Event::RequestOpened {
                request_id: RequestId::new("r1"),
                kind: RequestKind::ToolPermission {
                    tool_name: "Bash".into(),
                    input_excerpt: "{}".into(),
                    suggestions: Vec::new(),
                    tool_call_id: None,
                },
                turn_id: Some(TurnId::new("t1")),
            },
        ),
        h,
    )
    .await;
    apply(
        &env(
            5,
            Event::RequestResolved {
                request_id: RequestId::new("r1"),
                decision: Decision::allow(),
            },
        ),
        h,
    )
    .await;
    apply(
        &env(
            6,
            Event::TurnCompleted {
                turn_id: TurnId::new("t1"),
                stop_reason: StopReason::EndTurn,
                usage: usage(),
                cost_usd_cumulative: 0.25,
            },
        ),
        h,
    )
    .await;
    apply(
        &env(7, Event::SessionExited { reason: ExitReason::Graceful, exit_code: Some(0) }),
        h,
    )
    .await;
    h.flush().await.expect("flush");

    let row = h.session(id.clone()).await.expect("read").expect("row");
    assert_eq!(row.provider_session_id.as_deref(), Some("prov-1"));
    assert_eq!(row.model.as_deref(), Some("claude-opus-4-8"));
    assert_eq!(row.cwd, Some(PathBuf::from("/w/repo")));
    assert_eq!(row.resume_token.as_deref(), Some("rt"));
    assert_eq!(row.instance_id.map(|i| i.into_inner()).as_deref(), Some("claude-code:work"));
    assert_eq!(row.status, SessionStatus::Exited);
    assert_eq!(row.exit_code, Some(0));
    assert_eq!(row.usage, usage());
    assert_eq!(row.cost_usd_cumulative, 0.25);
    assert_eq!(row.last_event_seq, 7);
    let summary = row.summary_json.expect("a derived summary");
    assert!(summary.contains("\"last_turn_id\":\"t1\""), "{summary}");
    assert!(summary.contains("\"last_stop_reason\":\"end-turn\""), "{summary}");

    // The turn start and the delta wrote no row at all; five events did.
    let tail = h.feed_tail(id.clone(), 100).await.expect("tail");
    let lines: Vec<String> = tail.iter().map(|r| r.line.clone()).collect();
    assert_eq!(
        lines,
        vec![
            "session started · claude-opus-4-8 · /w/repo",
            "approval asked · Bash",
            "approval allowed",
            // No dollar figure: docs/vision.md §6. The stored `cost_usd_cumulative` above is
            // still 0.25 — the field survives, only the row drops it.
            "turn done · end-turn · 1200 in / 340 out",
            "session exited · graceful · exit 0",
        ]
    );
    // The kind survives the round trip through SQLite, so a replayed row carries the same `k`
    // the live row did.
    assert_eq!(
        tail.iter().map(|r| r.kind).collect::<Vec<_>>(),
        vec![FeedKind::Sys, FeedKind::Appr, FeedKind::Appr, FeedKind::Turn, FeedKind::Sys],
    );
    for line in &lines {
        assert!(!line.contains("never reaches the database"), "raw traffic leaked: {line}");
    }

    let approvals = h.approvals(id).await.expect("approvals");
    assert_eq!(approvals.len(), 1);
    assert!(approvals[0].resolved_at.is_some());
    store.close().await.expect("close");
}
