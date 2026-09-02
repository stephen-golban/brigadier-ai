//! WO-W: which hook events the `claude` CLI actually delivers over the stdio
//! control protocol, and what the harness can do with them.
//!
//! Four questions, three live sessions (10 answers two, to stay under the cap):
//!
//! * `8  hook-events`   — do `Stop`, `SubagentStop` and `PostToolUse` registered in
//!   `initialize` actually produce `hook_callback` frames?
//! * `9  subagent-id`   — does a `hook_callback` from inside an `Agent` subagent carry
//!   `agent_id`/`agent_type`, and is it absent on the host?
//! * `10 deny-read +    — does `permissionDecision: "deny"` block a **non-Bash** tool
//!    stop-bounce`        (`Read`)? And does a non-empty `Stop` response bounce the turn?
//!
//! Every `hook_callback` request and every response the spike writes is appended
//! verbatim to `fixtures/<scenario>.hooks.ndjson`, so the payload shapes in
//! `docs/research/wall-hooks.md` are transcribed, not remembered.

use crate::session::*;
use crate::Report;
use anyhow::Result;
use serde_json::{json, Value};
use std::io::Write as _;
use std::time::{Duration, Instant};

const STEP: Duration = Duration::from_secs(90);
/// How long to keep reading after the `result` frame, in case a `Stop` callback
/// or a second `result` trails it.
const GRACE: Duration = Duration::from_secs(12);

/// One `hook_callback` we saw, flattened to the fields the wall cares about.
#[derive(Debug, Clone)]
pub struct HookHit {
    pub event: String,
    pub callback_id: String,
    pub tool_name: Option<String>,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub at_ms: u128,
    pub input: Value,
}

/// What the scenario observed. `frames` is every top-level frame type in order.
#[derive(Default)]
pub struct Trace {
    pub hooks: Vec<HookHit>,
    pub can_use_tool: Vec<String>,
    pub results: Vec<Value>,
    pub assistant_texts: Vec<String>,
    pub tool_results: Vec<String>,
    pub other_control: Vec<String>,
}

impl Trace {
    pub fn events(&self) -> Vec<String> {
        self.hooks.iter().map(|h| h.event.clone()).collect()
    }
    pub fn first(&self, event: &str) -> Option<&HookHit> {
        self.hooks.iter().find(|h| h.event == event)
    }
    pub fn count(&self, event: &str) -> usize {
        self.hooks.iter().filter(|h| h.event == event).count()
    }
}

/// `(hook input) -> response body`. Called once per `hook_callback`; `n` is how
/// many callbacks for that same event have already been answered.
type HookPolicy = dyn Fn(&str, usize, &Value) -> Value + Send;

/// Drive one prompt with one hooks registration and collect everything.
///
/// `extra` is appended to the base argv. `hooks` is the `initialize` hooks map.
#[allow(clippy::too_many_arguments)]
pub async fn run_wall(
    fixture: &str,
    extra: &[String],
    hooks: Value,
    prompt: &str,
    policy: Box<HookPolicy>,
    r: &mut Report,
) -> Result<Trace> {
    let mut hook_log = std::fs::File::create(format!("{FIXTURES}/{fixture}.hooks.ndjson"))?;
    let mut t = Trace::default();

    let mut s = Session::spawn(fixture, extra).await?;
    let t0 = Instant::now();
    let init = s.initialize(hooks, STEP).await?;
    if init["response"]["subtype"] != "success" {
        r.note(format!(
            "initialize FAILED: {}",
            truncate(&init["response"].to_string(), 400)
        ));
        return Ok(t);
    }
    r.note(format!(
        "hooks_applied={} (not proof: see claude-direct-spike.md:217)",
        init["response"]["response"]["hooks_applied"]
    ));

    s.send_user(prompt).await?;

    let mut per_event: std::collections::HashMap<String, usize> = Default::default();
    let mut deadline_kind = "result";
    let mut grace_until: Option<Instant> = None;

    loop {
        let budget = match grace_until {
            Some(u) => u.saturating_duration_since(Instant::now()),
            None => STEP,
        };
        if budget.is_zero() {
            break;
        }
        let Some(v) = s.recv(budget).await? else {
            if grace_until.is_none() {
                r.note(format!("timeout/EOF before {deadline_kind}"));
            }
            break;
        };

        match v["type"].as_str().unwrap_or("") {
            "control_request" => {
                let rid = v["request_id"].as_str().unwrap_or("").to_string();
                let sub = v["request"]["subtype"].as_str().unwrap_or("").to_string();
                match sub.as_str() {
                    "hook_callback" => {
                        writeln!(hook_log, "{}", serde_json::to_string(&v)?)?;
                        hook_log.flush()?;
                        let input = v["request"]["input"].clone();
                        let event = input["hook_event_name"]
                            .as_str()
                            .unwrap_or("<absent>")
                            .to_string();
                        let n = per_event.entry(event.clone()).or_insert(0);
                        let hit = HookHit {
                            event: event.clone(),
                            callback_id: v["request"]["callback_id"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                            tool_name: input["tool_name"].as_str().map(str::to_string),
                            agent_id: input["agent_id"].as_str().map(str::to_string),
                            agent_type: input["agent_type"].as_str().map(str::to_string),
                            at_ms: t0.elapsed().as_millis(),
                            input: input.clone(),
                        };
                        let body = policy(&event, *n, &input);
                        *n += 1;
                        r.note(format!(
                            "hook_callback {} cb={} tool={} agent_id={} agent_type={} @{}ms -> {}",
                            hit.event,
                            hit.callback_id,
                            hit.tool_name.clone().unwrap_or_else(|| "-".into()),
                            hit.agent_id.clone().unwrap_or_else(|| "<absent>".into()),
                            hit.agent_type.clone().unwrap_or_else(|| "<absent>".into()),
                            hit.at_ms,
                            truncate(&body.to_string(), 160),
                        ));
                        t.hooks.push(hit);
                        let resp = json!({
                            "type": "control_response",
                            "response": { "subtype": "success", "request_id": rid, "response": body }
                        });
                        writeln!(hook_log, "{}", serde_json::to_string(&resp)?)?;
                        hook_log.flush()?;
                        s.send(&resp).await?;
                    }
                    "can_use_tool" => {
                        let tool = v["request"]["tool_name"].as_str().unwrap_or("").to_string();
                        t.can_use_tool.push(tool.clone());
                        r.note(format!(
                            "can_use_tool tool={tool} agent_id={} -> allow",
                            v["request"]["agent_id"]
                        ));
                        s.answer_ok(
                            &rid,
                            json!({ "behavior": "allow", "updatedInput": v["request"]["input"].clone() }),
                        )
                        .await?;
                    }
                    other => {
                        t.other_control.push(other.to_string());
                        r.note(format!("unhandled control_request subtype={other}"));
                        s.answer_err(&rid, &format!("spike does not handle {other}"))
                            .await?;
                    }
                }
            }
            "assistant" => {
                let txt = text_of(&v);
                if !txt.trim().is_empty() {
                    t.assistant_texts.push(txt);
                }
            }
            "user" => {
                let txt = text_of(&v);
                if !txt.trim().is_empty() {
                    t.tool_results.push(txt);
                }
            }
            "result" => {
                r.cost += v["total_cost_usd"].as_f64().unwrap_or(0.0);
                r.note(format!(
                    "result#{} subtype={} is_error={} denials={} text={:?} @{}ms",
                    t.results.len() + 1,
                    v["subtype"],
                    v["is_error"],
                    truncate(&v["permission_denials"].to_string(), 400),
                    truncate(v["result"].as_str().unwrap_or(""), 220),
                    t0.elapsed().as_millis()
                ));
                t.results.push(v.clone());
                deadline_kind = "grace";
                grace_until = Some(Instant::now() + GRACE);
            }
            _ => {}
        }
    }

    s.close_stdin().await;
    if s.wait_exit(Duration::from_secs(15)).await.is_none() {
        let _ = s.kill().await;
    }
    Ok(t)
}

/// Pin the mode ourselves: the owner's settings file sets
/// `"defaultMode": "bypassPermissions"` (claude-direct-spike.md §"The two shadows").
fn default_mode() -> Vec<String> {
    vec!["--permission-mode".into(), "default".into()]
}

// ------------------------------------------------------------------ scenario 8

/// (a) Register four events. Do `PostToolUse`, `Stop` and `SubagentStop` fire?
pub async fn s8() -> Result<Report> {
    let mut r = Report::new("8 hook-events");
    let hooks = json!({
        "PreToolUse":   [ { "matcher": "", "hookCallbackIds": ["cb_pre"] } ],
        "PostToolUse":  [ { "matcher": "", "hookCallbackIds": ["cb_post"] } ],
        "Stop":         [ { "matcher": "", "hookCallbackIds": ["cb_stop"] } ],
        "SubagentStop": [ { "matcher": "", "hookCallbackIds": ["cb_substop"] } ]
    });
    let t = run_wall(
        "s8-hook-events",
        &default_mode(),
        hooks,
        "Use the Bash tool to run: echo brigadier-wall-ok. Then reply done.",
        Box::new(|_ev, _n, _in| json!({})),
        &mut r,
    )
    .await?;

    r.note(format!("hook events in order: {:?}", t.events()));
    if let Some(stop) = t.first("Stop") {
        r.note(format!(
            "Stop input keys: {:?}",
            stop.input
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        ));
        r.note(format!(
            "Stop stop_hook_active={} last_assistant_message={:?}",
            stop.input["stop_hook_active"],
            truncate(
                stop.input["last_assistant_message"]
                    .as_str()
                    .unwrap_or("<absent>"),
                200
            )
        ));
    }
    if let Some(post) = t.first("PostToolUse") {
        r.note(format!(
            "PostToolUse input keys: {:?}",
            post.input
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        ));
    }
    r.pass = t.count("PreToolUse") > 0 && t.count("PostToolUse") > 0 && t.count("Stop") > 0;
    Ok(r)
}

// ------------------------------------------------------------------ scenario 9

/// (b) Does a subagent's tool call carry `agent_id`/`agent_type`, and does the
/// host's not? Also the only place `SubagentStop` can fire.
pub async fn s9() -> Result<Report> {
    let mut r = Report::new("9 subagent-agent-id");
    let hooks = json!({
        "PreToolUse":   [ { "matcher": "", "hookCallbackIds": ["cb_pre"] } ],
        "PostToolUse":  [ { "matcher": "", "hookCallbackIds": ["cb_post"] } ],
        "Stop":         [ { "matcher": "", "hookCallbackIds": ["cb_stop"] } ],
        "SubagentStop": [ { "matcher": "", "hookCallbackIds": ["cb_substop"] } ],
        "SubagentStart":[ { "matcher": "", "hookCallbackIds": ["cb_substart"] } ]
    });
    let t = run_wall(
        "s9-subagent-agent-id",
        &default_mode(),
        hooks,
        "Use the Task tool with subagent_type general-purpose and this prompt: \
         'Run the Bash command: echo brigadier-sub-ok, then reply with the word ok.' \
         When it returns, reply done.",
        Box::new(|_ev, _n, _in| json!({})),
        &mut r,
    )
    .await?;

    r.note(format!("hook events in order: {:?}", t.events()));
    let host: Vec<_> = t
        .hooks
        .iter()
        .filter(|h| h.agent_id.is_none())
        .map(|h| format!("{}/{}", h.event, h.tool_name.clone().unwrap_or_default()))
        .collect();
    let sub: Vec<_> = t
        .hooks
        .iter()
        .filter(|h| h.agent_id.is_some())
        .map(|h| {
            format!(
                "{}/{} agent_id={} agent_type={:?}",
                h.event,
                h.tool_name.clone().unwrap_or_default(),
                h.agent_id.clone().unwrap_or_default(),
                h.agent_type
            )
        })
        .collect();
    r.note(format!("WITHOUT agent_id ({}): {:?}", host.len(), host));
    r.note(format!("WITH agent_id ({}): {:?}", sub.len(), sub));
    if let Some(ss) = t.first("SubagentStop") {
        r.note(format!(
            "SubagentStop keys: {:?}",
            ss.input
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        ));
    }
    r.pass = !sub.is_empty() && !host.is_empty();
    Ok(r)
}

// ----------------------------------------------------------------- scenario 10

/// (c) + (d) in one session, to stay inside the spend cap.
///
/// (c) `permissionDecision: "deny"` from `PreToolUse` on a **non-Bash** tool (`Read`).
/// (d) a non-empty `Stop` response (`decision: "block"`), answered `{}` the second time.
///
/// The confound is deliberate and stated in `docs/research/wall-hooks.md`: the turn
/// that `Stop` bounces is the turn whose `Read` was denied.
///
/// `--strict-mcp-config` is added here and nowhere else: it drops the owner's MCP
/// servers from the system prompt, which is what keeps this run cheap. It changes the
/// tool list, not the hook plumbing.
pub async fn s10() -> Result<Report> {
    let mut r = Report::new("10 deny-read + stop-bounce");
    let hooks = json!({
        "PreToolUse":  [ { "matcher": "Read", "hookCallbackIds": ["cb_pre"] } ],
        "PostToolUse": [ { "matcher": "", "hookCallbackIds": ["cb_post"] } ],
        "Stop":        [ { "matcher": "", "hookCallbackIds": ["cb_stop"] } ]
    });
    let mut extra = default_mode();
    extra.push("--strict-mcp-config".into());
    let t = run_wall(
        "s10-deny-read-stop-bounce",
        &extra,
        hooks,
        "Read the file README.md in the current directory and reply with its first word.",
        Box::new(|ev, n, _in| match (ev, n) {
            ("PreToolUse", _) => json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason":
                        "brigadier wall: the host session may not read files"
                }
            }),
            ("Stop", 0) => json!({
                "decision": "block",
                "reason": "brigadier wall: that reply is too long. Reply with exactly the word ok."
            }),
            _ => json!({}),
        }),
        &mut r,
    )
    .await?;

    r.note(format!("hook events in order: {:?}", t.events()));
    for tr in &t.tool_results {
        r.note(format!("tool_result/user frame: {}", truncate(tr, 400)));
    }
    let leaked = t
        .tool_results
        .iter()
        .chain(t.assistant_texts.iter())
        .any(|s| s.contains("blueberry"));
    r.note(format!("README's first word leaked to the model: {leaked}"));
    for (i, h) in t.hooks.iter().filter(|h| h.event == "Stop").enumerate() {
        r.note(format!(
            "Stop#{} stop_hook_active={} last_assistant_message={:?}",
            i + 1,
            h.input["stop_hook_active"],
            truncate(
                h.input["last_assistant_message"].as_str().unwrap_or("<absent>"),
                200
            )
        ));
    }
    for (i, a) in t.assistant_texts.iter().enumerate() {
        r.note(format!("assistant#{}: {:?}", i + 1, truncate(a, 200)));
    }
    r.note(format!(
        "assistant turns: {} | Stop callbacks: {} | results: {}",
        t.assistant_texts.len(),
        t.count("Stop"),
        t.results.len()
    ));
    r.pass = t.count("PreToolUse") > 0 && !leaked && t.count("Stop") >= 2;
    Ok(r)
}
