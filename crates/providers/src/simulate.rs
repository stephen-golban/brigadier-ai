//! Simulated CLI output, in each CLI's real wire format, for checking how the adapters
//! detect and classify events that are hard to trigger on demand.
//!
//! The lines are fed through a fresh [`crate::Replayer`] in an isolated diagnostic session;
//! they never reach a live session's transcript, quota or turn state.

use serde_json::json;

use crate::model::ProviderKind;
use crate::now_ms;

/// A turn that ends because the subscription's usage window ran out.
pub fn usage_limit(provider: ProviderKind) -> Vec<String> {
    let now_s = now_ms() / 1_000;
    let resets_s = now_s + 2 * 3_600;
    let weekly_resets_s = now_s + 4 * 86_400;
    let session = uuid::Uuid::new_v4().to_string();
    let id = || uuid::Uuid::new_v4().to_string();
    match provider {
        ProviderKind::Claude => {
            let text = "You've hit your session limit · resets in 2h";
            vec![
                json!({
                    "type": "user",
                    "message": {"role": "user", "content": [{"type": "text", "text": "Summarize the open pull requests."}]},
                    "session_id": session, "parent_tool_use_id": null, "uuid": id(), "isReplay": true,
                }),
                json!({
                    "type": "rate_limit_event",
                    "rate_limit_info": {
                        "status": "rejected",
                        "resetsAt": resets_s,
                        "rateLimitType": "five_hour",
                        "utilization": 1.0,
                        "overageStatus": "rejected",
                        "overageDisabledReason": "org_level_disabled",
                        "isUsingOverage": false,
                        "unifiedWindows": {
                            "five_hour": {"utilization": 1.0, "resetsAt": resets_s},
                            "seven_day": {"utilization": 0.41, "resetsAt": weekly_resets_s},
                        },
                    },
                    "uuid": id(), "session_id": session,
                }),
                json!({
                    "type": "assistant",
                    "message": {
                        "id": id(), "type": "message", "role": "assistant", "model": "<synthetic>",
                        "content": [{"type": "text", "text": text}],
                        "stop_reason": "stop_sequence", "stop_sequence": "",
                        "usage": {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                    },
                    "parent_tool_use_id": null, "session_id": session, "uuid": id(),
                    "error": "rate_limit",
                }),
                json!({
                    "type": "result", "subtype": "success", "is_error": true,
                    "duration_ms": 412, "duration_api_ms": 0, "num_turns": 1,
                    "result": text, "stop_reason": "stop_sequence", "session_id": session,
                    "total_cost_usd": 0,
                    "usage": {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0},
                    "permission_denials": [], "uuid": id(),
                }),
            ]
        }
        ProviderKind::Codex => {
            let turn = id();
            let error = json!({
                "message": "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again in 2 hours.",
                "codexErrorInfo": "usageLimitExceeded",
                "additionalDetails": null,
            });
            let limits = json!({
                "limitId": "codex", "limitName": null, "normalModelSlug": null,
                "primary": {"usedPercent": 100, "windowDurationMins": 300, "resetsAt": resets_s},
                "secondary": {"usedPercent": 41, "windowDurationMins": 10_080, "resetsAt": weekly_resets_s},
                "credits": {"hasCredits": false, "unlimited": false, "balance": "0"},
                "individualLimit": null, "spendControlReached": false, "planType": "pro",
                "rateLimitReachedType": "rate_limit_reached",
            });
            vec![
                json!({"method": "turn/started", "params": {"threadId": session, "turn": {
                    "id": turn, "items": [], "itemsView": "notLoaded", "status": "inProgress",
                    "error": null, "startedAt": now_s, "completedAt": null, "durationMs": null,
                }}}),
                json!({"method": "item/completed", "params": {"threadId": session, "turnId": turn, "item": {
                    "type": "userMessage", "id": id(), "clientId": null,
                    "content": [{"type": "text", "text": "Summarize the open pull requests.", "text_elements": []}],
                }}}),
                json!({"method": "account/rateLimits/updated", "params": {"rateLimits": limits}}),
                json!({"method": "error", "params": {
                    "error": error, "willRetry": false, "threadId": session, "turnId": turn,
                }}),
                json!({"method": "turn/completed", "params": {"threadId": session, "turn": {
                    "id": turn, "items": [], "itemsView": "notLoaded", "status": "failed",
                    "error": error, "startedAt": now_s, "completedAt": now_s + 1, "durationMs": 640,
                }}}),
            ]
        }
    }
    .into_iter()
    .map(|line| line.to_string())
    .collect()
}
