//! Wire-level serde types for the Claude Code CLI's `stream-json` stdio protocol.
//!
//! Scope: framing and (de)serialisation only. No process handling, no mapping to canonical
//! events — that belongs to `crates/core`.
//!
//! The CLI is spawned as
//! `claude --output-format stream-json --verbose --input-format stream-json
//! --permission-prompt-tool stdio` (never `--print`); one JSON object per line in each
//! direction. See `docs/research/cli-protocol.md` §1.
//!
//! Every type here is transcribed from the shipped `@anthropic-ai/claude-agent-sdk@0.3.257`
//! `sdk.d.ts` (cited per item as `sdk.d.ts:<line>`). Where `sdk.d.ts` and the minified
//! `sdk.mjs` disagree, `sdk.mjs` wins and the divergence is called out in the doc comment —
//! `sdk.d.ts`'s union is a curated subset, not the protocol (`docs/research/cli-protocol.md` §3).
//!
//! # Forward compatibility
//!
//! Two mechanisms keep unknown wire data alive across CLI upgrades:
//!
//! * **Unknown message types.** [`CliMessage`] is an `#[serde(untagged)]` wrapper whose last
//!   arm is [`CliMessage::Unknown`], so an unrecognised `type` (or a known `type` whose payload
//!   fails to typecheck) decodes into a raw [`serde_json::Value`] instead of erroring.
//!   The same pattern guards `system` subtypes, `result` subtypes, control-request subtypes and
//!   content blocks.
//! * **Unknown fields.** Every struct carries `#[serde(flatten)] pub extra: Extra`, so fields
//!   this crate does not name survive a decode/encode round trip verbatim — an explicit `null`
//!   included.
//!
//! # Round-trip fidelity
//!
//! `decode_line` → `encode_line` reproduces every real capture in
//! `crates/claude-spike/fixtures/*.ndjson` key-for-key and value-for-value (key *order* aside;
//! `serde_json`'s default `Map` sorts). `tests/decode.rs::real_captures_round_trip_byte_faithfully`
//! is that proof.
//!
//! The one thing a named `Option` field cannot carry is the difference between an explicit
//! `"k": null` and an absent `k`: both decode to `None`. Every `Option` field is
//! `skip_serializing_if = "Option::is_none"`, so `None` re-emits as *absent* — which is right for
//! the keys the CLI omits and wrong for the handful it always writes as `null`. Those are named
//! individually and left unskipped, with the capture that proves it cited at the field. Where the
//! same struct serves two frames that disagree (`stop_reason` on `AnthropicMessage`), the field is
//! not modelled at all and rides in `extra`, which keeps the distinction exactly.
//!
//! CLI field names are preserved exactly as they appear on the wire — the CLI mixes
//! `snake_case` and `camelCase` and this crate does not "fix" it (`permissionMode`,
//! `modelUsage`, `apiKeySource`, `isAuthenticating` are camelCase; the rest are snake_case).

#![deny(unsafe_code)]
#![warn(missing_docs)]
// The crate docs promise no `unwrap` outside tests; make that a compile error rather than a claim.
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

/// Defines a serde-only "string literal type": an enum whose variants each accept exactly one
/// JSON string. Used to discriminate `#[serde(untagged)]` alternatives on a `subtype`/`type`
/// field without giving up the untagged fallback arm.
macro_rules! literal_tag {
    (
        $(#[$meta:meta])*
        $name:ident { $first_variant:ident => $first_lit:literal $(, $variant:ident => $lit:literal)* $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, ::serde::Serialize, ::serde::Deserialize)]
        pub enum $name {
            #[doc = concat!("The literal `\"", $first_lit, "\"`.")]
            #[serde(rename = $first_lit)]
            #[default]
            $first_variant,
            $(
                #[doc = concat!("The literal `\"", $lit, "\"`.")]
                #[serde(rename = $lit)]
                $variant,
            )*
        }
    };
}

pub mod control;
pub mod input;
pub mod message;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use control::{
    ControlCancelRequest, ControlRequest, ControlRequestBody, ControlResponse, ControlResponseBody,
    ControlResponseIn, HookJsonOutput, PermissionResult,
};
pub use input::{SdkUserMessage, UserMessageBody};
pub use message::{CliMessage, Extra, KnownMessage, SystemMessage};

/// Anything the CLI can write on its output stream, dispatched on the top-level `type`.
///
/// Mirrors `StdoutMessage` (`sdk.d.ts:8296`): "exactly one StdoutMessage per line, as a single
/// JSON object. Besides the SDKMessage members this includes the control protocol — control
/// requests the CLI originates, control responses to the client's requests, cancellations and
/// keep-alives." (`sdk.d.ts:8294-8296`.)
///
/// `Deserialize` is hand-written, *not* derived. A derived `#[serde(untagged)]` impl tries the
/// arms in order, and the first one — `Message(CliMessage)` — ends in `CliMessage::Unknown(Value)`,
/// which matches literally any JSON: every control frame was swallowed there and the three control
/// arms were unreachable through serde. The hand-written impl dispatches on the top-level `type`,
/// through the same private `classify` [`decode_line`] uses, so the two cannot drift apart.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Inbound {
    /// A conversational or informational message (`sdk.d.ts:4603` `SDKMessage`), plus the
    /// non-`SDKMessage` frames `keep_alive`, `transcript_mirror` and `active_goal`.
    Message(CliMessage),
    /// `{"type":"control_request", ...}` — the CLI asking the host to do something
    /// (`sdk.d.ts:4271-4278`). The host must answer with exactly one [`ControlResponse`].
    ControlRequest(ControlRequest),
    /// `{"type":"control_response", ...}` — the CLI answering a request the host sent
    /// (`sdk.d.ts:4320-4323`).
    ControlResponse(ControlResponseIn),
    /// `{"type":"control_cancel_request", ...}` — the CLI withdrawing an in-flight
    /// `control_request` (`sdk.d.ts:3524-3530`).
    ///
    /// Not listed in the work order's four-arm sketch; added because dropping a known frame
    /// into [`Inbound::Unknown`] would lose the `request_id` correlation the approval park needs.
    ControlCancel(ControlCancelRequest),
    /// A line no arm above could take, kept verbatim: JSON that is not an object (never produced
    /// by the CLI today, but a non-object line must not be an error), or a `control_*` frame whose
    /// envelope no longer typechecks. An object with an *unrecognised* `type` is not here — it
    /// lands in [`CliMessage::Unknown`] and stays inside [`Inbound::Message`].
    Unknown(Value),
}

/// Failure decoding one NDJSON line.
#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    /// The line was empty or contained only whitespace after trimming the terminator.
    ///
    /// Distinct from a JSON error so a caller can drop blank lines without logging noise.
    #[error("empty line")]
    EmptyLine,
    /// The line was not valid JSON. A well-formed line never errors, whatever its shape: it
    /// falls through to [`Inbound::Unknown`].
    #[error("malformed JSON line: {0}")]
    Json(#[from] serde_json::Error),
}

/// Failure encoding a frame.
#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    /// `serde_json` refused to serialise the value.
    #[error("serialization failed: {0}")]
    Json(#[from] serde_json::Error),
}

/// Decodes one line of the CLI's stdout into an [`Inbound`] frame.
///
/// A trailing `\n` or `\r\n` is trimmed first: `tauri_utils::io::read_line` includes the
/// terminator byte in the buffer it returns (`tauri-utils-2.9.3/src/io.rs:12-46`, see
/// `docs/research/tauri-runtime.md`), and so do several other line splitters. Reading with
/// `tokio`'s `read_until(b'\n')` has the same property.
///
/// **No JSON shape is an error.** An unknown `type` becomes [`CliMessage::Unknown`] (object
/// lines) or [`Inbound::Unknown`] (non-object lines); a *known* `type` whose payload no longer
/// typechecks — a `control_response` with a `subtype` this crate does not model, say — falls
/// through to [`Inbound::Unknown`] carrying the line verbatim rather than failing it. Only
/// invalid JSON ([`DecodeError::Json`]) and blank lines ([`DecodeError::EmptyLine`]) are errors.
pub fn decode_line(line: &[u8]) -> Result<Inbound, DecodeError> {
    let mut bytes = line;
    if let Some(rest) = bytes.strip_suffix(b"\n") {
        bytes = rest;
    }
    if let Some(rest) = bytes.strip_suffix(b"\r") {
        bytes = rest;
    }
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Err(DecodeError::EmptyLine);
    }

    Ok(classify(serde_json::from_slice(bytes)?))
}

/// Sorts one decoded JSON value into an [`Inbound`] arm on its top-level `type`.
///
/// The single dispatch point, shared by [`decode_line`] and `<Inbound as Deserialize>`, so the two
/// cannot drift apart. Total: anything that does not typecheck as its named arm lands in
/// [`Inbound::Unknown`] with the value intact.
fn classify(value: Value) -> Inbound {
    let Some(object) = value.as_object() else {
        return Inbound::Unknown(value);
    };

    // Deserialising from `&Value` rather than by value so the original survives a failed attempt
    // and can be handed to `Inbound::Unknown`.
    match object.get("type").and_then(Value::as_str) {
        Some("control_request") => match ControlRequest::deserialize(&value) {
            Ok(request) => Inbound::ControlRequest(request),
            Err(_) => Inbound::Unknown(value),
        },
        Some("control_response") => match ControlResponseIn::deserialize(&value) {
            Ok(response) => Inbound::ControlResponse(response),
            Err(_) => Inbound::Unknown(value),
        },
        Some("control_cancel_request") => match ControlCancelRequest::deserialize(&value) {
            Ok(cancel) => Inbound::ControlCancel(cancel),
            Err(_) => Inbound::Unknown(value),
        },
        _ => match CliMessage::deserialize(&value) {
            Ok(message) => Inbound::Message(message),
            Err(_) => Inbound::Unknown(value),
        },
    }
}

impl<'de> Deserialize<'de> for Inbound {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(classify(Value::deserialize(deserializer)?))
    }
}

/// Serialises a frame and appends the `\n` the CLI's `readline` framing requires.
///
/// The SDK writes `JSON.stringify(msg) + "\n"` to the child's stdin
/// (`sdk.mjs:47325-47331`, `sdk.mjs:48035`).
///
/// Returns `Result` rather than the work order's bare `Vec<u8>`: `serde_json` can fail
/// (a non-string map key, a `f64::NAN`) and this crate forbids `unwrap` outside tests.
pub fn encode_line<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, EncodeError> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}
