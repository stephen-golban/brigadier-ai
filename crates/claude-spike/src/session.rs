//! Minimal, dependency-free driver for the `claude` CLI stdio control protocol.
//!
//! Everything the CLI writes on stdout is one JSON object per line (NDJSON).
//! Every line is appended verbatim to `fixtures/<scenario>.ndjson` before it is
//! handed to the caller, so the fixtures are a faithful capture of the wire.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Write as _;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

pub const CLAUDE_BIN: &str = "/Users/stephen/.local/bin/claude";
pub const SPIKE_CWD: &str = "/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/c9b1b0ce-6420-4fcb-b7ae-26de66623b72/scratchpad/spike-cwd";
pub const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures");

/// Environment variables this harness (Claude Code itself) injects into every
/// child of its Bash tool. A real Brigadier desktop process would never have
/// them, and leaving them in nests the spike's child inside our own session.
/// Removing them is the one deliberate deviation from "inherit the parent env".
const HARNESS_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
];

pub fn model() -> String {
    std::env::var("SPIKE_MODEL").unwrap_or_else(|_| "claude-haiku-4-5".to_string())
}

/// The exact argv the SDK builds, in the SDK's own order (cli-protocol.md §1).
pub fn build_argv(extra: &[String]) -> Vec<String> {
    let mut v: Vec<String> = vec![
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--model".into(),
        model(),
        "--permission-prompt-tool".into(),
        "stdio".into(),
    ];
    v.extend_from_slice(extra);
    v
}

pub struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: mpsc::UnboundedReceiver<String>,
    pending: VecDeque<Value>,
    sent_log: std::fs::File,
    req_n: u64,
    pub spawned_at: Instant,
    pub pid: Option<u32>,
    #[allow(dead_code)]
    pub argv: Vec<String>,
    pub eof: bool,
}

impl Session {
    pub async fn spawn(scenario: &str, extra: &[String]) -> Result<Session> {
        std::fs::create_dir_all(FIXTURES)?;
        let out_path = format!("{FIXTURES}/{scenario}.ndjson");
        let err_path = format!("{FIXTURES}/{scenario}.stderr.txt");
        let sent_path = format!("{FIXTURES}/{scenario}.sent.ndjson");
        let mut out_f = std::fs::File::create(&out_path)?;
        let mut err_f = std::fs::File::create(&err_path)?;
        let sent_log = std::fs::File::create(&sent_path)?;

        let argv = build_argv(extra);
        let mut cmd = Command::new(CLAUDE_BIN);
        cmd.args(&argv)
            .current_dir(SPIKE_CWD)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Inherit the full parent environment (USER included -- sidecar-spike.md
        // landmine 3), then apply exactly what the SDK applies.
        cmd.env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts");
        cmd.env_remove("NODE_OPTIONS");
        cmd.env_remove("DEBUG");
        for k in HARNESS_VARS {
            cmd.env_remove(k);
        }

        let spawned_at = Instant::now();
        let mut child = cmd.spawn().context("spawn claude")?;
        let pid = child.id();

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdin = child.stdin.take().unwrap();

        let (tx, rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = writeln!(out_f, "{line}");
                let _ = out_f.flush();
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = writeln!(err_f, "{line}");
                let _ = err_f.flush();
            }
        });

        Ok(Session {
            child,
            stdin: Some(stdin),
            rx,
            pending: VecDeque::new(),
            sent_log,
            req_n: 0,
            spawned_at,
            pid,
            argv,
            eof: false,
        })
    }

    pub fn next_request_id(&mut self) -> String {
        self.req_n += 1;
        format!("spike_{}", self.req_n)
    }

    pub async fn send(&mut self, v: &Value) -> Result<()> {
        let line = serde_json::to_string(v)?;
        writeln!(self.sent_log, "{line}")?;
        self.sent_log.flush()?;
        let s = self
            .stdin
            .as_mut()
            .context("stdin already closed")?;
        s.write_all(line.as_bytes()).await?;
        s.write_all(b"\n").await?;
        s.flush().await?;
        Ok(())
    }

    /// Push a value back so the next `recv` returns it again.
    #[allow(dead_code)]
    pub fn unrecv(&mut self, v: Value) {
        self.pending.push_front(v);
    }

    /// Next JSON object from stdout. `Ok(None)` means EOF or timeout expired.
    pub async fn recv(&mut self, dur: Duration) -> Result<Option<Value>> {
        if let Some(v) = self.pending.pop_front() {
            return Ok(Some(v));
        }
        let deadline = Instant::now() + dur;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            match tokio::time::timeout(left, self.rx.recv()).await {
                Err(_) => return Ok(None),
                Ok(None) => {
                    self.eof = true;
                    return Ok(None);
                }
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(v) => return Ok(Some(v)),
                    Err(_) => {
                        eprintln!("    [non-JSON stdout line skipped] {}", truncate(&line, 160));
                        continue;
                    }
                },
            }
        }
    }

    /// Send `initialize` and wait for its `control_response`.
    /// `hooks` is the initialize `hooks` map (use `json!({})` for none).
    /// Any frame that arrives before the response (e.g. `system/init`) is
    /// buffered and returned by later `recv` calls, in order.
    pub async fn initialize(&mut self, hooks: Value, dur: Duration) -> Result<Value> {
        let rid = self.next_request_id();
        self.send(&json!({
            "type": "control_request",
            "request_id": rid,
            "request": { "subtype": "initialize", "hooks": hooks }
        }))
        .await?;
        let mut buf = Vec::new();
        let deadline = Instant::now() + dur;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let Some(v) = self.recv(left).await? else {
                for b in buf {
                    self.pending.push_back(b);
                }
                bail!("timed out or EOF waiting for initialize control_response");
            };
            if v["type"] == "control_response"
                && v["response"]["request_id"].as_str() == Some(rid.as_str())
            {
                for b in buf {
                    self.pending.push_back(b);
                }
                return Ok(v);
            }
            buf.push(v);
        }
    }

    pub async fn send_user(&mut self, text: &str) -> Result<()> {
        self.send(&json!({
            "type": "user",
            "message": { "role": "user", "content": text },
            "parent_tool_use_id": null
        }))
        .await
    }

    pub async fn close_stdin(&mut self) {
        self.stdin = None;
    }

    pub async fn wait_exit(&mut self, dur: Duration) -> Option<(i32, u128)> {
        let t0 = Instant::now();
        match tokio::time::timeout(dur, self.child.wait()).await {
            Ok(Ok(st)) => Some((st.code().unwrap_or(-1), t0.elapsed().as_millis())),
            _ => None,
        }
    }

    pub async fn kill(&mut self) -> Result<()> {
        self.child.start_kill()?;
        let _ = self.child.wait().await;
        Ok(())
    }
}

pub fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n).collect();
        format!("{t}...")
    }
}

/// Flatten `message.content` into plain text for eyeballing assistant replies.
pub fn text_of(msg: &Value) -> String {
    let c = &msg["message"]["content"];
    if let Some(s) = c.as_str() {
        return s.to_string();
    }
    let mut out = String::new();
    if let Some(arr) = c.as_array() {
        for b in arr {
            if let Some(t) = b["text"].as_str() {
                out.push_str(t);
            }
            if b["type"] == "tool_result" {
                out.push_str(&serde_json::to_string(&b["content"]).unwrap_or_default());
            }
        }
    }
    out
}

pub fn pgrep_claude() -> Vec<u32> {
    let out = std::process::Command::new("pgrep")
        .args(["-f", "claude"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}
