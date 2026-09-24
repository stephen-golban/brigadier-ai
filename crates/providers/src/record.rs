//! Raw stdio recordings, the source of replay fixtures.
//!
//! A recording is JSONL: a header, then one line per stdio line in either direction with its
//! offset from the start. Personal data is scrubbed as it is written, so a recording can be
//! committed as a fixture: emails, account and organization identifiers and the home directory
//! never reach the file.

use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::ProviderKind;

/// Fixture format version.
pub const FORMAT: u32 = 1;

/// Keys whose string values identify the user or their account.
const PRIVATE_KEYS: &[&str] = &[
    "email",
    "orgId",
    "organization",
    "orgName",
    "accountId",
    "account_id",
    "accountUuid",
    "chatgptAccountId",
    "installationId",
    "userId",
    "user_id",
    "serverName",
    "userAgent",
    "user_agent",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// Brigadier → CLI (stdin).
    In,
    /// CLI → Brigadier (stdout).
    Out,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub fixture: u32,
    pub provider: ProviderKind,
    pub cli_version: Option<String>,
    pub recorded_at_ms: i64,
    /// What the recording shows, for the replay picker.
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// Milliseconds since the recording started.
    pub t: u64,
    pub dir: Direction,
    pub line: String,
}

/// Writes a recording on its own thread, so stdio handling never waits on the disk.
pub struct Recorder {
    started: Instant,
    lines: mpsc::Sender<Line>,
}

impl Recorder {
    pub fn create(path: &Path, header: &Header) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = BufWriter::new(std::fs::File::create(path)?);
        serde_json::to_writer(&mut file, header)?;
        file.write_all(b"\n")?;
        file.flush()?;

        let (lines, rx) = mpsc::channel::<Line>();
        let scrubber = Scrubber::new();
        let path = path.to_owned();
        std::thread::Builder::new()
            .name("cli-recorder".into())
            .spawn(move || {
                for mut line in rx {
                    line.line = scrubber.scrub_line(&line.line);
                    let written = serde_json::to_writer(&mut file, &line)
                        .map_err(std::io::Error::from)
                        .and_then(|()| file.write_all(b"\n"))
                        .and_then(|()| file.flush());
                    if let Err(err) = written {
                        tracing::warn!(path = %path.display(), error = %err, "recording stopped");
                        return;
                    }
                }
            })?;
        Ok(Self {
            started: Instant::now(),
            lines,
        })
    }

    pub fn record(&self, dir: Direction, line: &str) {
        let _ = self.lines.send(Line {
            t: self.started.elapsed().as_millis() as u64,
            dir,
            line: line.to_owned(),
        });
    }
}

/// A parsed recording.
pub struct Recording {
    pub header: Header,
    pub lines: Vec<Line>,
}

impl Recording {
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut rows = text.lines().filter(|line| !line.trim().is_empty());
        let header: Header = rows
            .next()
            .ok_or("the recording is empty")
            .and_then(|line| serde_json::from_str(line).map_err(|_| "bad recording header"))?;
        if header.fixture != FORMAT {
            return Err(format!("unsupported recording format {}", header.fixture));
        }
        let lines = rows
            .enumerate()
            .map(|(index, row)| {
                serde_json::from_str(row).map_err(|err| format!("line {}: {err}", index + 2))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self { header, lines })
    }
}

/// Removes personal data from recorded lines.
struct Scrubber {
    home: Option<String>,
}

impl Scrubber {
    fn new() -> Self {
        Self {
            home: dirs::home_dir()
                .map(|home| home.display().to_string())
                .filter(|home| home.len() > 1),
        }
    }

    fn scrub_line(&self, line: &str) -> String {
        match serde_json::from_str::<Value>(line) {
            Ok(mut value) => {
                self.scrub_value(&mut value, None);
                value.to_string()
            }
            Err(_) => self.scrub_text(line),
        }
    }

    fn scrub_value(&self, value: &mut Value, key: Option<&str>) {
        match value {
            Value::String(text) => {
                if key.is_some_and(|key| PRIVATE_KEYS.contains(&key)) {
                    *text = "redacted".into();
                } else {
                    *text = self.scrub_text(text);
                }
            }
            Value::Array(items) => items
                .iter_mut()
                .for_each(|item| self.scrub_value(item, key)),
            Value::Object(map) => {
                for (key, value) in map.iter_mut() {
                    self.scrub_value(value, Some(key));
                }
            }
            _ => {}
        }
    }

    fn scrub_text(&self, text: &str) -> String {
        let mut text = match &self.home {
            Some(home) => text.replace(home.as_str(), "~"),
            None => text.to_owned(),
        };
        if text.contains('@') {
            text = scrub_emails(&text);
        }
        text
    }
}

/// Replaces anything shaped like an email address.
fn scrub_emails(text: &str) -> String {
    let is_local = |c: char| c.is_ascii_alphanumeric() || "._%+-".contains(c);
    let is_domain = |c: char| c.is_ascii_alphanumeric() || ".-".contains(c);
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '@' {
            let local_len = out.chars().rev().take_while(|c| is_local(*c)).count();
            let domain_len = chars[index + 1..]
                .iter()
                .take_while(|c| is_domain(**c))
                .count();
            let domain: String = chars[index + 1..index + 1 + domain_len].iter().collect();
            let domain = domain.trim_end_matches('.');
            if local_len > 0 && domain.contains('.') {
                let keep = out.chars().count() - local_len;
                out = out.chars().take(keep).collect();
                out.push_str("user@example.com");
                index += 1 + domain.len();
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

/// Where recordings made from the Inspector are kept.
pub fn recordings_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("recordings")
}
