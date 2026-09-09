//! Bounded JSON-lines RPC transport for a dedicated Codex app-server process.
use crate::driver::DriverError;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};

pub(crate) struct Rpc {
    pub child: Child,
    pub input: ChildStdin,
    pub output: BufReader<ChildStdout>,
    pub next_id: u64,
    partial: Vec<u8>,
}
impl Rpc {
    pub async fn spawn(
        binary: &Path,
        cwd: &Path,
        env: &BTreeMap<String, String>,
    ) -> Result<Self, DriverError> {
        let mut command = tokio::process::Command::new(binary);
        command
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(cwd)
            .envs(env)
            .env_remove("CODEX_THREAD_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|source| DriverError::Spawn {
            binary: binary.display().to_string(),
            source,
        })?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| protocol("Codex stdin missing"))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| protocol("Codex stdout missing"))?,
        );
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                // Consume diagnostics without logging possible credential-bearing config values.
                while read_line(&mut reader).await.is_ok_and(|s| s.is_some()) {}
            });
        }
        Ok(Self {
            child,
            input,
            output,
            next_id: 1,
            partial: Vec::new(),
        })
    }
    pub async fn write(&mut self, value: &Value) -> Result<(), DriverError> {
        write(&mut self.input, value).await
    }
    pub async fn read(&mut self) -> Result<Value, DriverError> {
        let line = read_line_buffered(&mut self.output, &mut self.partial)
            .await?
            .ok_or_else(|| protocol("Codex app-server closed stdout"))?;
        serde_json::from_str(&line).map_err(|_| protocol("Malformed Codex JSON frame"))
    }
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, DriverError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&json!({"id":id,"method":method,"params":params}))
            .await?;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let msg=self.read().await?;
                if msg.get("id")==Some(&json!(id)) && msg.get("method").is_none() { return result(msg); }
                if let Some(id)=msg.get("id") { self.write(&json!({"id":id,"error":{"code":-32601,"message":"Request unsupported during initialization"}})).await?; }
            }
        }).await.map_err(|_| protocol(format!("Codex {method} timed out")))?
    }
    pub async fn initialize(&mut self) -> Result<(), DriverError> {
        self.request("initialize",json!({"clientInfo":{"name":"brigadier","title":"Brigadier","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false,"requestAttestation":false}})).await?;
        self.write(&json!({"method":"initialized","params":{}}))
            .await
    }
    pub async fn kill(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.id().and_then(|id| i32::try_from(id).ok()) {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}
pub(crate) fn result(msg: Value) -> Result<Value, DriverError> {
    if let Some(error) = msg.get("error") {
        Err(protocol(format!(
            "Codex RPC error: {}",
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("request rejected")
        )))
    } else {
        msg.get("result")
            .cloned()
            .ok_or_else(|| protocol("Codex RPC response omitted result"))
    }
}
pub(crate) fn protocol(message: impl Into<String>) -> DriverError {
    DriverError::Protocol(message.into())
}
pub(crate) async fn write(input: &mut ChildStdin, value: &Value) -> Result<(), DriverError> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| protocol(e.to_string()))?;
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(10), input.write_all(&bytes))
        .await
        .map_err(|_| protocol("Codex write timed out; delivery unconfirmed"))?
        .map_err(|e| protocol(format!("Codex write failed; delivery unconfirmed: {e}")))?;
    input
        .flush()
        .await
        .map_err(|e| protocol(format!("Codex flush failed; delivery unconfirmed: {e}")))
}
// Bound before allocation, including a malicious line that never terminates.
async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<String>, DriverError> {
    read_line_buffered(reader, &mut Vec::new()).await
}
async fn read_line_buffered<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    bytes: &mut Vec<u8>,
) -> Result<Option<String>, DriverError> {
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|e| protocol(e.to_string()))?;
        if buffer.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(protocol("Truncated Codex frame"))
            };
        }
        let end = buffer.iter().position(|b| *b == b'\n').map(|n| n + 1);
        let count = end.unwrap_or(buffer.len());
        if bytes.len() + count > 8 * 1024 * 1024 {
            return Err(protocol("Codex frame exceeds 8 MiB"));
        }
        bytes.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if end.is_some() {
            return String::from_utf8(std::mem::take(bytes))
                .map(Some)
                .map_err(|_| protocol("Codex frame is not UTF-8"));
        }
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.id().and_then(|id| i32::try_from(id).ok()) {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn interrupted_read_retains_partial_json() {
        let (mut writer, reader) = tokio::io::duplex(128);
        let mut reader = BufReader::new(reader);
        let mut partial = Vec::new();
        writer.write_all(b"{\"id\":").await.unwrap();
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            read_line_buffered(&mut reader, &mut partial)
        )
        .await
        .is_err());
        writer.write_all(b"1}\n").await.unwrap();
        assert_eq!(
            read_line_buffered(&mut reader, &mut partial)
                .await
                .unwrap()
                .as_deref(),
            Some("{\"id\":1}\n")
        );
        assert!(partial.is_empty());
    }
}
