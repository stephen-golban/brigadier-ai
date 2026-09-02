//! Decode / encode tests, over two fixture sets.
//!
//! `tests/fixtures/` is hand-written: one NDJSON line per variant, preceded by a `//` header
//! comment naming the `sdk.d.ts` or `sdk.mjs` line it was transcribed from (JSON has no comments,
//! so [`load`] strips leading `//` lines before decoding). It is a *checklist* — one fixture per
//! arm, transcribed, not observed.
//!
//! `crates/claude-spike/fixtures/*.ndjson` is the real thing: raw taps of CLI 2.1.257. The tests
//! at the bottom of this file run every line of it through [`decode_line`] and back out through
//! [`encode_line`]. For `system/init`, `result` and `can_use_tool` those captures are the evidence
//! and the hand-written fixtures are only a convenience.

use std::collections::BTreeMap;
use std::path::PathBuf;

use claude_wire::control::{
    ControlRequestBody, ControlRequestKnown, ControlResponseBody, InitializeRequest,
    InterruptRequest, SetModelRequest,
};
use claude_wire::message::{
    CliMessage, ContentBlock, ContentBlockKnown, KnownMessage, MessageContent, ResultMessage,
    SystemMessage,
};
use claude_wire::{
    decode_line, encode_line, ControlRequest, ControlResponse, HookJsonOutput, Inbound,
    PermissionResult, SdkUserMessage,
};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Reads a fixture, dropping the `//` header comment lines.
fn load(name: &str) -> Vec<u8> {
    let raw = std::fs::read_to_string(fixture_dir().join(name))
        .unwrap_or_else(|e| panic!("fixture {name}: {e}"));
    raw.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
        .into_bytes()
}

fn fixture_names() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(fixture_dir())
        .expect("fixtures dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    names
}

/// A stable label for what a line decoded into, down to the arm that actually matched.
///
/// The point is to catch *silent demotion*: because the unknown-tolerant arms are
/// `#[serde(untagged)]`, a typo in a field type would quietly turn `system/init` into
/// `system/other` rather than failing a test.
fn classify(inbound: &Inbound) -> String {
    match inbound {
        Inbound::Message(CliMessage::Unknown(_)) => "message/unknown".into(),
        Inbound::Message(CliMessage::Known(known)) => match known.as_ref() {
            KnownMessage::System(system) => match system {
                SystemMessage::Init(_) => "system/init".into(),
                SystemMessage::CompactBoundary(_) => "system/compact_boundary".into(),
                SystemMessage::Hook(hook) => format!("system/hook:{:?}", hook.subtype),
                SystemMessage::Status(_) => "system/status".into(),
                SystemMessage::PermissionDenied(_) => "system/permission_denied".into(),
                SystemMessage::Other(other) => format!("system/other:{}", other.subtype),
            },
            KnownMessage::Assistant(_) => "assistant".into(),
            KnownMessage::User(_) => "user".into(),
            KnownMessage::Result(result) => match result {
                ResultMessage::Success(_) => "result/success".into(),
                ResultMessage::Error(err) => format!("result/error:{:?}", err.subtype),
                ResultMessage::Other(other) => format!("result/other:{}", other.subtype),
            },
            KnownMessage::StreamEvent(_) => "stream_event".into(),
            KnownMessage::ToolProgress(_) => "tool_progress".into(),
            KnownMessage::ToolUseSummary(_) => "tool_use_summary".into(),
            KnownMessage::AuthStatus(_) => "auth_status".into(),
            KnownMessage::PromptSuggestion(_) => "prompt_suggestion".into(),
            KnownMessage::RateLimitEvent(_) => "rate_limit_event".into(),
            KnownMessage::ConversationReset(_) => "conversation_reset".into(),
            KnownMessage::ActiveGoal(_) => "active_goal".into(),
            KnownMessage::KeepAlive(_) => "keep_alive".into(),
            KnownMessage::TranscriptMirror(_) => "transcript_mirror".into(),
        },
        Inbound::ControlRequest(request) => match &request.request {
            ControlRequestBody::Unknown(unknown) => format!("control_request/other:{}", unknown.subtype),
            ControlRequestBody::Known(known) => {
                let name = match known.as_ref() {
                    ControlRequestKnown::CanUseTool(_) => "can_use_tool",
                    ControlRequestKnown::HookCallback(_) => "hook_callback",
                    ControlRequestKnown::McpMessage(_) => "mcp_message",
                    ControlRequestKnown::Elicitation(_) => "elicitation",
                    ControlRequestKnown::RequestUserDialog(_) => "request_user_dialog",
                    ControlRequestKnown::OauthTokenRefresh(_) => "oauth_token_refresh",
                    ControlRequestKnown::HostAuthTokenRefresh(_) => "host_auth_token_refresh",
                    ControlRequestKnown::RemoteControlWorkSecret(_) => "remote_control_work_secret",
                    ControlRequestKnown::Initialize(_) => "initialize",
                    ControlRequestKnown::Interrupt(_) => "interrupt",
                    ControlRequestKnown::SetPermissionMode(_) => "set_permission_mode",
                    ControlRequestKnown::SetModel(_) => "set_model",
                };
                format!("control_request/{name}")
            }
        },
        Inbound::ControlResponse(response) => match &response.response {
            ControlResponseBody::Success { .. } => "control_response/success".into(),
            ControlResponseBody::Error { .. } => "control_response/error".into(),
            ControlResponseBody::Unknown(_) => "control_response/unknown".into(),
        },
        Inbound::ControlCancel(_) => "control_cancel_request".into(),
        Inbound::Unknown(_) => "inbound/unknown".into(),
    }
}

/// Every fixture must land on the arm it was written for. This is the "one fixture per variant"
/// checklist; a new fixture with no entry here fails the test.
fn expected() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        ("active_goal.json", "active_goal"),
        ("assistant.json", "assistant"),
        ("auth_status.json", "auth_status"),
        ("control_can_use_tool.json", "control_request/can_use_tool"),
        ("control_cancel_request.json", "control_cancel_request"),
        ("control_elicitation.json", "control_request/elicitation"),
        ("control_hook_callback.json", "control_request/hook_callback"),
        (
            "control_host_auth_token_refresh.json",
            "control_request/host_auth_token_refresh",
        ),
        ("control_initialize.json", "control_request/initialize"),
        ("control_interrupt.json", "control_request/interrupt"),
        ("control_mcp_message.json", "control_request/mcp_message"),
        (
            "control_oauth_token_refresh.json",
            "control_request/oauth_token_refresh",
        ),
        (
            "control_remote_control_work_secret.json",
            "control_request/remote_control_work_secret",
        ),
        (
            "control_request_user_dialog.json",
            "control_request/request_user_dialog",
        ),
        ("control_response_error.json", "control_response/error"),
        ("control_response_success.json", "control_response/success"),
        ("control_set_model.json", "control_request/set_model"),
        (
            "control_set_permission_mode.json",
            "control_request/set_permission_mode",
        ),
        (
            "control_unknown_subtype.json",
            "control_request/other:claude_authenticate",
        ),
        ("conversation_reset.json", "conversation_reset"),
        ("keep_alive.json", "keep_alive"),
        ("prompt_suggestion.json", "prompt_suggestion"),
        ("rate_limit_event.json", "rate_limit_event"),
        ("result_error_max_turns.json", "result/error:ErrorMaxTurns"),
        ("result_success.json", "result/success"),
        (
            "result_unknown_subtype.json",
            "result/other:error_quota_exhausted_v2",
        ),
        ("stream_event.json", "stream_event"),
        ("system_compact_boundary.json", "system/compact_boundary"),
        ("system_hook_response.json", "system/hook:Response"),
        ("system_hook_started.json", "system/hook:Started"),
        ("system_init.json", "system/init"),
        ("system_other_task_started.json", "system/other:task_started"),
        ("system_permission_denied.json", "system/permission_denied"),
        ("system_status.json", "system/status"),
        ("tool_progress.json", "tool_progress"),
        ("tool_use_summary.json", "tool_use_summary"),
        ("transcript_mirror.json", "transcript_mirror"),
        ("unknown_type.json", "message/unknown"),
        ("user_text.json", "user"),
        ("user_tool_result.json", "user"),
    ])
}

#[test]
fn every_fixture_lands_on_its_expected_variant() {
    let table = expected();
    for name in fixture_names() {
        let decoded = decode_line(&load(&name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        let want = table
            .get(name.as_str())
            .unwrap_or_else(|| panic!("{name}: fixture has no entry in expected()"));
        assert_eq!(&classify(&decoded), want, "{name} decoded to the wrong arm");
    }
    assert_eq!(table.len(), fixture_names().len(), "expected() is stale");
}

#[test]
fn every_fixture_round_trips() {
    for name in fixture_names() {
        let line = load(&name);
        let first = decode_line(&line).unwrap_or_else(|e| panic!("{name}: {e}"));
        let encoded = encode_line(&first).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(encoded.ends_with(b"\n"), "{name}: encode_line lost the \\n");
        let second = decode_line(&encoded).unwrap_or_else(|e| panic!("{name} re-decode: {e}"));
        assert_eq!(first, second, "{name} did not survive decode/encode/decode");
    }
}

#[test]
fn unknown_type_and_unknown_fields_survive_verbatim() {
    // An unmodelled top-level `type` keeps the whole object.
    let line = load("unknown_type.json");
    let original: serde_json::Value = serde_json::from_slice(&line).unwrap();
    let Inbound::Message(CliMessage::Unknown(kept)) = decode_line(&line).unwrap() else {
        panic!("expected CliMessage::Unknown");
    };
    assert_eq!(kept, original);

    // An unmodelled field on a *modelled* type survives via `#[serde(flatten)] extra`.
    let line = load("system_init.json");
    let Inbound::Message(CliMessage::Known(known)) = decode_line(&line).unwrap() else {
        panic!("expected a known message");
    };
    let KnownMessage::System(SystemMessage::Init(init)) = known.as_ref() else {
        panic!("expected system/init");
    };
    assert_eq!(init.capabilities.as_deref().unwrap()[0], "interrupt_receipt_v1");
    assert_eq!(init.permission_mode.as_deref(), Some("default"));
    assert_eq!(init.api_key_source.as_deref(), Some("oauth"));
    assert_eq!(init.claude_code_version.as_deref(), Some("2.1.257"));
    let unknown = init.extra.get("future_field_from_a_later_cli").unwrap();
    assert_eq!(unknown["nested"], serde_json::json!([1, 2, 3]));

    // And it is still there after a round trip.
    let re = serde_json::to_value(decode_line(&line).unwrap()).unwrap();
    assert_eq!(re["future_field_from_a_later_cli"]["nested"], serde_json::json!([1, 2, 3]));
}

#[test]
fn decode_line_trims_lf_and_crlf_and_rejects_blanks() {
    let bare = load("keep_alive.json");
    let bare = bare.strip_suffix(b"\n").unwrap_or(&bare).to_vec();

    let mut lf = bare.clone();
    lf.push(b'\n');
    let mut crlf = bare.clone();
    crlf.extend_from_slice(b"\r\n");

    let want = decode_line(&bare).unwrap();
    assert_eq!(decode_line(&lf).unwrap(), want);
    assert_eq!(decode_line(&crlf).unwrap(), want);

    for blank in [&b""[..], b"\n", b"\r\n", b"   \t "] {
        assert!(
            matches!(decode_line(blank), Err(claude_wire::DecodeError::EmptyLine)),
            "blank line {blank:?} should be DecodeError::EmptyLine"
        );
    }
    assert!(matches!(
        decode_line(b"{not json}\n"),
        Err(claude_wire::DecodeError::Json(_))
    ));
    // A non-object line is tolerated, not an error.
    assert!(matches!(decode_line(b"42\n").unwrap(), Inbound::Unknown(_)));
}

#[test]
fn assistant_content_blocks_decode_and_unknown_blocks_survive() {
    let Inbound::Message(CliMessage::Known(known)) =
        decode_line(&load("assistant.json")).unwrap()
    else {
        panic!("expected a known message");
    };
    let KnownMessage::Assistant(assistant) = known.as_ref() else {
        panic!("expected assistant");
    };
    assert_eq!(assistant.aborted, Some(true));
    assert_eq!(assistant.supersedes.as_deref().unwrap().len(), 1);
    let MessageContent::Blocks(blocks) = &assistant.message.content else {
        panic!("expected block content");
    };
    assert_eq!(blocks.len(), 5);
    assert!(matches!(
        blocks[0],
        ContentBlock::Known(ContentBlockKnown::Thinking { .. })
    ));
    assert!(matches!(
        blocks[1],
        ContentBlock::Known(ContentBlockKnown::RedactedThinking { .. })
    ));
    assert!(matches!(
        blocks[2],
        ContentBlock::Known(ContentBlockKnown::Text { .. })
    ));
    let ContentBlock::Known(ContentBlockKnown::ToolUse { id, name, .. }) = &blocks[3] else {
        panic!("expected tool_use");
    };
    assert_eq!((id.as_str(), name.as_str()), ("toolu_01", "Bash"));
    // `server_tool_use` is not modelled and must survive as a raw value.
    let ContentBlock::Unknown(raw) = &blocks[4] else {
        panic!("expected an unknown block");
    };
    assert_eq!(raw["type"], "server_tool_use");

    // tool_result blocks ride on `user` frames.
    let Inbound::Message(CliMessage::Known(known)) =
        decode_line(&load("user_tool_result.json")).unwrap()
    else {
        panic!("expected a known message");
    };
    let KnownMessage::User(user) = known.as_ref() else {
        panic!("expected user");
    };
    assert_eq!(user.is_replay, Some(true));
    let MessageContent::Blocks(blocks) = &user.message.content else {
        panic!("expected block content");
    };
    assert!(matches!(
        blocks[0],
        ContentBlock::Known(ContentBlockKnown::ToolResult { .. })
    ));
}

#[test]
fn result_success_keeps_the_cumulative_accounting_fields() {
    let Inbound::Message(CliMessage::Known(known)) =
        decode_line(&load("result_success.json")).unwrap()
    else {
        panic!("expected a known message");
    };
    let KnownMessage::Result(ResultMessage::Success(result)) = known.as_ref() else {
        panic!("expected result/success");
    };
    assert_eq!(result.total_cost_usd, Some(0.4213));
    assert_eq!(result.terminal_reason.as_deref(), Some("completed"));
    assert_eq!(result.num_turns, Some(3));
    assert_eq!(result.permission_denials.as_ref().unwrap()[0].tool_name, "Bash");
    // camelCase on the wire, snake_case in Rust.
    let model_usage = result.model_usage.as_ref().unwrap();
    assert_eq!(model_usage["claude-opus-4-6"]["costUSD"], 0.4213);
}

#[test]
fn can_use_tool_request_exposes_the_fields_the_approval_park_needs() {
    let Inbound::ControlRequest(request) = decode_line(&load("control_can_use_tool.json")).unwrap()
    else {
        panic!("expected a control request");
    };
    assert_eq!(request.request_id, "q1w2e3r4t5y");
    let ControlRequestBody::Known(known) = &request.request else {
        panic!("expected a known subtype");
    };
    let ControlRequestKnown::CanUseTool(ask) = known.as_ref() else {
        panic!("expected can_use_tool");
    };
    assert_eq!(ask.tool_name, "Bash");
    assert_eq!(ask.input["command"], "rm -rf build");
    assert_eq!(ask.tool_use_id.as_deref(), Some("toolu_01"));
    assert_eq!(ask.agent_id.as_deref(), Some("agent_7"));
    assert!(ask.blocked_path.as_deref().unwrap().ends_with("/build"));
    assert_eq!(ask.decision_reason_type.as_deref(), Some("safetyCheck"));
    assert!(ask.permission_suggestions.is_some());
    // Not typed, but kept.
    assert_eq!(ask.extra["classifier_approvable"], false);
    assert_eq!(ask.extra["matched_ask_rule"]["source"], "projectSettings");
}

#[test]
fn initialize_carries_all_twenty_fields_sdk_mjs_sends() {
    let Inbound::ControlRequest(request) = decode_line(&load("control_initialize.json")).unwrap()
    else {
        panic!("expected a control request");
    };
    let ControlRequestBody::Known(known) = &request.request else {
        panic!("expected a known subtype");
    };
    let ControlRequestKnown::Initialize(init) = known.as_ref() else {
        panic!("expected initialize");
    };
    // The two fields sdk.mjs sends and sdk.d.ts:3915-3970 does not declare.
    assert_eq!(
        init.append_subagent_system_prompt.as_deref(),
        Some("Subagents: be terse.")
    );
    assert!(init.web_search_isolation_exempt_mcp_servers.is_some());
    assert_eq!(init.hooks.as_ref().unwrap()["PreToolUse"][0]["hookCallbackIds"][0], "hook_0");
    assert_eq!(init.per_task_stop_affordance, Some(true));
    assert_eq!(init.supported_dialog_kinds.as_deref().unwrap().len(), 1);
    // Nothing fell through to `extra`: every field sdk.mjs sends is named.
    assert!(init.extra.is_empty(), "unmodelled initialize fields: {:?}", init.extra);

    // An empty `initialize` encodes to just its tag — every field is optional.
    let bare = ControlRequest::new(
        "r0",
        ControlRequestBody::Known(Box::new(ControlRequestKnown::Initialize(
            Box::<InitializeRequest>::default(),
        ))),
    );
    let bytes = encode_line(&bare).unwrap();
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        "{\"type\":\"control_request\",\"request_id\":\"r0\",\"request\":{\"subtype\":\"initialize\"}}\n"
    );
}

#[test]
fn host_originated_frames_encode_in_the_shape_the_cli_expects() {
    // interrupt with cancel_queued
    let interrupt = ControlRequest::new(
        "i1",
        ControlRequestBody::Known(Box::new(ControlRequestKnown::Interrupt(InterruptRequest {
            cancel_queued: Some(true),
            ..Default::default()
        }))),
    );
    assert_eq!(
        String::from_utf8(encode_line(&interrupt).unwrap()).unwrap(),
        "{\"type\":\"control_request\",\"request_id\":\"i1\",\"request\":{\"subtype\":\"interrupt\",\"cancel_queued\":true}}\n"
    );

    // set_model
    let set_model = ControlRequest::new(
        "m1",
        ControlRequestBody::Known(Box::new(ControlRequestKnown::SetModel(SetModelRequest {
            model: Some("claude-opus-4-6".into()),
            ..Default::default()
        }))),
    );
    assert_eq!(
        String::from_utf8(encode_line(&set_model).unwrap()).unwrap(),
        "{\"type\":\"control_request\",\"request_id\":\"m1\",\"request\":{\"subtype\":\"set_model\",\"model\":\"claude-opus-4-6\"}}\n"
    );

    // can_use_tool answers: camelCase `updatedInput`, and `deny` requires `message`.
    let allow = ControlResponse::success("q1", &PermissionResult::allow()).unwrap();
    assert_eq!(
        String::from_utf8(encode_line(&allow).unwrap()).unwrap(),
        "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"q1\",\"response\":{\"behavior\":\"allow\"}}}\n"
    );
    let deny = ControlResponse::success("q2", &PermissionResult::deny("not this time")).unwrap();
    assert_eq!(
        String::from_utf8(encode_line(&deny).unwrap()).unwrap(),
        "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"q2\",\"response\":{\"behavior\":\"deny\",\"message\":\"not this time\"}}}\n"
    );

    // hook_callback answer: `continue` is a Rust keyword, so the field is `continue_`.
    let hook = ControlResponse::success(
        "h1",
        &HookJsonOutput {
            continue_: Some(false),
            stop_reason: Some("blocked".into()),
            decision: Some("block".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        String::from_utf8(encode_line(&hook).unwrap()).unwrap(),
        // `response` is built with `serde_json::to_value`, whose Map sorts keys.
        "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"h1\",\"response\":{\"continue\":false,\"decision\":\"block\",\"stopReason\":\"blocked\"}}}\n"
    );

    // Bare ack and error.
    assert_eq!(
        String::from_utf8(encode_line(&ControlResponse::ack("a1")).unwrap()).unwrap(),
        "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"a1\",\"response\":{}}}\n"
    );
    let err = ControlResponse::error("e1", "unsupported");
    assert_eq!(err.request_id(), "e1");
    assert_eq!(
        String::from_utf8(encode_line(&err).unwrap()).unwrap(),
        "{\"type\":\"control_response\",\"response\":{\"subtype\":\"error\",\"request_id\":\"e1\",\"error\":\"unsupported\"}}\n"
    );
}

#[test]
fn streaming_input_user_message_matches_the_sdk_byte_for_byte() {
    // sdk.mjs:72374-72383 writes exactly this shape for a bare string prompt.
    let msg = SdkUserMessage::text("hello");
    assert_eq!(
        String::from_utf8(encode_line(&msg).unwrap()).unwrap(),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]},\"parent_tool_use_id\":null,\"session_id\":\"\"}\n"
    );
    // And it decodes back to itself.
    let bytes = encode_line(&msg).unwrap();
    let round: SdkUserMessage = serde_json::from_slice(bytes.strip_suffix(b"\n").unwrap()).unwrap();
    assert_eq!(round, msg);
}

#[test]
fn control_response_and_cancel_correlate_by_request_id() {
    let Inbound::ControlResponse(ok) = decode_line(&load("control_response_success.json")).unwrap()
    else {
        panic!("expected a control response");
    };
    assert_eq!(ok.request_id(), "in1");
    let ControlResponseBody::Success {
        response,
        pending_permission_requests,
        ..
    } = &ok.response
    else {
        panic!("expected success");
    };
    assert_eq!(response.as_ref().unwrap()["output_style"], "default");
    assert_eq!(pending_permission_requests.as_ref().unwrap().len(), 1);

    let Inbound::ControlResponse(bad) = decode_line(&load("control_response_error.json")).unwrap()
    else {
        panic!("expected a control response");
    };
    assert_eq!(bad.request_id(), "it1");

    let Inbound::ControlCancel(cancel) =
        decode_line(&load("control_cancel_request.json")).unwrap()
    else {
        panic!("expected a control cancel");
    };
    assert_eq!(cancel.request_id, "q1w2e3r4t5y");
}

// ---------------------------------------------------------------------------------------------
// Regressions against the real CLI captures in `crates/claude-spike/fixtures`.
//
// Those are raw taps of CLI 2.1.257 (`*.ndjson` = received, `*.sent.ndjson` = sent), so unlike
// `tests/fixtures/` they are evidence rather than transcription.
// ---------------------------------------------------------------------------------------------

fn capture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../claude-spike/fixtures")
}

/// Every non-blank line of every real capture, as `(file, 1-based line number, bytes)`.
fn capture_lines() -> Vec<(String, usize, Vec<u8>)> {
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(capture_dir())
        .expect("claude-spike fixtures dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "ndjson"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no *.ndjson captures found in {}", capture_dir().display());

    let mut out = Vec::new();
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{name}: {e}"));
        for (i, line) in text.lines().enumerate() {
            if !line.trim().is_empty() {
                out.push((name.clone(), i + 1, line.as_bytes().to_vec()));
            }
        }
    }
    out
}

#[test]
fn inbound_deserialize_dispatches_control_frames_like_decode_line() {
    // The derived `#[serde(untagged)]` impl put `Message(CliMessage)` first, and
    // `CliMessage::Unknown(Value)` matches any object, so every control frame was swallowed
    // there. `serde_json::from_str::<Inbound>` must reach the control arms.
    let cases: [(&str, &str); 4] = [
        (
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"interrupt"}}"#,
            "control_request/interrupt",
        ),
        (
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1"}}"#,
            "control_response/success",
        ),
        (
            r#"{"type":"control_cancel_request","request_id":"r1"}"#,
            "control_cancel_request",
        ),
        (r#"{"type":"keep_alive"}"#, "keep_alive"),
    ];
    for (line, want) in cases {
        let via_serde: Inbound = serde_json::from_str(line).unwrap_or_else(|e| panic!("{line}: {e}"));
        assert_eq!(classify(&via_serde), want, "from_str::<Inbound> on {line}");
        let via_decode = decode_line(line.as_bytes()).unwrap();
        assert_eq!(via_serde, via_decode, "the two paths disagree on {line}");
    }
}

#[test]
fn a_drifted_control_frame_falls_back_instead_of_failing_the_line() {
    // A `control_response` subtype this crate does not model. It used to error the whole line.
    let line = br#"{"type":"control_response","response":{"subtype":"partial","request_id":"r1"}}"#;
    let decoded = decode_line(line).expect("a drifted control_response must not be an error");
    assert_eq!(classify(&decoded), "control_response/unknown");
    let Inbound::ControlResponse(response) = &decoded else {
        panic!("expected the typed control_response arm, got {decoded:?}");
    };
    assert_eq!(response.request_id(), "r1", "the correlation id must survive");
    let ControlResponseBody::Unknown(unknown) = &response.response else {
        panic!("expected the Unknown arm");
    };
    assert_eq!(unknown.extra["subtype"], "partial");
    // And it re-encodes verbatim.
    let re: serde_json::Value = serde_json::from_slice(&encode_line(&decoded).unwrap()).unwrap();
    assert_eq!(re, serde_json::from_slice::<serde_json::Value>(line).unwrap());

    // A control frame that cannot be typed at all falls through to `Inbound::Unknown`, losslessly,
    // rather than erroring: `control_cancel_request` requires a string `request_id`.
    let line = br#"{"type":"control_cancel_request","request_id":{"drifted":true}}"#;
    let decoded = decode_line(line).expect("a drifted control_cancel_request must not be an error");
    assert_eq!(classify(&decoded), "inbound/unknown");
    let Inbound::Unknown(kept) = &decoded else { panic!("expected Inbound::Unknown") };
    assert_eq!(kept, &serde_json::from_slice::<serde_json::Value>(line).unwrap());
}

#[test]
fn system_init_survives_a_drifted_collection_field() {
    // One field with the wrong type used to demote the whole handshake to `system/other`, and
    // the adapter would never see `session_id`.
    let line = br#"{"type":"system","subtype":"init","session_id":"s1","capabilities":{"x":1}}"#;
    let decoded = decode_line(line).unwrap();
    assert_eq!(classify(&decoded), "system/init");
    let Inbound::Message(CliMessage::Known(known)) = &decoded else {
        panic!("expected a known message");
    };
    let KnownMessage::System(SystemMessage::Init(init)) = known.as_ref() else {
        panic!("expected system/init");
    };
    assert_eq!(init.session_id.as_deref(), Some("s1"));
    assert_eq!(init.capabilities, None, "the drifted field alone is lost");

    // Same for every other collection or string field whose failure would demote the frame.
    let drifted = [
        r#""tools":7"#,
        r#""mcp_servers":{"a":"b"}"#,
        r#""agents":"claude""#,
        r#""slash_commands":false"#,
        r#""output_style":["default"]"#,
        r#""model":42"#,
        r#""skills":{}"#,
        r#""betas":1"#,
        r#""effort":[]"#,
    ];
    for field in drifted {
        let line = format!(r#"{{"type":"system","subtype":"init","session_id":"s1",{field}}}"#);
        let decoded = decode_line(line.as_bytes()).unwrap();
        assert_eq!(classify(&decoded), "system/init", "demoted by {field}");
    }
}

#[test]
fn real_captures_land_on_their_typed_arms() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for (file, no, line) in capture_lines() {
        let decoded =
            decode_line(&line).unwrap_or_else(|e| panic!("{file}:{no} failed to decode: {e}"));
        let arm = classify(&decoded);
        let raw: serde_json::Value = serde_json::from_slice(&line).unwrap();
        let ty = raw["type"].as_str().unwrap_or_default();
        let sub = raw["subtype"].as_str().unwrap_or_default();
        let req_sub = raw["request"]["subtype"].as_str().unwrap_or_default();
        match (ty, sub, req_sub) {
            ("system", "init", _) => assert_eq!(arm, "system/init", "{file}:{no}"),
            ("result", _, _) => assert!(
                arm == "result/success" || arm.starts_with("result/error:"),
                "{file}:{no} decoded to {arm}"
            ),
            ("control_request", _, "can_use_tool") => {
                assert_eq!(arm, "control_request/can_use_tool", "{file}:{no}");
            }
            ("control_request", _, "hook_callback") => {
                assert_eq!(arm, "control_request/hook_callback", "{file}:{no}");
            }
            ("control_request", _, "initialize") => {
                assert_eq!(arm, "control_request/initialize", "{file}:{no}");
            }
            ("control_request", _, "interrupt") => {
                assert_eq!(arm, "control_request/interrupt", "{file}:{no}");
            }
            ("control_response", _, _) => {
                assert_eq!(arm, "control_response/success", "{file}:{no}");
            }
            ("assistant", _, _) => assert_eq!(arm, "assistant", "{file}:{no}"),
            ("user", _, _) => assert_eq!(arm, "user", "{file}:{no}"),
            _ => {}
        }
        *seen.entry(arm).or_default() += 1;
    }
    // Not a vacuous pass: the arms the review named are all actually exercised.
    for arm in ["system/init", "result/success", "control_request/can_use_tool"] {
        assert!(seen.contains_key(arm), "no capture line reached {arm}; saw {seen:?}");
    }
}

#[test]
fn real_captures_round_trip_byte_faithfully() {
    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for (file, no, line) in capture_lines() {
        let original: serde_json::Value = serde_json::from_slice(&line).unwrap();
        let decoded = decode_line(&line).unwrap_or_else(|e| panic!("{file}:{no}: {e}"));
        let encoded = encode_line(&decoded).unwrap_or_else(|e| panic!("{file}:{no}: {e}"));
        let again: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        checked += 1;
        if again != original {
            failures.push(format!("{file}:{no}\n  was: {original}\n  now: {again}"));
        }
    }
    assert!(checked > 100, "only {checked} capture lines checked");
    assert!(failures.is_empty(), "{} of {checked} lines lost data:\n{}", failures.len(), failures.join("\n"));
}
