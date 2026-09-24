//! Raw stdio recordings, the source of replay fixtures.
//!
//! A recording is JSONL: a header, then one line per stdio line in either direction with its
//! offset from the start. Personal data is scrubbed as it is written, so a recording can be
//! committed as a fixture: emails, account and organization identifiers, the home directory and
//! user name (also in object keys, and when a stream splits a path) and the contents of the
//! user's Codex configuration never reach the file.

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
    /// The home directory's last component, replaced wherever it appears as a word: a streamed
    /// path can arrive split across deltas, out of reach of the home replacement.
    user: Option<String>,
}

impl Scrubber {
    fn new() -> Self {
        let home = dirs::home_dir();
        Self {
            user: home
                .as_ref()
                .and_then(|home| home.file_name())
                .and_then(|name| name.to_str())
                .filter(|name| name.len() >= 3)
                .map(str::to_owned),
            home: home
                .map(|home| home.display().to_string())
                .filter(|home| home.len() > 1),
        }
    }

    fn scrub_line(&self, line: &str) -> String {
        match serde_json::from_str::<Value>(line) {
            Ok(mut value) => {
                redact_codex_config(&mut value);
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
                let entries = std::mem::take(map);
                for (key, mut value) in entries {
                    self.scrub_value(&mut value, Some(&key));
                    map.insert(self.scrub_text(&key), value);
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
        if let Some(user) = &self.user
            && text.contains(user.as_str())
        {
            text = replace_word(&text, user, "user");
        }
        text
    }
}

/// Empties a Codex `config/read` result: it is the user's whole configuration (projects, MCP
/// servers, preferences), and replaying a session never needs it.
fn redact_codex_config(value: &mut Value) {
    let Some(result) = value.get_mut("result").and_then(Value::as_object_mut) else {
        return;
    };
    if result.contains_key("config") && result.contains_key("origins") {
        result.clear();
        result.insert("config".into(), Value::Object(Default::default()));
        result.insert("origins".into(), Value::Object(Default::default()));
    }
}

/// Replaces `word` where it is not part of a longer alphanumeric word.
fn replace_word(text: &str, word: &str, with: &str) -> String {
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(word) {
        let before = rest[..at].chars().next_back();
        let after = rest[at + word.len()..].chars().next();
        out.push_str(&rest[..at]);
        if before.is_some_and(is_word) || after.is_some_and(is_word) {
            out.push_str(word);
        } else {
            out.push_str(with);
        }
        rest = &rest[at + word.len()..];
    }
    out.push_str(rest);
    out
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
