//! WO-C: headless spike that drives the Claude Code CLI over its stdio control
//! protocol from Rust, with no Node and no SDK. Proves or disproves decision 1
//! of docs/plans/provider-spi.md.
//!
//! Usage: cargo run -p claude-spike -- all
//!        cargo run -p claude-spike -- 1 2 4        (subset, by number or name)

mod session;

use anyhow::Result;
use serde_json::{json, Value};
use session::*;
use std::time::{Duration, Instant};

const SCENARIO_TIMEOUT: Duration = Duration::from_secs(120);
const STEP: Duration = Duration::from_secs(90);

#[derive(Default)]
pub struct Report {
    pub name: String,
    pub pass: bool,
    pub notes: Vec<String>,
    pub cost: f64,
}

impl Report {
    fn new(name: &str) -> Self {
        Report {
            name: name.to_string(),
            pass: false,
            notes: Vec::new(),
            cost: 0.0,
        }
    }
    fn note(&mut self, s: impl Into<String>) {
        self.notes.push(s.into());
    }
    fn print(&self) {
        println!(
            "{} {} :: {}",
            if self.pass { "PASS" } else { "FAIL" },
            self.name,
            self.notes.join(" | ")
        );
    }
}

fn is_result(v: &Value) -> bool {
    v["type"] == "result"
}

fn cost_of(v: &Value) -> f64 {
    v["total_cost_usd"].as_f64().unwrap_or(0.0)
}

// ---------------------------------------------------------------- scenario 1

async fn s1(sid_out: &mut Option<String>) -> Result<Report> {
    let mut r = Report::new("1 handshake-and-turn");
    let mut s = Session::spawn("s1-handshake-and-turn", &[]).await?;
    let t_spawn = s.spawned_at;

    let init_resp = s.initialize(json!({}), STEP).await?;
    let t_ctrl = t_spawn.elapsed().as_millis();
    r.note(format!("initialize control_response in {t_ctrl}ms"));
    if init_resp["response"]["subtype"] != "success" {
        r.note(format!(
            "initialize FAILED: {}",
            truncate(&init_resp.to_string(), 300)
        ));
        return Ok(r);
    }
    let models = init_resp["response"]["response"]["models"].clone();
    r.note(format!(
        "init resp keys: {:?}",
        init_resp["response"]["response"]
            .as_object()
            .map(|o| o.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    ));
    let _ = models;

    s.send_user("Reply with exactly the word pong.").await?;

    let mut t_init: Option<u128> = None;
    let mut saw_assistant = false;
    let mut sid = None;
    let t_after_send = Instant::now();
    loop {
        let Some(v) = s.recv(STEP).await? else {
            r.note("timeout/EOF before result");
            return Ok(r);
        };
        if v["type"] == "system" && v["subtype"] == "init" {
            t_init = Some(t_spawn.elapsed().as_millis());
            sid = v["session_id"].as_str().map(|s| s.to_string());
            r.note(format!(
                "system/init: session_id={} version={} capabilities={}",
                sid.clone().unwrap_or_default(),
                v["claude_code_version"].as_str().unwrap_or("<absent>"),
                v["capabilities"]
            ));
        }
        if v["type"] == "assistant" {
            saw_assistant = true;
        }
        if is_result(&v) {
            let ms = t_after_send.elapsed().as_millis();
            r.cost = cost_of(&v);
            r.note(format!(
                "result subtype={} is_error={} text={:?} in {}ms after first user frame",
                v["subtype"],
                v["is_error"],
                truncate(v["result"].as_str().unwrap_or(""), 60),
                ms
            ));
            r.note(format!(
                "spawn->system/init {}ms; init->result {}ms",
                t_init.unwrap_or(0),
                t_spawn.elapsed().as_millis() as i128 - t_init.unwrap_or(0) as i128
            ));
            r.note(format!("cost=${:.6}", r.cost));
            r.pass = saw_assistant && t_init.is_some() && v["is_error"] != true;
            break;
        }
    }
    *sid_out = sid;

    // stdin close -> exit
    s.close_stdin().await;
    match s.wait_exit(Duration::from_secs(20)).await {
        Some((code, ms)) => r.note(format!("stdin close -> exit code {code} in {ms}ms")),
        None => {
            r.note("stdin close -> STILL ALIVE after 20s");
            r.pass = false;
            let _ = s.kill().await;
        }
    }
    Ok(r)
}

// ------------------------------------------------------- scenarios 2 & 3 & 6

/// Shared driver for the echo prompt. `allow` picks the permission verdict.
/// `hooks` is the initialize hooks map.
async fn echo_scenario(
    label: &str,
    fixture: &str,
    allow: bool,
    hooks: Value,
    r: &mut Report,
) -> Result<(bool, bool)> {
    // returns (saw_can_use_tool, saw_hook_callback)
    // The owner's ~/.claude/settings.json sets `"defaultMode": "bypassPermissions"`,
    // which auto-approves every tool and means `can_use_tool` is never sent
    // (agent-sdk.md §3: auto-approved calls never reach the callback; the SDK
    // warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED for exactly this). A harness that
    // wants real approvals must pin the mode itself.
    // ...and even in `default` mode the CLI's own command-safety classifier
    // auto-approves a bare `echo`, so an explicit **ask rule** is what actually
    // forces the prompt onto the wire (docs precedence: hooks -> deny -> ask ->
    // mode -> allow -> can_use_tool). `--settings <json>` is the SDK's
    // `options.settings` (sdk.mjs `$K`/`KC`).
    let extra = vec![
        "--permission-mode".to_string(),
        "default".to_string(),
        "--settings".to_string(),
        r#"{"permissions":{"ask":["Bash"]}}"#.to_string(),
    ];
    let mut s = Session::spawn(fixture, &extra).await?;
    let init = s.initialize(hooks, STEP).await?;
    if init["response"]["subtype"] != "success" {
        r.note(format!(
            "initialize FAILED: {}",
            truncate(&init["response"].to_string(), 400)
        ));
        return Ok((false, false));
    }
    if let Some(h) = init["response"]["response"].get("hooks_applied") {
        r.note(format!("hooks_applied={h}"));
    } else {
        r.note("hooks_applied absent from initialize response");
    }

    s.send_user("Use the Bash tool to run: echo brigadier-spike-ok. Then reply done.")
        .await?;

    let mut saw_cut = false;
    let mut saw_hook = false;
    let mut saw_tool_result = false;
    loop {
        let Some(v) = s.recv(STEP).await? else {
            r.note("timeout/EOF before result");
            break;
        };
        if v["type"] == "control_request" {
            let sub = v["request"]["subtype"].as_str().unwrap_or("");
            let rid = v["request_id"].as_str().unwrap_or("").to_string();
            if sub == "can_use_tool" {
                saw_cut = true;
                r.note(format!(
                    "can_use_tool fields: {:?}",
                    v["request"]
                        .as_object()
                        .map(|o| o.keys().cloned().collect::<Vec<_>>())
                        .unwrap_or_default()
                ));
                r.note(format!(
                    "can_use_tool tool_name={} tool_use_id={}",
                    v["request"]["tool_name"], v["request"]["tool_use_id"]
                ));
                let resp = if allow {
                    json!({
                        "behavior": "allow",
                        "updatedInput": v["request"]["input"].clone()
                    })
                } else {
                    json!({ "behavior": "deny", "message": "denied by spike" })
                };
                s.send(&json!({
                    "type": "control_response",
                    "response": { "subtype": "success", "request_id": rid, "response": resp }
                }))
                .await?;
            } else if sub == "hook_callback" {
                saw_hook = true;
                r.note(format!(
                    "hook_callback callback_id={} hook_event_name={} tool={}",
                    v["request"]["callback_id"],
                    v["request"]["input"]["hook_event_name"],
                    v["request"]["input"]["tool_name"]
                ));
                s.send(&json!({
                    "type": "control_response",
                    "response": { "subtype": "success", "request_id": rid, "response": {} }
                }))
                .await?;
            } else {
                r.note(format!("unexpected control_request subtype={sub}"));
                s.send(&json!({
                    "type": "control_response",
                    "response": { "subtype": "error", "request_id": rid,
                                  "error": format!("spike does not handle {sub}") }
                }))
                .await?;
            }
        }
        if v["type"] == "user" && text_of(&v).contains("brigadier-spike-ok") {
            saw_tool_result = true;
            r.note("tool_result carries brigadier-spike-ok");
        }
        if is_result(&v) {
            r.cost = cost_of(&v);
            r.note(format!(
                "result subtype={} is_error={} text={:?}",
                v["subtype"],
                v["is_error"],
                truncate(v["result"].as_str().unwrap_or(""), 200)
            ));
            let pd = &v["permission_denials"];
            r.note(format!(
                "permission_denials={}",
                truncate(&pd.to_string(), 500)
            ));
            r.note(format!("cost=${:.6}", r.cost));
            if allow {
                r.pass = saw_cut && saw_tool_result && v["is_error"] != true;
            } else {
                r.pass = saw_cut
                    && !saw_tool_result
                    && pd.as_array().map(|a| !a.is_empty()).unwrap_or(false);
            }
            break;
        }
    }
    let _ = label;
    s.close_stdin().await;
    if s.wait_exit(Duration::from_secs(15)).await.is_none() {
        let _ = s.kill().await;
    }
    Ok((saw_cut, saw_hook))
}

async fn s2() -> Result<Report> {
    let mut r = Report::new("2 can-use-tool-allow");
    echo_scenario("allow", "s2-can-use-tool-allow", true, json!({}), &mut r).await?;
    Ok(r)
}

async fn s3() -> Result<Report> {
    let mut r = Report::new("3 can-use-tool-deny");
    echo_scenario("deny", "s3-can-use-tool-deny", false, json!({}), &mut r).await?;
    Ok(r)
}

async fn s6() -> Result<Report> {
    let mut r = Report::new("6 hook-callback");
    // Exactly the SDK's initialize hooks shape (sdk.mjs:47489-47506):
    // { <HookEvent>: [ { matcher, hookCallbackIds: [...], timeout? } ] }
    let hooks = json!({
        "PreToolUse": [ { "matcher": "Bash", "hookCallbackIds": ["hook_0"] } ]
    });
    let (_cut, hook) = echo_scenario("hook", "s6-hook-callback", true, hooks, &mut r).await?;
    r.pass = r.pass && hook;
    if !hook {
        r.note("NO hook_callback control_request ever arrived");
    }
    Ok(r)
}

// ---------------------------------------------------------------- scenario 4

async fn s4() -> Result<Report> {
    let mut r = Report::new("4 interrupt");
    let mut s = Session::spawn("s4-interrupt", &[]).await?;
    let init = s.initialize(json!({}), STEP).await?;
    if init["response"]["subtype"] != "success" {
        r.note("initialize failed");
        return Ok(r);
    }
    s.send_user("Count from 1 to 300, one number per line, nothing else.")
        .await?;

    let mut caps = String::new();
    let mut sent_interrupt = false;
    let mut interrupt_rid = String::new();
    let mut saw_ctrl_resp = false;
    let first_result;
    let t0 = Instant::now();
    loop {
        let Some(v) = s.recv(STEP).await? else {
            r.note("timeout/EOF waiting for first result");
            return Ok(r);
        };
        if v["type"] == "system" && v["subtype"] == "init" {
            caps = v["capabilities"].to_string();
        }
        if !sent_interrupt && (v["type"] == "assistant" || v["type"] == "stream_event") {
            sent_interrupt = true;
            interrupt_rid = s.next_request_id();
            r.note(format!(
                "first {} at {}ms; sending interrupt",
                v["type"].as_str().unwrap_or("?"),
                t0.elapsed().as_millis()
            ));
            s.send(&json!({
                "type": "control_request",
                "request_id": interrupt_rid,
                "request": { "subtype": "interrupt" }
            }))
            .await?;
        }
        if v["type"] == "control_response"
            && v["response"]["request_id"].as_str() == Some(interrupt_rid.as_str())
        {
            saw_ctrl_resp = true;
            r.note(format!(
                "interrupt control_response at {}ms: {}",
                t0.elapsed().as_millis(),
                truncate(&v["response"].to_string(), 300)
            ));
        }
        if is_result(&v) {
            r.cost = cost_of(&v);
            r.note(format!(
                "result#1 subtype={} terminal_reason={} at {}ms",
                v["subtype"],
                v["terminal_reason"],
                t0.elapsed().as_millis()
            ));
            first_result = Some(v);
            break;
        }
    }
    r.note(format!("capabilities={}", truncate(&caps, 400)));
    r.note(format!(
        "interrupt_receipt_v1 advertised: {}",
        caps.contains("interrupt_receipt_v1")
    ));

    // process still alive?
    let alive = s.wait_exit(Duration::from_millis(300)).await.is_none();
    r.note(format!("process alive after interrupt: {alive}"));

    // second turn on the same session
    let mut second_result = false;
    if alive {
        s.send_user("Reply with exactly the word pong.").await?;
        loop {
            let Some(v) = s.recv(STEP).await? else {
                r.note("timeout/EOF waiting for second result");
                break;
            };
            if is_result(&v) {
                r.cost = cost_of(&v); // cumulative on latest result (agent-sdk.md §6)
                second_result = true;
                r.note(format!(
                    "result#2 subtype={} is_error={} text={:?}",
                    v["subtype"],
                    v["is_error"],
                    truncate(v["result"].as_str().unwrap_or(""), 60)
                ));
                break;
            }
        }
    }
    r.note(format!("cost=${:.6}", r.cost));
    r.pass = saw_ctrl_resp
        && first_result
            .as_ref()
            .map(|v| !v["terminal_reason"].is_null())
            .unwrap_or(false)
        && alive
        && second_result;

    s.close_stdin().await;
    if s.wait_exit(Duration::from_secs(15)).await.is_none() {
        let _ = s.kill().await;
    }
    Ok(r)
}

// ---------------------------------------------------------------- scenario 5

async fn s5(sid: Option<String>) -> Result<Report> {
    let mut r = Report::new("5 resume");
    let Some(sid) = sid else {
        r.note("no session_id from scenario 1 -- skipped");
        return Ok(r);
    };
    // 0.3.257 argv shape: push(`--resume=${id}`) -- one arg, not two.
    let mut s = Session::spawn("s5-resume", &[format!("--resume={sid}")]).await?;
    let init = s.initialize(json!({}), STEP).await?;
    if init["response"]["subtype"] != "success" {
        r.note(format!(
            "initialize FAILED: {}",
            truncate(&init["response"].to_string(), 400)
        ));
        return Ok(r);
    }
    s.send_user("What single word did I ask you to reply with?")
        .await?;
    let mut resumed_sid = String::new();
    let mut answer = String::new();
    loop {
        let Some(v) = s.recv(STEP).await? else {
            r.note("timeout/EOF before result");
            break;
        };
        if v["type"] == "system" && v["subtype"] == "init" {
            resumed_sid = v["session_id"].as_str().unwrap_or("").to_string();
        }
        if v["type"] == "assistant" {
            answer.push_str(&text_of(&v));
        }
        if is_result(&v) {
            r.cost = cost_of(&v);
            if let Some(t) = v["result"].as_str() {
                answer.push_str(t);
            }
            r.note(format!("result subtype={} is_error={}", v["subtype"], v["is_error"]));
            break;
        }
    }
    r.note(format!("original session_id={sid}"));
    r.note(format!("resumed  session_id={resumed_sid}"));
    r.note(format!("session_id equal: {}", resumed_sid == sid));
    r.note(format!("answer={:?}", truncate(answer.trim(), 160)));
    r.note(format!("cost=${:.6}", r.cost));
    r.pass = answer.to_lowercase().contains("pong");

    s.close_stdin().await;
    if s.wait_exit(Duration::from_secs(15)).await.is_none() {
        let _ = s.kill().await;
    }
    Ok(r)
}

// ---------------------------------------------------------------- scenario 7

async fn s7() -> Result<Report> {
    let mut r = Report::new("7 kill");
    let before: Vec<u32> = pgrep_claude();
    let mut s = Session::spawn("s7-kill", &[]).await?;
    let pid = s.pid;
    let init = s.initialize(json!({}), STEP).await?;
    if init["response"]["subtype"] != "success" {
        r.note("initialize failed");
        return Ok(r);
    }
    s.send_user("Count from 1 to 300, one number per line, nothing else.")
        .await?;

    // wait for the stream to be genuinely in flight
    let mut streaming = false;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(60) {
        let Some(v) = s.recv(Duration::from_secs(60)).await? else {
            break;
        };
        if v["type"] == "assistant" || v["type"] == "stream_event" {
            streaming = true;
            break;
        }
        if is_result(&v) {
            r.note("result arrived before we could kill -- turn was too fast");
            break;
        }
    }
    r.note(format!("streaming before kill: {streaming}"));
    r.note(format!("child pid={:?}", pid));
    s.kill().await?;
    r.note(format!("killed at {}ms", t0.elapsed().as_millis()));

    // drain: anything still buffered? must contain no result
    let mut saw_result = false;
    while let Some(v) = s.recv(Duration::from_secs(3)).await? {
        if is_result(&v) {
            saw_result = true;
        }
    }
    r.note(format!("result after kill: {saw_result}"));

    tokio::time::sleep(Duration::from_millis(1500)).await;
    let after: Vec<u32> = pgrep_claude();
    let new: Vec<u32> = after
        .iter()
        .filter(|p| !before.contains(p))
        .copied()
        .collect();
    r.note(format!(
        "pgrep -f claude: {} before, {} after; new pids left behind: {:?}",
        before.len(),
        after.len(),
        new
    ));
    r.pass = !saw_result && new.is_empty();
    Ok(r)
}

// -------------------------------------------------------------------- driver

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let want = |n: &str| args.iter().any(|a| a == "all" || a == n) || args.is_empty();

    println!("claude binary : {CLAUDE_BIN}");
    let ver = std::process::Command::new(CLAUDE_BIN).arg("--version").output()?;
    println!("claude version: {}", String::from_utf8_lossy(&ver.stdout).trim());
    println!("model         : {}", model());
    println!("cwd           : {SPIKE_CWD}");
    println!("argv          : {}", build_argv(&[]).join(" "));
    println!("fixtures      : {FIXTURES}");
    println!();

    let mut reports: Vec<Report> = Vec::new();
    let mut sid: Option<String> = std::env::var("SPIKE_RESUME_SID").ok();

    macro_rules! run {
        ($n:expr, $fut:expr) => {
            if want($n) {
                match tokio::time::timeout(SCENARIO_TIMEOUT, $fut).await {
                    Ok(Ok(r)) => {
                        r.print();
                        reports.push(r);
                    }
                    Ok(Err(e)) => {
                        println!("FAIL {} :: error: {e:#}", $n);
                        reports.push(Report {
                            name: $n.to_string(),
                            ..Default::default()
                        });
                    }
                    Err(_) => {
                        println!("FAIL {} :: scenario exceeded 120s timeout", $n);
                        reports.push(Report {
                            name: $n.to_string(),
                            ..Default::default()
                        });
                    }
                }
            }
        };
    }

    run!("1", s1(&mut sid));
    run!("2", s2());
    run!("3", s3());
    run!("4", s4());
    run!("5", s5(sid.clone()));
    run!("6", s6());
    run!("7", s7());

    println!();
    println!("================ SUMMARY ================");
    let mut total = 0.0;
    for r in &reports {
        println!("{} {}", if r.pass { "PASS" } else { "FAIL" }, r.name);
        total += r.cost;
    }
    println!("total_cost_usd across scenarios: ${total:.6}");
    Ok(())
}
