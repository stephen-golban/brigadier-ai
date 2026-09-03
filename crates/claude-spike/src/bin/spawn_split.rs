//! WO: split the pre-`system/init` cost of a `claude` spawn.
//!
//! `docs/STATUS.md` records 719 ms from spawn to the `initialize`
//! `control_response` and 569-1,981 ms from spawn to `system/init`. Nobody had
//! split what sits in there. This machine has two MCP servers in the user's
//! settings (`higgsfield`, `pencil`), so the CLI may be connecting them on every
//! spawn; if it is, MCP is the dominant per-spawn cost and the pool-versus-reuse
//! decision changes.
//!
//! Two arms, alternating, same machine, back to back:
//!
//!   on  - default argv. Whatever MCP the user's settings configure is loaded.
//!   off - default argv plus `--strict-mcp-config`, which the CLI's own help
//!         calls "Only use MCP servers from --mcp-config, ignoring all other MCP
//!         configurations". No `--mcp-config` is passed, so the allowed set is
//!         empty.
//!
//! Three latencies per run, all from `Session::spawned_at`, all off frame
//! *arrival* (`Session::last_arrival`), never off drain time:
//!
//!   spawn -> `initialize` control_response
//!   spawn -> `system/init`
//!   first user frame -> `result`
//!
//! The arm is proven per run, not assumed: every run records the `mcp_servers`
//! array off its own `system/init` frame.
//!
//! Results: `docs/research/spawn-split.md`.
//!
//! Usage:  cargo run -p claude-spike --bin spawn_split -- 6
//!         (argument = pairs; 6 pairs = 12 spawns = the spend cap)

#[path = "../session.rs"]
mod session;

use anyhow::{bail, Result};
use serde_json::{json, Value};
use session::*;
use std::io::Write as _;
use std::time::{Duration, Instant};

/// One short turn on Haiku is seconds; this only has to catch a hang.
const STEP: Duration = Duration::from_secs(120);
/// Hard ceiling on one child.
const HARD: Duration = Duration::from_secs(180);
/// The whole spend control: one short turn, one word back.
const PROMPT: &str = "Reply with the word pong. Nothing else.";

#[derive(Clone, Copy, PartialEq)]
enum Arm {
    On,
    Off,
}

impl Arm {
    fn tag(self) -> &'static str {
        match self {
            Arm::On => "on",
            Arm::Off => "off",
        }
    }
    /// The only difference between the arms.
    fn extra(self) -> Vec<String> {
        match self {
            Arm::On => vec![],
            Arm::Off => vec!["--strict-mcp-config".to_string()],
        }
    }
}

#[derive(Default)]
struct RunOut {
    fixture: String,
    arm: String,
    pid: Option<u32>,
    argv: Vec<String>,
    /// spawn -> `initialize` control_response, off arrival.
    spawn_to_initialize_ms: u128,
    /// spawn -> `system/init`, off arrival.
    spawn_to_init_ms: u128,
    /// first user frame -> `result`, off arrival.
    user_to_result_ms: u128,
    /// Proof of the arm: the `mcp_servers` array the child itself reported.
    mcp_servers: Value,
    session_id: Option<String>,
    claude_code_version: Option<String>,
    cost_usd: f64,
    result_subtype: Option<String>,
    result_is_error: Option<bool>,
    result_text: Option<String>,
    /// The CLI's own clock for the turn, for comparison with our wall.
    duration_ms: Option<u64>,
    duration_api_ms: Option<u64>,
    exit_code: Option<i32>,
    exit_ms: Option<u128>,
    frames: usize,
}

impl RunOut {
    fn to_json(&self) -> Value {
        json!({
            "fixture": self.fixture,
            "arm": self.arm,
            "pid": self.pid,
            "argv": self.argv,
            "spawn_to_initialize_ms": self.spawn_to_initialize_ms,
            "spawn_to_init_ms": self.spawn_to_init_ms,
            "user_to_result_ms": self.user_to_result_ms,
            "mcp_servers": self.mcp_servers,
            "session_id": self.session_id,
            "claude_code_version": self.claude_code_version,
            "cost_usd": self.cost_usd,
            "result_subtype": self.result_subtype,
            "result_is_error": self.result_is_error,
            "result_text": self.result_text,
            "duration_ms": self.duration_ms,
            "duration_api_ms": self.duration_api_ms,
            "exit_code": self.exit_code,
            "exit_ms": self.exit_ms,
            "frames": self.frames,
        })
    }
}

async fn one_run(arm: Arm, n: usize) -> Result<RunOut> {
    let fixture = format!("spawn-split/{}-{n}", arm.tag());
    let mut out = RunOut {
        fixture: fixture.clone(),
        arm: arm.tag().to_string(),
        ..Default::default()
    };

    let mut s = Session::spawn(&fixture, &arm.extra()).await?;
    let t_spawn = s.spawned_at;
    out.pid = s.pid;
    out.argv = s.argv.clone();

    // No hooks: a hook round trip would be a confound on the handshake leg.
    let init = s.initialize(json!({}), STEP).await?;
    out.spawn_to_initialize_ms = s.last_arrival.duration_since(t_spawn).as_millis();
    if init["response"]["subtype"] != "success" {
        bail!("[{fixture}] initialize failed: {}", init["response"]);
    }

    s.send_user(PROMPT).await?;
    let t_user = Instant::now();

    let hard_deadline = Instant::now() + HARD;
    let mut saw_init = false;
    let mut saw_result = false;
    loop {
        let now = Instant::now();
        if now >= hard_deadline {
            eprintln!("[{fixture}] hard deadline");
            break;
        }
        let Some(v) = s.recv(STEP.min(hard_deadline - now)).await? else {
            eprintln!("[{fixture}] timeout/EOF");
            break;
        };
        out.frames += 1;
        let at = s.last_arrival;

        match v["type"].as_str().unwrap_or("") {
            "system" if v["subtype"] == "init" && !saw_init => {
                saw_init = true;
                out.spawn_to_init_ms = at.duration_since(t_spawn).as_millis();
                out.mcp_servers = v["mcp_servers"].clone();
                out.session_id = v["session_id"].as_str().map(str::to_string);
                out.claude_code_version = v["claude_code_version"].as_str().map(str::to_string);
            }
            "control_request" => {
                // Nothing here should ask us anything, but a control_request left
                // unanswered stalls the child. Refuse and keep going.
                let rid = v["request_id"].as_str().unwrap_or("").to_string();
                let sub = v["request"]["subtype"].as_str().unwrap_or("").to_string();
                eprintln!("[{fixture}] unexpected control_request {sub}");
                s.answer_err(&rid, "spawn_split answers nothing").await?;
            }
            "result" => {
                out.user_to_result_ms = at.duration_since(t_user).as_millis();
                out.cost_usd = v["total_cost_usd"].as_f64().unwrap_or(0.0);
                out.result_subtype = v["subtype"].as_str().map(str::to_string);
                out.result_is_error = v["is_error"].as_bool();
                out.result_text = v["result"].as_str().map(|t| truncate(t, 80));
                out.duration_ms = v["duration_ms"].as_u64();
                out.duration_api_ms = v["duration_api_ms"].as_u64();
                saw_result = true;
                break;
            }
            _ => {}
        }
    }
    if !saw_result {
        eprintln!("[{fixture}] NO RESULT FRAME");
    }

    s.close_stdin().await;
    match s.wait_exit(Duration::from_secs(20)).await {
        Some((code, ms)) => {
            out.exit_code = Some(code);
            out.exit_ms = Some(ms);
        }
        None => {
            eprintln!("[{fixture}] still alive after 20s; killing");
            let _ = s.kill().await;
        }
    }
    Ok(out)
}

fn median(mut v: Vec<u128>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_unstable();
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2] as f64
    } else {
        (v[n / 2 - 1] + v[n / 2]) as f64 / 2.0
    }
}

fn summarise(runs: &[RunOut], arm: &str) -> Value {
    let pick = |f: fn(&RunOut) -> u128| -> Vec<u128> {
        runs.iter().filter(|r| r.arm == arm).map(f).collect()
    };
    json!({
        "n": runs.iter().filter(|r| r.arm == arm).count(),
        "median_spawn_to_initialize_ms": median(pick(|r| r.spawn_to_initialize_ms)),
        "median_spawn_to_init_ms": median(pick(|r| r.spawn_to_init_ms)),
        "median_user_to_result_ms": median(pick(|r| r.user_to_result_ms)),
        "cost_usd": runs.iter().filter(|r| r.arm == arm).map(|r| r.cost_usd).sum::<f64>(),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let pairs: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(5);
    // Hard spend fuse: 12 spawns is the cap in the work order.
    if pairs * 2 > 12 {
        bail!("{} pairs = {} spawns, over the 12-spawn cap", pairs, pairs * 2);
    }
    println!("cwd={}  model={}", spike_cwd(), model());
    println!("{pairs} pairs = {} spawns, alternating on/off", pairs * 2);

    let mut runs: Vec<RunOut> = Vec::new();
    for n in 1..=pairs {
        for arm in [Arm::On, Arm::Off] {
            let r = one_run(arm, n).await?;
            println!(
                "{:>3} {:<4} initialize {:>5}ms  system/init {:>5}ms  user->result {:>6}ms  \
                 mcp={}  cost=${:.6}  exit={:?}",
                n,
                r.arm,
                r.spawn_to_initialize_ms,
                r.spawn_to_init_ms,
                r.user_to_result_ms,
                r.mcp_servers,
                r.cost_usd,
                r.exit_code,
            );
            runs.push(r);
            // Nothing of ours should survive the run.
            let alive = pgrep_claude();
            if !alive.is_empty() {
                eprintln!("    [pgrep claude] {alive:?}  (includes this harness's own session)");
            }
        }
    }

    let total: f64 = runs.iter().map(|r| r.cost_usd).sum();
    let summary = json!({
        "generated_by": "cargo run -p claude-spike --bin spawn_split",
        "cwd": spike_cwd(),
        "model": model(),
        "prompt": PROMPT,
        "spawns": runs.len(),
        "total_cost_usd": total,
        "arms": { "on": summarise(&runs, "on"), "off": summarise(&runs, "off") },
        "runs": runs.iter().map(RunOut::to_json).collect::<Vec<_>>(),
    });
    let path = format!("{FIXTURES}/spawn-split.summary.json");
    let mut f = std::fs::File::create(&path)?;
    writeln!(f, "{}", serde_json::to_string_pretty(&summary)?)?;

    println!("\n-- medians (ms) --");
    for arm in ["on", "off"] {
        let s = summarise(&runs, arm);
        println!(
            "{arm:<4} n={} initialize {} system/init {} user->result {}",
            s["n"], s["median_spawn_to_initialize_ms"], s["median_spawn_to_init_ms"],
            s["median_user_to_result_ms"]
        );
    }
    println!("total_cost_usd = ${total:.6}");
    println!("summary -> {path}");
    Ok(())
}
