//! A pinned line for every `Event` variant, and what `apply` does with an envelope.

use std::path::PathBuf;
use std::time::SystemTime;

use brigadier_core::event::{
    AbortReason, CompactTrigger, Envelope, Event, ExitReason, InstanceId, ItemId, ItemKind,
    NoticeLevel, RequestId, RequestKind, SessionId, StopReason, TurnId, Usage, UsageWindow,
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
            Event::SessionExited {
                reason: ExitReason::Error("pipe closed".into()),
                exit_code: None,
            },
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
                kind: ItemKind::ToolResult {
                    tool_call_id: "tu_1".into(),
                    is_error: false,
                    exit_code: None,
                    interrupted: false,
                },
                summary: "12 lines".into(),
            },
            Some("tool result done · 12 lines"),
        ),
        (
            Event::ItemCompleted {
                parent_item_id: None,
                item_id: ItemId::new("i1"),
                kind: ItemKind::ToolResult {
                    tool_call_id: "tu_1".into(),
                    is_error: true,
                    exit_code: Some(3),
                    interrupted: false,
                },
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
            // The real capture's numbers: `s11-auto-compaction.ndjson:49`, CLI 2.1.268.
            Event::SessionCompacted {
                trigger: CompactTrigger::Auto,
                pre_tokens: Some(70_633),
                post_tokens: Some(1_379),
                cumulative_dropped_tokens: Some(69_254),
                duration_ms: Some(12_262),
            },
            Some("context compacted · auto · 70633 → 1379 tokens · 12.3 s"),
        ),
        (
            // A provider that reports only `pre_tokens` keeps the older line verbatim.
            Event::SessionCompacted {
                trigger: CompactTrigger::Auto,
                pre_tokens: Some(180_000),
                post_tokens: None,
                cumulative_dropped_tokens: None,
                duration_ms: None,
            },
            Some("context compacted · auto · 180000 tokens before"),
        ),
        (
            Event::SessionCompacted {
                trigger: CompactTrigger::Manual,
                pre_tokens: None,
                post_tokens: None,
                cumulative_dropped_tokens: None,
                duration_ms: None,
            },
            Some("context compacted · manual"),
        ),
        // A live phase carries no row, the way `usage-windows` carries none.
        (Event::SessionCompacting, None),
        (
            Event::SessionCompactFailed { error: Some("too_few_groups".into()) },
            Some("context compaction failed · too_few_groups"),
        ),
        (Event::SessionCompactFailed { error: None }, Some("context compaction failed")),
        (
            Event::RuntimeWarning { message: "settings.json shadows the mode".into() },
            Some("warning · settings.json shadows the mode"),
        ),
        (Event::RuntimeError { message: "boom".into(), fatal: false }, Some("error · boom")),
        (
            Event::RuntimeError { message: "pipe closed".into(), fatal: true },
            Some("fatal error · pipe closed"),
        ),
        // No row: it arrives once a turn, it is delivered as a signal, and the gauge draws it.
        // Also the reason `no_variant_renders_a_dollar_figure` has nothing to catch here — the
        // variant carries no cost field at all.
        (
            Event::UsageWindows {
                status: "allowed".into(),
                windows: vec![
                    UsageWindow {
                        name: "five_hour".into(),
                        utilization: 0.25,
                        resets_at: 1_789_068_000,
                    },
                    UsageWindow {
                        name: "seven_day".into(),
                        utilization: 0.16,
                        resets_at: 1_789_556_400,
                    },
                ],
            },
            None,
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

/// The wire `type` string for one event, as the durable NDJSON carries it.
fn wire_type(event: &Event) -> String {
    serde_json::to_value(event).expect("event serialises")["type"]
        .as_str()
        .expect("the union is internally tagged")
        .to_owned()
}

/// One `NAME = {"a", "b"}` set literal, read out of the burn harness.
fn harness_set(name: &str) -> std::collections::BTreeSet<String> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/measure-native-burn.py");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let anchor = text
        .find(&format!("\n{name} = {{"))
        .unwrap_or_else(|| panic!("no {name} literal in {}", path.display()));
    let open = anchor + text[anchor..].find('{').expect("open brace");
    let close = open + text[open..].find('}').expect("close brace");
    text[open + 1..close]
        .split(',')
        .map(|s| s.trim().trim_matches('"').to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

/// The burn harness derives the producer's row count from the durable event stream, by excluding
/// the event types that carry no feed row. That exclusion list is a literal in Python and cannot
/// be checked by the compiler, so it is checked here instead.
///
/// **[measured]** the cost of it drifting: `docs/performance/codex-thread-burn-2026-09-11.md` §5
/// reports an 11.18% row-delivery deficit on this branch. 12,143 of those 12,210 rows are
/// `usage-windows` envelopes the harness counted as rows while `terse_line` returns `None` for
/// them; the remaining 67 are the batcher's own reported `rows_dropped`. No row was lost.
#[test]
fn the_burn_harness_row_rule_matches_terse_line() {
    let expected: std::collections::BTreeSet<String> = every_variant()
        .iter()
        .filter(|(event, _)| terse_line(event).is_none())
        .map(|(event, _)| wire_type(event))
        .collect();
    assert_eq!(harness_set("NON_ROW_EVENT_TYPES"), expected);
}

/// The same, for the harness's "has the mounted transcript reached the final item?" clause: it
/// takes the durable maximum over the event types that can carry a chat item's seq. Miss one and
/// the durable maximum sits *below* what the UI legitimately holds, which the harness then reports
/// as a transcript that never received its final item sequence.
#[test]
fn the_burn_harness_item_seq_rule_matches_chat_project() {
    let mut expected: std::collections::BTreeSet<String> = every_variant()
        .iter()
        .filter(|(event, _)| brigadier_store::chat::project(&env(1, event.clone())).is_some())
        .map(|(event, _)| wire_type(event))
        .collect();
    // `chat::append_delta` moves an existing item's seq to the delta's, so a delta can carry the
    // transcript's maximum even though it projects to no item of its own.
    expected.insert("content-delta".to_owned());
    assert_eq!(harness_set("CHAT_ITEM_EVENT_TYPES"), expected);
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
            Event::SessionCompacted {
                trigger: CompactTrigger::Auto,
                pre_tokens: None,
                post_tokens: None,
                cumulative_dropped_tokens: None,
                duration_ms: None,
            },
            "sys",
        ),
        (Event::SessionCompacting, "sys"),
        // A compaction the provider abandoned is a warning: the session ran on.
        (Event::SessionCompactFailed { error: Some("too_few_groups".into()) }, "warn"),
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
            item(ItemKind::ToolResult {
                tool_call_id: "tu_1".into(),
                is_error: true,
                exit_code: Some(3),
                interrupted: false,
            }),
            "tool",
        ),
        (
            item(ItemKind::Notice {
                level: NoticeLevel::Info,
                code: "compacted".into(),
                detail: None,
            }),
            "sys",
        ),
        (
            item(ItemKind::Notice {
                level: NoticeLevel::Warning,
                code: "runtime".into(),
                detail: None,
            }),
            "warn",
        ),
        (
            item(ItemKind::Notice {
                level: NoticeLevel::Error,
                code: "runtime".into(),
                detail: None,
            }),
            "err",
        ),
        (
            item(ItemKind::Notice {
                level: NoticeLevel::Fatal,
                code: "runtime".into(),
                detail: None,
            }),
            "err",
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
    let cases_covered: Vec<&str> = cases.iter().map(|(_, k)| *k).collect();
    for (event, expected) in cases {
        assert_eq!(kind(&event).as_str(), expected, "for {event:?}");
        // The slug is the whole serialization; nothing else crosses the wire.
        assert_eq!(
            serde_json::to_string(&kind(&event)).expect("serialize"),
            format!("\"{expected}\""),
        );
        assert_eq!(FeedKind::from_slug(expected), kind(&event));
    }
    // `kind` never produces `unknown`: every event has a class.
    assert!(
        !cases_covered.contains(&"unknown"),
        "`unknown` is for rows whose kind was never recorded, not for any event",
    );
    // A slug this build does not know degrades to `unknown` — never to `sys`, which is a real
    // class of its own, and never to an error that would lose the row.
    assert_eq!(FeedKind::from_slug("something-new"), FeedKind::Unknown);
    assert_eq!(FeedKind::from_slug(""), FeedKind::Unknown);
    assert_eq!(FeedKind::from_slug("sys"), FeedKind::Sys);
    assert_eq!(FeedKind::Unknown.as_str(), "unknown");
    assert_eq!(FeedKind::from_slug("unknown"), FeedKind::Unknown);
    // The default is `unknown`, so a row built without one claims no class rather than claiming
    // to be session housekeeping. This is what migration 1's column default rests on.
    assert_eq!(FeedKind::default(), FeedKind::Unknown);
}

#[test]
fn terse_line_is_bounded() {
    let long = Event::RuntimeWarning { message: "w".repeat(10_000) };
    let line = terse_line(&long).expect("a warning always gets a row");
    assert!(line.len() <= FEED_LINE_LIMIT, "{} bytes", line.len());
    assert!(line.ends_with('…'));
}

/// Four lifecycle events become four notice items with deterministic ids; nothing else does.
///
/// The ids carry the seq, so a replay of the same envelope upserts the same row rather than
/// appending a second one, and two warnings in one session stay two notices.
// see docs/plans/codex-thread-rebuild-2026-09-11.md §4.4.
#[test]
fn lifecycle_events_project_to_notices_with_deterministic_ids() {
    let cases: Vec<(Event, &str, NoticeLevel, &str, &str)> = vec![
        (
            Event::SessionCompacted {
                trigger: CompactTrigger::Auto,
                pre_tokens: Some(180_000),
                post_tokens: None,
                cumulative_dropped_tokens: None,
                duration_ms: None,
            },
            "s1:notice:compacted:7",
            NoticeLevel::Info,
            "compacted",
            "auto",
        ),
        (
            Event::SessionCompactFailed { error: Some("too_few_groups".into()) },
            "s1:notice:compact-failed:7",
            NoticeLevel::Warning,
            "compact-failed",
            "Context compaction failed: too_few_groups",
        ),
        (
            Event::RuntimeWarning { message: "settings.json shadows the mode".into() },
            "s1:notice:warning:7",
            NoticeLevel::Warning,
            "runtime",
            "settings.json shadows the mode",
        ),
        (
            Event::RuntimeError { message: "boom".into(), fatal: false },
            "s1:notice:error:7",
            NoticeLevel::Error,
            "runtime",
            "boom",
        ),
        (
            Event::RuntimeError { message: "pipe closed".into(), fatal: true },
            "s1:notice:error:7",
            NoticeLevel::Fatal,
            "runtime",
            "pipe closed",
        ),
        (
            Event::SessionExited { reason: ExitReason::Crashed, exit_code: Some(9) },
            "s1:notice:exited:7",
            NoticeLevel::Info,
            "exited",
            "crashed",
        ),
    ];
    for (event, id, level, code, body) in cases {
        let envelope = env(7, event.clone());
        let item = brigadier_store::chat::project(&envelope)
            .unwrap_or_else(|| panic!("a notice for {event:?}"));
        assert_eq!(item.id, id);
        assert_eq!(item.body, body);
        assert_eq!(item.parent_id, None);
        assert_eq!(item.provider_uuid, None, "synthetic, so no provider uuid");
        match item.kind {
            ItemKind::Notice { level: got_level, code: ref got_code, .. } => {
                assert_eq!(got_level, level);
                assert_eq!(got_code, code);
            }
            other => panic!("{other:?} is not a notice"),
        }
        // Deterministic: the same envelope projects to the same id, so a replay upserts.
        assert_eq!(brigadier_store::chat::project(&envelope).expect("again").id, id);
    }
    // `session-started` deliberately gets none: `system/init` is re-emitted every turn, so a
    // notice per init would be a notice per turn.
    assert!(brigadier_store::chat::project(&env(
        8,
        Event::SessionStarted {
            provider_session_id: "abc".into(),
            model: "m".into(),
            cwd: PathBuf::from("/w"),
            capabilities: vec![],
            resume_token: None,
        }
    ))
    .is_none());
    // Neither does a turn boundary, a delta, or the usage gauge.
    assert!(brigadier_store::chat::project(&env(9, Event::TurnStarted { turn_id: TurnId::new("t") })).is_none());
    assert!(brigadier_store::chat::project(&env(
        10,
        Event::UsageWindows { status: "allowed".into(), windows: vec![] }
    ))
    .is_none());
}

/// The compaction and exit notices carry their number in `detail`, not in the body text.
#[test]
fn notice_detail_carries_the_numbers_the_row_renders() {
    let compacted = brigadier_store::chat::project(&env(
        3,
        Event::SessionCompacted {
            trigger: CompactTrigger::Manual,
            pre_tokens: Some(180_000),
            post_tokens: None,
            cumulative_dropped_tokens: None,
            duration_ms: None,
        },
    ))
    .expect("notice");
    let ItemKind::Notice { detail, .. } = compacted.kind else { panic!("not a notice") };
    assert_eq!(detail, Some(serde_json::json!({"pre_tokens": 180_000})));

    // The real capture's boundary, whole: every number the provider sent, none invented.
    // see crates/claude-spike/fixtures/s11-auto-compaction.ndjson:49, CLI 2.1.268.
    let full = brigadier_store::chat::project(&env(
        4,
        Event::SessionCompacted {
            trigger: CompactTrigger::Auto,
            pre_tokens: Some(70_633),
            post_tokens: Some(1_379),
            cumulative_dropped_tokens: Some(69_254),
            duration_ms: Some(12_262),
        },
    ))
    .expect("notice");
    let ItemKind::Notice { detail, .. } = full.kind else { panic!("not a notice") };
    assert_eq!(
        detail,
        Some(serde_json::json!({
            "pre_tokens": 70_633,
            "post_tokens": 1_379,
            "cumulative_dropped_tokens": 69_254,
            "duration_ms": 12_262,
        }))
    );

    let failed =
        brigadier_store::chat::project(&env(5, Event::SessionCompactFailed { error: Some("too_few_groups".into()) }))
            .expect("notice");
    let ItemKind::Notice { detail, .. } = failed.kind else { panic!("not a notice") };
    assert_eq!(detail, Some(serde_json::json!({"error": "too_few_groups"})));

    // A live phase is not a transcript row at all.
    assert!(brigadier_store::chat::project(&env(6, Event::SessionCompacting)).is_none());

    let exited = brigadier_store::chat::project(&env(
        4,
        Event::SessionExited { reason: ExitReason::Graceful, exit_code: Some(0) },
    ))
    .expect("notice");
    let ItemKind::Notice { detail, .. } = exited.kind else { panic!("not a notice") };
    assert_eq!(detail, Some(serde_json::json!({"exit_code": 0})));

    // No exit code observed: the key is absent rather than a fabricated zero.
    let killed = brigadier_store::chat::project(&env(
        5,
        Event::SessionExited { reason: ExitReason::Killed, exit_code: None },
    ))
    .expect("notice");
    let ItemKind::Notice { detail, .. } = killed.kind else { panic!("not a notice") };
    assert_eq!(detail, None);
}

fn env(seq: u64, event: Event) -> Envelope {
    Envelope {
        seq,
        at: SystemTime::now(),
        instance_id: InstanceId::new("claude-code:work"),
        session_id: SessionId::new("s1"),
        event,
        raw: Some("{\"raw\":\"never reaches the database\"}".into()),
        body: None,
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
    apply(&env(7, Event::SessionExited { reason: ExitReason::Graceful, exit_code: Some(0) }), h)
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

#[tokio::test]
async fn chat_body_survives_reopen_independently_of_terse_feed() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let h = store.handle();
    let body = "First paragraph.\n\n```rust\nfn main() {}\n```";
    let item = env(1, Event::item_completed(
        ItemId::new("assistant-1"), ItemKind::AssistantText, "First paragraph.", None,
    )).with_body(body);
    apply(&item, h).await;
    assert_eq!(h.chat_items("s1".into(), 0).await.unwrap()[0].body, body);
    assert_eq!(h.session(SessionId::new("s1")).await.unwrap().unwrap().last_event_seq, 1);
    store.close().await.unwrap();
    let reopened = Store::open(dir.path()).unwrap();
    assert_eq!(reopened.handle().chat_items("s1".into(), 0).await.unwrap()[0].body, body);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn conversation_turn_timing_survives_reopen_and_terminal_replay() {
    use std::time::{Duration, UNIX_EPOCH};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let h = store.handle();
    let mut start = env(1, Event::TurnStarted { turn_id: TurnId::new("timed") });
    start.at = UNIX_EPOCH + Duration::from_millis(1000);
    apply(&start, h).await;
    let live = h.chat_turns("s1".into()).await.unwrap();
    assert_eq!(live[0].started_at, 1000);
    assert_eq!(live[0].status, "running");
    assert_eq!(live[0].ended_at, None);
    let mut end = env(9, Event::TurnCompleted { turn_id: TurnId::new("timed"), stop_reason: StopReason::EndTurn, usage: usage(), cost_usd_cumulative: 0.0 });
    end.at = UNIX_EPOCH + Duration::from_millis(135000);
    apply(&end, h).await;
    apply(&start, h).await;
    apply(&env(10, Event::SessionExited { reason: ExitReason::Graceful, exit_code: Some(0) }), h).await;
    store.close().await.unwrap();
    let store = Store::open(dir.path()).unwrap();
    let rows = store.handle().chat_turns("s1".into()).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].start_seq, 1);
    assert_eq!(rows[0].end_seq, Some(9));
    assert_eq!(rows[0].ended_at, Some(135000));
    assert_eq!(rows[0].status, "completed");
    store.close().await.unwrap();
}

#[tokio::test]
async fn conversation_turn_outcomes_do_not_invent_missing_starts() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let h = store.handle();
    apply(&env(1, Event::TurnAborted { turn_id: TurnId::new("missing"), reason: AbortReason::Interrupted }), h).await;
    assert!(h.chat_turns("s1".into()).await.unwrap().is_empty());
    for (index, reason, status) in [(0, AbortReason::Interrupted, "interrupted"), (1, AbortReason::Error("disconnected".into()), "failed")] {
        let id = TurnId::new(format!("t{index}"));
        apply(&env(2 + index * 2, Event::TurnStarted { turn_id: id.clone() }), h).await;
        apply(&env(3 + index * 2, Event::TurnAborted { turn_id: id, reason }), h).await;
        assert_eq!(h.chat_turns("s1".into()).await.unwrap()[0].status, status);
    }
    apply(&env(7, Event::TurnStarted { turn_id: TurnId::new("exit") }), h).await;
    apply(&env(8, Event::SessionExited { reason: ExitReason::Graceful, exit_code: Some(0) }), h).await;
    assert_eq!(h.chat_turns("s1".into()).await.unwrap()[0].status, "interrupted");
    store.close().await.unwrap();
}
