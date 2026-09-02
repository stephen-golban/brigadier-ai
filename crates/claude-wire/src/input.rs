//! Host → CLI user messages: the streaming-input frame.
//!
//! With `--input-format stream-json` the host writes one of these per turn and keeps stdin open;
//! ending the stream is the only clean way to end the session
//! (`docs/research/agent-sdk.md` §10).

use serde::{Deserialize, Serialize};

use crate::message::{Extra, MessageContent};

literal_tag!(
    /// `type: "user"`.
    UserTag { User => "user" }
);

literal_tag!(
    /// `role: "user"`.
    UserRoleTag { User => "user" }
);

/// One turn of streaming input (`SDKUserMessage`, `sdk.d.ts:5267-5290`).
///
/// The SDK's own bare-string path writes exactly
/// `{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text",
/// "text":...}]},"parent_tool_use_id":null}` and then closes stdin
/// (`sdk.mjs:72374-72383`, `sdk.mjs:48052-48053`) — note `session_id` present but *empty* (so
/// [`SdkUserMessage::text`] sets `Some("")`, not `None`), `parent_tool_use_id` present and `null`
/// (so that field is never skipped), and no `uuid` key at all.
///
/// `uuid` and `session_id` are optional on `user` alone among the `SDKMessage` members
/// (`sdk.d.ts:5286-5287`), and are skipped when `None` so a hand-built turn does not invent keys
/// the SDK never sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SdkUserMessage {
    /// Always `"user"`.
    #[serde(rename = "type", default)]
    pub kind: UserTag,
    /// The turn itself.
    pub message: UserMessageBody,
    /// Set only when injecting a turn on behalf of a subagent; `null` otherwise.
    // Not skipped: `sdk.mjs:72374-72383` writes the key explicitly as `null`.
    pub parent_tool_use_id: Option<String>,
    /// Session id; the SDK sends `""` on the first turn and lets the CLI assign one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Host-minted frame uuid. Stamping one lets a `result`'s `user_message_uuid` be correlated
    /// back to the turn that caused it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
}

/// The `message` object of [`SdkUserMessage`] — the Anthropic `MessageParam` shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserMessageBody {
    /// Always `"user"`.
    #[serde(default)]
    pub role: UserRoleTag,
    /// A bare string or a block list. The SDK always sends a one-element `text` block list.
    pub content: MessageContent,
    /// Unknown fields, so a caller can add what this crate does not model.
    #[serde(flatten)]
    pub extra: Extra,
}

impl SdkUserMessage {
    /// Builds a plain-text turn in the exact shape the SDK sends: a one-element `text` block
    /// list, an empty `session_id`, and an explicit `"parent_tool_use_id": null`.
    pub fn text(prompt: impl Into<String>) -> Self {
        Self {
            kind: UserTag::User,
            message: UserMessageBody {
                role: UserRoleTag::User,
                content: MessageContent::Blocks(vec![crate::message::ContentBlock::Known(
                    crate::message::ContentBlockKnown::Text {
                        text: prompt.into(),
                        extra: Extra::new(),
                    },
                )]),
                extra: Extra::new(),
            },
            parent_tool_use_id: None,
            session_id: Some(String::new()),
            uuid: None,
        }
    }
}
