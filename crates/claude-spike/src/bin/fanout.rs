//! WO-F: head-to-head measurement of the two ways to do N independent pieces of
//! work with the `claude` CLI.
//!
//!   Arm A — direct children : the harness spawns N children, one per piece.
//!   Arm B — fan-out         : one child is told to use its `Agent` tool for the N pieces.
//!
//! `docs/vision.md` §6 asserts A beats B on tokens, wall clock and usage-window
//! consumption, and admits the head-to-head "has not been measured". This binary
//! measures it. Results: `docs/research/fanout-vs-children.md`.
//!
//! Usage:  cargo run -p claude-spike --bin fanout -- warm
//!         cargo run -p claude-spike --bin fanout -- a
//!         cargo run -p claude-spike --bin fanout -- b
//!
//! Each phase is a separate invocation on purpose: the tree must be reset to an
//! identical state between arms, and a run that overshoots the spend cap must be
//! stoppable without killing the ones already banked.

#[path = "../session.rs"]
mod session;

use anyhow::Result;
use serde_json::{json, Value};
use session::*;
use std::io::Write as _;
use std::time::{Duration, Instant};

/// Long enough for a Haiku turn with two tool calls; short enough to notice a hang.
const STEP: Duration = Duration::from_secs(120);
/// How long to keep reading after the last `result` on a single-turn arm.
const GRACE_SINGLE: Duration = Duration::from_secs(5);
/// Ditto on the fan-out arm, where a background subagent can reopen the session
/// and emit a second `result` with no prompt from us (wall-hooks.md, run 9).
const GRACE_FANOUT: Duration = Duration::from_secs(25);
/// Hard ceiling on one child, whatever it is doing.
const HARD: Duration = Duration::from_secs(300);

/// Everything one child produced, in the form the accounting script wants.
#[derive(Default)]
struct RunOut {
    fixture: String,
    /// Recorded so the fixtures prove the shape: Arm A is N distinct OS
    /// processes, Arm B is one.
    pid: Option<u32>,
    wall_ms: u128,
    spawn_to_init_ms: u128,
    session_id: Option<String>,
    transcript_path: Option<String>,
    results: Vec<Value>,
    rate_limits: Vec<Value>,
    subagent_starts: Vec<String>,
    subagent_stops: Vec<String>,
    sub_transcripts: Vec<String>,
    tools: Vec<String>,
    frames: usize,
    assistant_texts: Vec<String>,
}

impl RunOut {
    fn to_json(&self) -> Value {
        json!({
            "fixture": self.fixture,
            "pid": self.pid,
            "wall_ms": self.wall_ms,
            "spawn_to_init_ms": self.spawn_to_init_ms,
            "session_id": self.session_id,
            "transcript_path": self.transcript_path,
            "sub_transcripts": self.sub_transcripts,
            "subagent_starts": self.subagent_starts,
            "subagent_stops": self.subagent_stops,
            "tools": self.tools,
            "frames": self.frames,
            "n_results": self.results.len(),
            "results": self.results,
            "rate_limits": self.rate_limits,
            "assistant_texts": self.assistant_texts,
        })
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Stop on the first `result` plus a short grace.
    Single,
    /// Keep reading until every subagent that started has stopped *and* a
    /// `result` has landed after the last of them.
    Fanout,
}

/// Identical on both arms. `bypassPermissions` so no `can_use_tool` round-trip
/// distorts wall clock; `--strict-mcp-config` so the owner's MCP servers stay out
/// of the system prompt (125 tools -> 33, wall-hooks.md).
fn common_argv() -> Vec<String> {
    vec![
        "--permission-mode".into(),
        "bypassPermissions".into(),
        "--strict-mcp-config".into(),
    ]
}

/// Registered identically on both arms so hook latency is not a confound.
/// `SubagentStart`/`SubagentStop` are how the fan-out arm knows it is finished and
/// where the subagent transcripts are; `PreToolUse` is the record of what ran.
fn hooks() -> Value {
    json!({
        "PreToolUse":    [ { "matcher": "", "hookCallbackIds": ["cb_pre"] } ],
        "SubagentStart": [ { "matcher": "", "hookCallbackIds": ["cb_substart"] } ],
        "SubagentStop":  [ { "matcher": "", "hookCallbackIds": ["cb_substop"] } ]
    })
}

async fn drive(fixture: &str, prompt: &str, mode: Mode) -> Result<RunOut> {
    let mut out = RunOut {
        fixture: fixture.to_string(),
        ..Default::default()
    };
    let mut hook_log = std::fs::File::create(format!("{FIXTURES}/{fixture}.hooks.ndjson"))?;

    let mut s = Session::spawn(fixture, &common_argv()).await?;
    let t_spawn = s.spawned_at;
    out.pid = s.pid;
    let init = s.initialize(hooks(), STEP).await?;
    if init["response"]["subtype"] != "success" {
        anyhow::bail!("initialize failed: {}", init["response"]);
    }

    let t0 = Instant::now();
    s.send_user(prompt).await?;

    let hard_deadline = Instant::now() + HARD;
    let mut grace_until: Option<Instant> = None;

    loop {
        let now = Instant::now();
        if now >= hard_deadline {
            eprintln!("[{fixture}] hard deadline hit");
            break;
        }
        let budget = match grace_until {
            Some(u) => u.saturating_duration_since(now),
            None => STEP.min(hard_deadline - now),
        };
        if budget.is_zero() {
            break;
        }
        let Some(v) = s.recv(budget).await? else {
            if grace_until.is_none() {
                eprintln!("[{fixture}] timeout/EOF with no result pending");
            }
            break;
        };
        out.frames += 1;

        match v["type"].as_str().unwrap_or("") {
            "system" if v["subtype"] == "init" => {
                if out.session_id.is_none() {
                    out.spawn_to_init_ms = t_spawn.elapsed().as_millis();
                    out.session_id = v["session_id"].as_str().map(str::to_string);
                }
            }
            "rate_limit_event" => {
                let mut e = v.clone();
                e["_at_ms"] = json!(t0.elapsed().as_millis());
                e["_wall_unix_ms"] = json!(unix_ms());
                out.rate_limits.push(e);
            }
            "assistant" => {
                let t = text_of(&v);
                if !t.trim().is_empty() {
                    out.assistant_texts.push(truncate(&t, 200));
                }
            }
            "control_request" => {
                let rid = v["request_id"].as_str().unwrap_or("").to_string();
                let sub = v["request"]["subtype"].as_str().unwrap_or("");
                match sub {
                    "hook_callback" => {
                        writeln!(hook_log, "{}", serde_json::to_string(&v)?)?;
                        hook_log.flush()?;
                        let input = &v["request"]["input"];
                        let ev = input["hook_event_name"].as_str().unwrap_or("");
                        if out.transcript_path.is_none() {
                            out.transcript_path =
                                input["transcript_path"].as_str().map(str::to_string);
                        }
                        match ev {
                            "PreToolUse" => {
                                let agent = input["agent_id"].as_str().unwrap_or("-");
                                out.tools.push(format!(
                                    "{}@{}",
                                    input["tool_name"].as_str().unwrap_or("?"),
                                    agent
                                ));
                            }
                            "SubagentStart" => {
                                if let Some(id) = input["agent_id"].as_str() {
                                    out.subagent_starts.push(id.to_string());
                                }
                                // A subagent just launched: the turn is not over,
                                // whatever a `result` frame said.
                                grace_until = None;
                            }
                            "SubagentStop" => {
                                if let Some(id) = input["agent_id"].as_str() {
                                    out.subagent_stops.push(id.to_string());
                                }
                                if let Some(p) = input["agent_transcript_path"].as_str() {
                                    out.sub_transcripts.push(p.to_string());
                                }
                            }
                            _ => {}
                        }
                        s.answer_ok(&rid, json!({})).await?;
                    }
                    "can_use_tool" => {
                        // Should not fire under bypassPermissions; allow if it does.
                        s.answer_ok(
                            &rid,
                            json!({ "behavior": "allow", "updatedInput": v["request"]["input"] }),
                        )
                        .await?;
                    }
                    other => {
                        s.answer_err(&rid, &format!("fanout spike does not handle {other}"))
                            .await?;
                    }
                }
            }
            "result" => {
                let mut e = v.clone();
                e["_at_ms"] = json!(t0.elapsed().as_millis());
                out.results.push(e);
                let outstanding = out.subagent_starts.len() > out.subagent_stops.len();
                match mode {
                    Mode::Single => grace_until = Some(Instant::now() + GRACE_SINGLE),
                    Mode::Fanout => {
                        if outstanding {
                            // result#1 = "launched in the background". Keep reading.
                            grace_until = None;
                        } else {
                            grace_until = Some(Instant::now() + GRACE_FANOUT);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    out.wall_ms = t0.elapsed().as_millis();
    s.close_stdin().await;
    if s.wait_exit(Duration::from_secs(15)).await.is_none() {
        let _ = s.kill().await;
    }
    Ok(out)
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The three pieces. Byte-identical text is handed to an Arm-A child and to an
/// Arm-B subagent, so only the coordination differs between the arms.
const PIECES: [&str; 3] = ["alpha", "bravo", "charlie"];

fn piece_prompt(name: &str) -> String {
    format!(
        "Read src/{name}.py and write a one-paragraph summary of what it does to \
         summaries/{name}.md. Do not read or write any other file. \
         Reply with exactly the word done."
    )
}

fn dump(tag: &str, runs: &[RunOut], wall_ms: u128) -> Result<()> {
    let v = json!({
        "tag": tag,
        "arm_wall_ms": wall_ms,
        "runs": runs.iter().map(|r| r.to_json()).collect::<Vec<_>>(),
    });
    let p = format!("{FIXTURES}/f-{tag}.summary.json");
    std::fs::write(&p, serde_json::to_string_pretty(&v)?)?;
    println!("wrote {p}");
    for r in runs {
        println!(
            "  {} pid={:?} wall={}ms init={}ms results={} subs={}/{} tools={:?} frames={}",
            r.fixture,
            r.pid,
            r.wall_ms,
            r.spawn_to_init_ms,
            r.results.len(),
            r.subagent_stops.len(),
            r.subagent_starts.len(),
            r.tools,
            r.frames
        );
        for res in &r.results {
            println!(
                "    result subtype={} num_turns={} cost={} @{}ms text={:?}",
                res["subtype"],
                res["num_turns"],
                res["total_cost_usd"],
                res["_at_ms"],
                truncate(res["result"].as_str().unwrap_or(""), 90)
            );
        }
        for rl in &r.rate_limits {
            println!(
                "    rate_limit @{}ms unifiedWindows={}",
                rl["_at_ms"], rl["rate_limit_info"]["unifiedWindows"]
            );
        }
    }
    println!("  arm wall clock: {wall_ms}ms");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let phase = args.first().map(String::as_str).unwrap_or("");

    println!("claude   : {CLAUDE_BIN}");
    let ver = std::process::Command::new(CLAUDE_BIN).arg("--version").output()?;
    println!("version  : {}", String::from_utf8_lossy(&ver.stdout).trim());
    println!("model    : {}", model());
    println!("cwd      : {}", spike_cwd());
    println!("argv     : {}", build_argv(&common_argv()).join(" "));
    println!();

    // Orphan check (docs/research/orphan-sweep.md): any `claude` pid alive after
    // the phase that was not alive before it is litter this spike left behind.
    let pids_before: std::collections::HashSet<u32> = pgrep_claude().into_iter().collect();

    let t_arm = Instant::now();
    match phase {
        // Prime the server-side prompt cache for the host system prompt so that
        // neither arm pays the cold cache-creation bill purely for going first.
        "warm" => {
            let r = drive(
                "f-warm",
                "Reply with exactly the word ok. Do not use any tool.",
                Mode::Single,
            )
            .await?;
            dump("warm", &[r], t_arm.elapsed().as_millis())?;
        }

        // Arm A: N children, one per piece, launched together.
        "a" => {
            let mut handles = Vec::new();
            for (i, name) in PIECES.iter().enumerate() {
                let fixture = format!("f-a{}-{}", i + 1, name);
                let prompt = piece_prompt(name);
                handles.push(tokio::spawn(async move {
                    drive(&fixture, &prompt, Mode::Single).await
                }));
            }
            let mut runs = Vec::new();
            for h in handles {
                runs.push(h.await??);
            }
            dump("a", &runs, t_arm.elapsed().as_millis())?;
        }

        // Arm B: one child, told to fan out over the same three pieces.
        "b" => {
            let list = PIECES
                .iter()
                .map(|p| format!("src/{p}.py"))
                .collect::<Vec<_>>()
                .join(", ");
            let prompt = format!(
                "There are three files to summarise: {list}.\n\
                 Use your Agent tool to spawn three subagents, one per file, launching all three \
                 in a single message so they run in parallel. Give each subagent exactly this \
                 instruction, with its own file name substituted for NAME:\n\
                 \"{}\"\n\
                 Do not read, summarise or write any file yourself. When all three subagents have \
                 finished, reply with exactly the word done.",
                piece_prompt("NAME")
            );
            let r = drive("f-b-fanout", &prompt, Mode::Fanout).await?;
            dump("b", &[r], t_arm.elapsed().as_millis())?;
        }

        _ => {
            eprintln!("usage: fanout <warm|a|b>");
            std::process::exit(2);
        }
    }

    let leaked: Vec<u32> = pgrep_claude()
        .into_iter()
        .filter(|p| !pids_before.contains(p))
        .collect();
    println!("  claude pids alive after phase that were not alive before: {leaked:?}");
    Ok(())
}
