//! Local PTYs owned by the window. Bytes stay bytes across reads (UTF-8 can split anywhere).
use crate::{error::AppError, state::AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock, Weak,
    },
    time::Duration,
};
use tauri::{ipc::Channel, State};

struct Terminal {
    /// The registry key, and the id this shell's pid record is filed under.
    id: String,
    session_id: Option<String>,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    output: Arc<Mutex<Output>>,
    exited: Arc<AtomicBool>,
    pid: Option<u32>,
    drained: Arc<AtomicBool>,
    /// The push half of this terminal: the same ring, plus whatever channel the webview last
    /// handed us. Idle until `terminal_subscribe` is called.
    stream: Arc<Stream>,
    cwd: std::path::PathBuf,
    // The waiter owns the lease until the shell exits. Terminal tabs at the same
    // canonical root share it; keeping an exited tab open must not retain ownership.
    lease: Weak<brigadier_core::checkpoint::WorkspaceLease>,
}
#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    dropped: usize,
}

/// The ring the reader thread fills, and the only buffer between the PTY and the webview. The
/// channel adds none of its own as long as every message stays on the `eval` path; see
/// [`FRAME_PAYLOAD`].
const RING_BYTES: usize = 1024 * 1024;
/// PTY bytes per frame. 4096 bytes encode to 5464 base64 characters, so the largest message this
/// sends is about 5.6 KB — under tauri's 8192-byte `MAX_JSON_DIRECT_EXECUTE_THRESHOLD`
/// (`tauri-2.11.5/src/ipc/channel.rs`), which is the line between `webview.eval` and the
/// **unbounded** `ChannelDataIpcQueue`. Crossing it is the one thing this path may not do.
const FRAME_PAYLOAD: usize = 4096;
/// Frames one flush may send back to back: 128 KiB, so a ~8 MB/s ceiling at [`FLUSH_INTERVAL`].
/// The cap is what keeps a burst from turning into an unbounded run of `eval` calls; anything past
/// it waits for the next flush in the ring, not in a queue. 8 frames (2 MB/s) sat under the old
/// re-armed 8 KiB poll, so a `yes`-class writer would have paced against the flush rather than the
/// ring.
const FRAMES_PER_FLUSH: usize = 32;
/// At most one flush per animation frame, the feed channel's rule. A flush after an idle stretch
/// happens immediately; the interval only spaces flushes that follow one.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// One frame of terminal output on its way to the webview.
///
/// `bytes` is base64 rather than the `number[]` `terminal_read` returns: a JSON array costs up to
/// four characters per byte, base64 exactly four per three, and the whole serialized message has
/// to stay under 8192 bytes (see [`FRAME_PAYLOAD`]).
#[derive(Clone, Serialize)]
pub(crate) struct TerminalFrame {
    /// 1-based and strictly increasing per terminal id, across subscriptions. A gap means the
    /// channel dropped a message, never that this code skipped one.
    seq: u64,
    /// Base64 of at most [`FRAME_PAYLOAD`] PTY bytes, in the order the PTY produced them. Empty
    /// on the final frame.
    bytes: String,
    /// Bytes the ring discarded *before* the bytes in this frame, since the previous frame. The
    /// same overflow counter `terminal_read` returns as `dropped`, read by whichever of the two
    /// takes it first.
    dropped_before: usize,
    /// True on exactly one frame: the last, sent once the ring is empty **and** the PTY has
    /// reached EOF — the same condition as `terminal_read`'s `exited`.
    exited: bool,
    /// Whether the PTY reader has reached EOF. Always true on the final frame.
    drained: bool,
}

/// The push half of one terminal: the ring, a condvar the reader signals, and at most one webview
/// channel.
///
/// There is no timer anywhere in here. The forwarder parks on `wake` and is woken by the reader
/// thread, the child waiter, or [`Terminal::drop`]; an idle PTY costs nothing at either end.
struct Stream {
    output: Arc<Mutex<Output>>,
    /// Signalled with `output` unlocked or locked; every waiter re-checks its own predicate.
    wake: Condvar,
    /// Replaced, never added to — the same rule as the feed sink (`src-tauri/src/sink.rs`): a
    /// reload wipes the JS callback registry and a `send` on the old channel is silently lost.
    channel: Mutex<Option<Channel<TerminalFrame>>>,
    exited: Arc<AtomicBool>,
    drained: Arc<AtomicBool>,
    /// Set by `Terminal::drop`; the forwarder stops without sending an exit frame.
    closed: AtomicBool,
    /// One forwarder thread per terminal at most. Cleared when it returns, so a later
    /// subscription starts a new one.
    forwarding: AtomicBool,
    seq: AtomicU64,
    /// Bumped under the channel lock by every subscription. A forwarder about to stop compares it
    /// with what it saw, so a channel installed in that window restarts it instead of being left
    /// with nobody pushing.
    epoch: AtomicU64,
}

impl Stream {
    fn new(output: Arc<Mutex<Output>>, exited: Arc<AtomicBool>, drained: Arc<AtomicBool>) -> Self {
        Self {
            output,
            wake: Condvar::new(),
            channel: Mutex::new(None),
            exited,
            drained,
            closed: AtomicBool::new(false),
            forwarding: AtomicBool::new(false),
            seq: AtomicU64::new(1),
            epoch: AtomicU64::new(0),
        }
    }
    fn lock_output(&self) -> std::sync::MutexGuard<'_, Output> {
        self.output.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Append one PTY read to the ring, discarding the oldest bytes past [`RING_BYTES`], and wake
    /// the forwarder. The reader thread's only contact with the rest of this module.
    fn push(&self, chunk: &[u8]) {
        {
            let mut out = self.lock_output();
            out.bytes.extend(chunk);
            let excess = out.bytes.len().saturating_sub(RING_BYTES);
            out.bytes.drain(..excess);
            out.dropped += excess;
        }
        self.wake.notify_all();
    }
    /// The PTY is finished and everything it wrote is in the ring.
    fn finished(&self) -> bool {
        self.exited.load(Ordering::Acquire) && self.drained.load(Ordering::Acquire)
    }
    /// Raise one of the end-of-stream flags and wake the forwarder. **The store happens under the
    /// output lock**, which is the whole point of this function: [`Stream::forward`] evaluates
    /// `closed` and `finished()` while holding that lock and then parks on `wake` still holding
    /// it, so a flag raised outside the lock is free to land between the check and the park, and
    /// the `notify_all` that follows it reaches nobody. The forwarder then sleeps forever — no
    /// exit frame, and the thread and its 1 MiB ring never go away.
    fn mark(&self, flag: &AtomicBool) {
        {
            let _out = self.lock_output();
            flag.store(true, Ordering::Release);
        }
        self.wake.notify_all();
    }
    /// Install `channel`, dropping any previous one, and start the forwarder if it is not already
    /// running. A second subscriber therefore **replaces** the first rather than joining it;
    /// nothing is replayed to it, because the ring is a buffer and not a transcript.
    fn subscribe(self: &Arc<Self>, channel: Channel<TerminalFrame>) {
        {
            let mut installed = self.channel.lock().unwrap_or_else(|e| e.into_inner());
            *installed = Some(channel);
            self.epoch.fetch_add(1, Ordering::AcqRel);
        }
        if !self.forwarding.swap(true, Ordering::AcqRel) {
            let stream = self.clone();
            std::thread::spawn(move || stream.forward());
        }
        self.wake.notify_all();
    }
    /// Give up the `forwarding` claim, unless a channel was installed since `epoch` was read — in
    /// which case the forwarder keeps going, because `subscribe` has already decided not to start
    /// a second thread.
    fn stop(&self, epoch: u64) -> bool {
        let _installed = self.channel.lock().unwrap_or_else(|e| e.into_inner());
        if self.epoch.load(Ordering::Acquire) != epoch {
            return false;
        }
        self.forwarding.store(false, Ordering::Release);
        true
    }
    /// Send one frame. `false` means the channel is gone and the forwarder should stop.
    fn send(&self, bytes: &[u8], dropped_before: usize, exited: bool) -> bool {
        // Clone out of the guard before sending: `Channel::send` reaches into the event loop and
        // must not run with this mutex held (`src-tauri/src/sink.rs`).
        let channel = self
            .channel
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let Some(channel) = channel else { return false };
        // `seq` is allocated only once a channel is known to be installed, so the number a
        // subscriber never sees is one the channel dropped — not one this code burned deciding
        // there was nobody to send to.
        let frame = TerminalFrame {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            bytes: STANDARD.encode(bytes),
            dropped_before,
            exited,
            drained: self.drained.load(Ordering::Acquire),
        };
        match channel.send(frame) {
            Ok(()) => true,
            Err(e) => {
                tracing::debug!("terminal channel rejected a frame: {e}");
                false
            }
        }
    }
    /// Park until there is something to send, flush a bounded burst, repeat. Returns after the
    /// exit frame, after the terminal is closed, or when the channel goes away.
    fn forward(&self) {
        loop {
            let mut out = self.lock_output();
            loop {
                if self.closed.load(Ordering::Acquire) {
                    self.forwarding.store(false, Ordering::Release);
                    return;
                }
                if !out.bytes.is_empty() || out.dropped > 0 || self.finished() {
                    break;
                }
                out = self.wake.wait(out).unwrap_or_else(|e| e.into_inner());
            }
            // The subscription these frames belong to, read before the first send.
            let epoch = self.epoch.load(Ordering::Acquire);
            let mut burst: Vec<(usize, Vec<u8>)> = Vec::new();
            for _ in 0..FRAMES_PER_FLUSH {
                let dropped_before = std::mem::take(&mut out.dropped);
                let count = out.bytes.len().min(FRAME_PAYLOAD);
                if count == 0 && dropped_before == 0 {
                    break;
                }
                burst.push((dropped_before, out.bytes.drain(..count).collect()));
            }
            // Read under the same guard that drained the ring: `drained` is stored after the last
            // push, so `finished() && empty` cannot race a byte into the ring behind our back.
            let finished = self.finished() && out.bytes.is_empty();
            drop(out);
            let mut lost = false;
            for (dropped_before, bytes) in &burst {
                if !self.send(bytes, *dropped_before, false) {
                    lost = true;
                    break;
                }
            }
            if lost {
                if self.stop(epoch) {
                    return;
                }
                continue;
            }
            if finished {
                self.send(&[], 0, true);
                if self.stop(epoch) {
                    return;
                }
                continue;
            }
            std::thread::sleep(FLUSH_INTERVAL);
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        // Before the early return: a tab closed on an exited shell still has a parked forwarder.
        self.stream.mark(&self.stream.closed);
        // The waiter thread untracks too, once `wait()` returns; both are idempotent, and this
        // one is what makes the record gone by the time `terminal_close` returns.
        crate::tracker::untrack_child(&self.id);
        if self.exited.load(Ordering::Acquire) {
            return;
        }
        // A foreground job has its own process group; stop it before terminating the shell.
        #[cfg(unix)]
        if let Some(group) = self.master.process_group_leader() {
            if group > 1 {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(group),
                    nix::sys::signal::Signal::SIGHUP,
                );
            }
        }
        let _ = self.killer.kill();
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
}
static TERMINALS: OnceLock<Mutex<HashMap<String, Terminal>>> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
fn terminals() -> &'static Mutex<HashMap<String, Terminal>> {
    TERMINALS.get_or_init(Default::default)
}
fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Terminal>> {
    terminals().lock().unwrap_or_else(|e| e.into_inner())
}
pub(crate) fn close_sessions(ids: &[String]) {
    lock().retain(|_, terminal| {
        !terminal
            .session_id
            .as_ref()
            .is_some_and(|id| ids.contains(id))
    });
}
pub(crate) fn shutdown() {
    lock().clear();
}
fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(2, 500),
        cols: cols.clamp(10, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}
fn error(e: impl std::fmt::Display) -> AppError {
    AppError::io(e.to_string())
}

#[cfg(test)]
fn spawn(root: std::path::PathBuf, cols: u16, rows: u16) -> Result<String, AppError> {
    spawn_profile(root.clone(), root, cols, rows, None)
}
fn spawn_profile(
    root: std::path::PathBuf,
    cwd: std::path::PathBuf,
    cols: u16,
    rows: u16,
    shell: Option<String>,
) -> Result<String, AppError> {
    let root = std::fs::canonicalize(root).map_err(error)?;
    let mut registry = lock();
    if registry.len() >= 12 {
        return Err(AppError::invalid_argument(
            "Close a terminal before opening another (limit 12)",
        ));
    }
    let lease = registry
        .values()
        .filter(|terminal| terminal.cwd == root)
        .find_map(|terminal| terminal.lease.upgrade())
        .map(Ok)
        .unwrap_or_else(|| {
            brigadier_core::checkpoint::WorkspaceLease::terminal(&root)
                .map(Arc::new)
                .map_err(error)
        })?;
    let shared_lease = Arc::downgrade(&lease);
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(error)?;
    let shell = shell.unwrap_or_else(default_shell);
    let mut command = CommandBuilder::new(shell.clone());
    command.arg("-l");
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    let mut reader = pair.master.try_clone_reader().map_err(error)?;
    let writer = pair.master.take_writer().map_err(error)?;
    let mut child = pair.slave.spawn_command(command).map_err(error)?;
    drop(pair.slave);
    let pid = child.process_id();
    let killer = child.clone_killer();
    let id = format!("terminal-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    // The PTY makes this shell a session leader, so its pid is its own pgid and the record is
    // safe for the next launch's sweep to act on. Without it a force-quit leaves up to 12 login
    // shells with nothing to find them (`docs/research/lifecycle-bounds-audit-2026-09-11.md` §3).
    if let Some(pid) = pid {
        crate::tracker::track_child(&id, pid, std::path::Path::new(&shell), &cwd);
    }
    let output = Arc::new(Mutex::new(Output::default()));
    let exited = Arc::new(AtomicBool::new(false));
    let drained = Arc::new(AtomicBool::new(false));
    let stream = Arc::new(Stream::new(output.clone(), exited.clone(), drained.clone()));
    let reader_stream = stream.clone();
    std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 {
                break;
            }
            reader_stream.push(&bytes[..n]);
        }
        // After the last `push`, so a forwarder that sees `drained` sees every byte with it.
        reader_stream.mark(&reader_stream.drained);
    });
    let waiter_stream = stream.clone();
    let waiter_id = id.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        drop(lease);
        // A shell the user exited leaves no record behind either, not just one whose tab closed.
        crate::tracker::untrack_child(&waiter_id);
        waiter_stream.mark(&waiter_stream.exited);
    });
    registry.insert(
        id.clone(),
        Terminal {
            id: id.clone(),
            session_id: None,
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            killer,
            output,
            exited,
            pid,
            drained,
            stream,
            cwd: root,
            lease: shared_lease,
        },
    );
    Ok(id)
}

fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_owned())
}
#[derive(Serialize)]
pub(crate) struct ShellProfile {
    path: String,
    name: String,
    default: bool,
}
#[tauri::command]
pub(crate) fn terminal_profiles() -> Vec<ShellProfile> {
    let default = default_shell();
    let configured = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    let mut paths = vec![default.clone()];
    paths.extend(
        configured
            .lines()
            .filter(|line| line.starts_with('/'))
            .map(str::to_owned),
    );
    paths.extend(
        [
            "/opt/homebrew/bin/fish",
            "/opt/homebrew/bin/zsh",
            "/opt/homebrew/bin/bash",
            "/usr/local/bin/fish",
            "/usr/local/bin/zsh",
            "/usr/local/bin/bash",
        ]
        .map(str::to_owned),
    );
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|path| {
            if !seen.insert(path.clone()) {
                return false;
            }
            let Ok(metadata) = std::fs::metadata(path) else {
                return false;
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                metadata.is_file()
            }
        })
        .map(|path| ShellProfile {
            name: std::path::Path::new(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            default: path == default,
            path,
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn terminal_open(
    project_id: String,
    session_id: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    let _lifecycle = crate::peers::LIFECYCLE.lock().await;
    let root = crate::workspace::root(state.inner(), &project_id, session_id.as_deref()).await?;
    state.get()?.supervisor.workspace_writable(&root).await?;
    let cwd = match cwd {
        Some(path) => std::fs::canonicalize(path).unwrap_or_else(|_| root.clone()),
        None => root.clone(),
    };
    let root = std::fs::canonicalize(root).map_err(error)?;
    if !cwd.starts_with(&root) {
        return Err(AppError::invalid_argument(
            "The terminal directory must be inside its session workspace",
        ));
    }
    if let Some(path) = &shell {
        if !terminal_profiles()
            .iter()
            .any(|profile| &profile.path == path)
        {
            return Err(AppError::invalid_argument(
                "Select an installed shell from Terminal Profiles",
            ));
        }
    }
    if let Some(id) = &session_id {
        state
            .get()?
            .supervisor
            .require_session_available(&brigadier_core::event::SessionId::new(id))?;
    }
    let id =
        tauri::async_runtime::spawn_blocking(move || spawn_profile(root, cwd, cols, rows, shell))
            .await
            .map_err(error)??;
    if let Some(terminal) = lock().get_mut(&id) {
        terminal.session_id = session_id;
    }
    Ok(id)
}
#[derive(Serialize)]
pub(crate) struct TerminalOutput {
    data: Vec<u8>,
    exited: bool,
    dropped: usize,
    busy: bool,
}
/// Push output for `id` at the webview's `on_output` channel until the shell exits.
///
/// Subscribing is the only thing that starts a forwarder, so a terminal nobody watches costs one
/// reader thread and nothing else. The backlog is whatever is in the ring: subscribing after
/// output has already arrived delivers it first, in order, because the ring is the only buffer in
/// the path. A second subscription **replaces** the first (`Stream::subscribe`).
#[tauri::command]
pub(crate) fn terminal_subscribe(
    id: String,
    on_output: Channel<TerminalFrame>,
) -> Result<(), AppError> {
    let stream = lock()
        .get(&id)
        .ok_or_else(|| AppError::invalid_argument("Terminal is closed"))?
        .stream
        .clone();
    stream.subscribe(on_output);
    Ok(())
}

/// **Deprecated** in favour of `terminal_subscribe`; kept for one release as a fallback and used
/// by the tests in this file. It drains the same ring as the forwarder, so calling both on one
/// terminal splits the output between them.
#[tauri::command]
pub(crate) fn terminal_read(id: String) -> Result<TerminalOutput, AppError> {
    let registry = lock();
    let terminal = registry
        .get(&id)
        .ok_or_else(|| AppError::invalid_argument("Terminal is closed"))?;
    let mut output = terminal.output.lock().unwrap_or_else(|e| e.into_inner());
    let count = output.bytes.len().min(8192);
    Ok(TerminalOutput {
        data: output.bytes.drain(..count).collect(),
        exited: terminal.exited.load(Ordering::Acquire) && terminal.drained.load(Ordering::Acquire),
        dropped: std::mem::take(&mut output.dropped),
        busy: busy(terminal),
    })
}
#[tauri::command]
pub(crate) async fn terminal_write(id: String, data: String) -> Result<(), AppError> {
    if data.len() > 64 * 1024 {
        return Err(AppError::invalid_argument("Terminal input exceeds 64 KiB"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let writer = lock()
            .get(&id)
            .ok_or_else(|| AppError::invalid_argument("Terminal is closed"))?
            .writer
            .clone();
        let result = writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .write_all(data.as_bytes())
            .map_err(error);
        result
    })
    .await
    .map_err(error)?
}
#[tauri::command]
pub(crate) fn terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), AppError> {
    lock()
        .get(&id)
        .ok_or_else(|| AppError::invalid_argument("Terminal is closed"))?
        .master
        .resize(size(cols, rows))
        .map_err(error)
}
#[tauri::command]
pub(crate) fn terminal_close(id: String) {
    lock().remove(&id);
}

fn busy(t: &Terminal) -> bool {
    if t.exited.load(Ordering::Acquire) {
        return false;
    }
    match (t.master.process_group_leader(), t.pid) {
        (Some(group), Some(pid)) => group > 0 && group as u32 != pid,
        _ => true,
    }
}
#[derive(Serialize)]
pub(crate) struct TerminalInfo {
    busy: bool,
    cwd: String,
}
#[tauri::command]
pub(crate) async fn terminal_info(id: String) -> Result<TerminalInfo, AppError> {
    let (pid, active, cwd) = {
        let registry = lock();
        let t = registry
            .get(&id)
            .ok_or_else(|| AppError::invalid_argument("Terminal is closed"))?;
        (t.pid, busy(t), t.cwd.clone())
    };
    let mut cwd = cwd.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    if let Some(pid) = pid {
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tokio::process::Command::new("/usr/sbin/lsof")
                .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
                .kill_on_drop(true)
                .output(),
        )
        .await;
        if let Ok(Ok(out)) = output {
            if let Some(path) = String::from_utf8_lossy(&out.stdout)
                .lines()
                .find_map(|l| l.strip_prefix('n'))
            {
                cwd = path.to_owned();
            }
        }
    }
    #[cfg(target_os = "linux")]
    if let Some(pid) = pid {
        if let Ok(path) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
            cwd = path.to_string_lossy().into_owned();
        }
    }
    Ok(TerminalInfo { busy: active, cwd })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the webview would see: every message's serialized length, and the frame it carried.
    #[derive(Default)]
    struct Frames {
        seen: Vec<(usize, TerminalFrameWire)>,
    }
    #[derive(serde::Deserialize, Clone)]
    struct TerminalFrameWire {
        seq: u64,
        bytes: String,
        dropped_before: usize,
        exited: bool,
        drained: bool,
    }
    fn collector() -> (Channel<TerminalFrame>, Arc<Mutex<Frames>>) {
        let frames: Arc<Mutex<Frames>> = Arc::default();
        let sink = frames.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            let json = match body {
                tauri::ipc::InvokeResponseBody::Json(json) => json,
                tauri::ipc::InvokeResponseBody::Raw(bytes) => {
                    String::from_utf8(bytes).expect("frames serialize as JSON")
                }
            };
            let frame: TerminalFrameWire =
                serde_json::from_str(&json).expect("frames serialize as JSON");
            sink.lock()
                .unwrap_or_else(|e| e.into_inner())
                .seen
                .push((json.len(), frame));
            Ok(())
        });
        (channel, frames)
    }
    fn detached() -> Arc<Stream> {
        Arc::new(Stream::new(
            Arc::new(Mutex::new(Output::default())),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        ))
    }
    /// Wait for `predicate` over the frames delivered so far, or fail.
    fn until(
        frames: &Arc<Mutex<Frames>>,
        what: &str,
        predicate: impl Fn(&[(usize, TerminalFrameWire)]) -> bool,
    ) -> Vec<(usize, TerminalFrameWire)> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            {
                let seen = &frames.lock().unwrap_or_else(|e| e.into_inner()).seen;
                if predicate(seen) {
                    return seen.clone();
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "{what}: {} frames delivered",
                    seen.len()
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    fn unbase64(text: &str) -> Vec<u8> {
        STANDARD.decode(text).expect("frames carry standard base64")
    }
    #[test]
    fn frames_stay_ordered_under_the_payload_cap_and_report_what_the_ring_dropped() {
        let stream = detached();
        // 1.5 MiB through a 1 MiB ring: the oldest 512 KiB are gone before anyone subscribes.
        let source: Vec<u8> = (0..RING_BYTES + RING_BYTES / 2)
            .map(|i| b"0123456789abcdef"[i % 16])
            .collect();
        for chunk in source.chunks(8192) {
            stream.push(chunk);
        }
        stream.exited.store(true, Ordering::Release);
        stream.drained.store(true, Ordering::Release);
        let (channel, frames) = collector();
        stream.subscribe(channel);
        let seen = until(&frames, "no exit frame", |seen| {
            seen.last().is_some_and(|(_, frame)| frame.exited)
        });
        assert!(seen.len() > 1);
        for (index, (size, frame)) in seen.iter().enumerate() {
            assert_eq!(frame.seq, index as u64 + 1, "frames must not reorder");
            // The whole message, not just the payload: over 8192 bytes tauri parks it in an
            // unbounded queue instead of `eval`ing it.
            assert!(*size < 8192, "{size} byte message at seq {}", frame.seq);
            assert!(unbase64(&frame.bytes).len() <= FRAME_PAYLOAD);
        }
        let (_, last) = seen.last().unwrap();
        assert!(last.exited && last.drained && last.bytes.is_empty());
        assert!(
            seen[..seen.len() - 1]
                .iter()
                .all(|(_, frame)| !frame.exited),
            "exit is signalled once, at the end"
        );
        let dropped: usize = seen.iter().map(|(_, frame)| frame.dropped_before).sum();
        assert_eq!(dropped, source.len() - RING_BYTES);
        let delivered: Vec<u8> = seen
            .iter()
            .flat_map(|(_, frame)| unbase64(&frame.bytes))
            .collect();
        assert_eq!(delivered, source[dropped..], "bytes must arrive in order");
    }
    #[test]
    fn exit_is_withheld_until_the_pty_is_both_finished_and_drained() {
        let stream = detached();
        stream.push(b"tail of the output");
        // The child is gone but the reader thread has not reported EOF: `terminal_read` calls that
        // "not exited" and so does the stream.
        stream.exited.store(true, Ordering::Release);
        let (channel, frames) = collector();
        stream.subscribe(channel);
        let seen = until(&frames, "no output frame", |seen| !seen.is_empty());
        assert_eq!(unbase64(&seen[0].1.bytes), b"tail of the output");
        assert!(seen
            .iter()
            .all(|(_, frame)| !frame.exited && !frame.drained));
        stream.push(b" and its last line");
        stream.drained.store(true, Ordering::Release);
        stream.wake.notify_all();
        let seen = until(&frames, "no exit frame", |seen| {
            seen.last().is_some_and(|(_, frame)| frame.exited)
        });
        let delivered: Vec<u8> = seen
            .iter()
            .flat_map(|(_, frame)| unbase64(&frame.bytes))
            .collect();
        assert_eq!(delivered, b"tail of the output and its last line");
    }
    #[test]
    fn a_second_subscriber_replaces_the_first_and_nothing_is_replayed() {
        let stream = detached();
        let (first_channel, first) = collector();
        stream.subscribe(first_channel);
        stream.push(b"before");
        until(&first, "first subscriber got nothing", |seen| {
            !seen.is_empty()
        });
        let (second_channel, second) = collector();
        stream.subscribe(second_channel);
        let delivered_to_first = first.lock().unwrap().seen.len();
        stream.push(b"after");
        let seen = until(&second, "second subscriber got nothing", |seen| {
            !seen.is_empty()
        });
        assert_eq!(
            unbase64(&seen[0].1.bytes),
            b"after",
            "no replay of the ring"
        );
        assert_eq!(
            seen[0].1.seq, 2,
            "seq is per terminal, not per subscription"
        );
        assert_eq!(
            first.lock().unwrap().seen.len(),
            delivered_to_first,
            "the replaced channel stops receiving"
        );
    }
    /// The forwarder checks `finished()` under the output lock and then parks on `wake` still
    /// holding it. Raising `exited`/`drained` outside that lock lets them land in the window
    /// between the check and the park, and the `notify_all` behind them reaches nobody: no exit
    /// frame ever, and the thread and its ring leak. 200 unsynchronised races.
    #[test]
    fn an_exit_that_races_the_forwarders_wait_still_delivers_the_exit_frame() {
        for round in 0..200 {
            let stream = detached();
            let (channel, frames) = collector();
            stream.subscribe(channel);
            let ending = stream.clone();
            let finisher = std::thread::spawn(move || {
                ending.mark(&ending.exited);
                ending.mark(&ending.drained);
            });
            until(&frames, &format!("no exit frame on round {round}"), |seen| {
                seen.last().is_some_and(|(_, frame)| frame.exited)
            });
            finisher.join().unwrap();
        }
    }
    #[tokio::test]
    async fn a_shell_streams_its_backlog_then_its_exit_over_one_channel() {
        let root = tempfile::tempdir().unwrap();
        let id = spawn(root.path().to_path_buf(), 80, 24).unwrap();
        terminal_write(id.clone(), "printf 'PTY_%s\\n' STREAMED; exit\n".into())
            .await
            .unwrap();
        // Subscribe only after output is already sitting in the ring: the backlog is the ring, so
        // a late subscriber must still see every byte, oldest first.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let waiting = {
                let registry = lock();
                let out = registry[&id].output.lock().unwrap();
                String::from_utf8_lossy(&out.bytes.iter().copied().collect::<Vec<u8>>())
                    .contains("PTY_STREAMED")
            };
            if waiting {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "shell produced nothing"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let (channel, frames) = collector();
        terminal_subscribe(id.clone(), channel).unwrap();
        let seen = until(&frames, "no exit frame", |seen| {
            seen.last().is_some_and(|(_, frame)| frame.exited)
        });
        let text = String::from_utf8_lossy(
            &seen
                .iter()
                .flat_map(|(_, frame)| unbase64(&frame.bytes))
                .collect::<Vec<u8>>(),
        )
        .into_owned();
        assert!(text.contains("PTY_STREAMED"), "{text}");
        assert!(seen.last().unwrap().1.bytes.is_empty());
        assert!(seen[..seen.len() - 1].iter().all(|(_, f)| !f.exited));
        terminal_close(id.clone());
        assert!(terminal_subscribe(id, collector().0).is_err());
    }
    #[tokio::test]
    async fn selected_shell_starts_in_split_directory_and_archive_closes_only_its_owner() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("nested");
        std::fs::create_dir(&cwd).unwrap();
        let first = spawn_profile(
            root.path().to_path_buf(),
            cwd.clone(),
            80,
            24,
            Some("/bin/bash".into()),
        )
        .unwrap();
        let second = spawn(root.path().to_path_buf(), 80, 24).unwrap();
        lock().get_mut(&first).unwrap().session_id = Some("archive-terminal-test".into());
        lock().get_mut(&second).unwrap().session_id = Some("keep-terminal-test".into());
        terminal_write(
            first.clone(),
            "printf 'SHELL_%s\\n' \"$BASH_VERSION\"; pwd\n".into(),
        )
        .await
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut bytes = Vec::new();
        loop {
            bytes.extend(terminal_read(first.clone()).unwrap().data);
            let output = String::from_utf8_lossy(&bytes);
            if output.contains(cwd.to_str().unwrap())
                && output.lines().any(|line| {
                    line.starts_with("SHELL_")
                        && line.chars().nth(6).is_some_and(|c| c.is_ascii_digit())
                })
            {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "{output}");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        close_sessions(&["archive-terminal-test".into()]);
        assert!(terminal_read(first).is_err());
        assert!(terminal_read(second.clone()).is_ok());
        terminal_close(second);
    }
    #[test]
    fn profiles_include_only_installed_executables_and_identify_the_default() {
        let profiles = terminal_profiles();
        assert!(profiles.iter().any(|p| p.path == "/bin/bash"));
        assert_eq!(profiles.iter().filter(|p| p.default).count(), 1);
        assert!(profiles
            .iter()
            .all(|p| std::path::Path::new(&p.path).is_file()));
    }
    #[tokio::test]
    async fn terminals_share_workspace_until_last_shell_exits() {
        struct Shells(Vec<String>);
        impl Drop for Shells {
            fn drop(&mut self) {
                for id in &self.0 {
                    terminal_close(id.clone());
                }
            }
        }
        let root = tempfile::tempdir().unwrap();
        let mut shells = Shells(Vec::new());
        let first = spawn(root.path().to_path_buf(), 80, 24).unwrap();
        shells.0.push(first.clone());
        let second = spawn(root.path().join("."), 80, 24).unwrap();
        shells.0.push(second.clone());
        assert_ne!(first, second);
        {
            let registry = lock();
            assert!(Weak::ptr_eq(
                &registry[&first].lease,
                &registry[&second].lease
            ));
        }
        for (id, marker) in [(&first, "FIRST"), (&second, "SECOND")] {
            terminal_write(id.clone(), format!("printf '{marker}_%s\\n' READY\n"))
                .await
                .unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut first_output = Vec::new();
        let mut second_output = Vec::new();
        loop {
            first_output.extend(terminal_read(first.clone()).unwrap().data);
            second_output.extend(terminal_read(second.clone()).unwrap().data);
            if String::from_utf8_lossy(&first_output).contains("FIRST_READY")
                && String::from_utf8_lossy(&second_output).contains("SECOND_READY")
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "shells did not respond independently"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(!String::from_utf8_lossy(&first_output).contains("SECOND_READY"));
        assert!(!String::from_utf8_lossy(&second_output).contains("FIRST_READY"));
        // Closing one tab neither kills the other shell nor releases its restore guard.
        let first_exited = lock()[&first].exited.clone();
        terminal_close(first);
        while !first_exited.load(Ordering::Acquire) {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let third = spawn(root.path().to_path_buf(), 80, 24).unwrap();
        shells.0.push(third.clone());
        assert!(brigadier_core::checkpoint::WorkspaceLease::acquire(root.path()).is_err());
        let third_exited = lock()[&third].exited.clone();
        terminal_close(third);
        while !third_exited.load(Ordering::Acquire) {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        terminal_write(second.clone(), "exit\n".into())
            .await
            .unwrap();
        while !terminal_read(second.clone()).unwrap().exited {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        // An exited tab remains readable without keeping the workspace locked.
        assert!(brigadier_core::checkpoint::WorkspaceLease::acquire(root.path()).is_ok());
    }

    #[tokio::test]
    async fn foreground_command_is_busy_and_shell_is_idle() {
        let root = tempfile::tempdir().unwrap();
        let id = spawn(root.path().to_path_buf(), 80, 24).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        loop {
            if !terminal_read(id.clone()).unwrap().busy {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        terminal_write(id.clone(), "/bin/sleep 30\n".into())
            .await
            .unwrap();
        loop {
            if terminal_read(id.clone()).unwrap().busy {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        terminal_close(id.clone());
        assert!(terminal_read(id).is_err());
    }
    #[tokio::test]
    async fn local_shell_roundtrip_exit_and_close() {
        let root = tempfile::tempdir().unwrap();
        let id = spawn(root.path().to_path_buf(), 80, 24).unwrap();
        terminal_resize(id.clone(), 100, 30).unwrap();
        terminal_write(
            id.clone(),
            "printf 'PTY_%s\\n' VERIFIED; pwd; exit\n".into(),
        )
        .await
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut bytes = Vec::new();
        loop {
            let output = terminal_read(id.clone()).unwrap();
            bytes.extend(output.data);
            if output.exited {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "shell did not exit");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("PTY_VERIFIED"), "{text}");
        assert!(
            text.contains(root.path().file_name().unwrap().to_str().unwrap()),
            "{text}"
        );
        terminal_close(id.clone());
        assert!(terminal_read(id).is_err());
        let live = spawn(root.path().to_path_buf(), 80, 24).unwrap();
        let exited = lock().get(&live).unwrap().exited.clone();
        terminal_close(live);
        while !exited.load(Ordering::Acquire) {
            assert!(
                std::time::Instant::now() < deadline,
                "closed shell was not reaped"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// Somewhere for the pid records to go. Only a real launch installs a tracker
    /// (`lib.rs`'s `setup`), so in a test binary this is the only one and it lives as long as the
    /// process.
    fn ambient_pid_dir() -> std::path::PathBuf {
        static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
        let dir = DIR.get_or_init(|| tempfile::tempdir().expect("tempdir"));
        let open = brigadier_proc::PidDir::open(dir.path()).expect("pid dir");
        crate::tracker::install(std::sync::Arc::new(brigadier_proc::PidTracker::new(
            open,
            "terminal-test-run",
        )));
        let installed = crate::tracker::ambient_dir().expect("a tracker is installed");
        assert_eq!(
            installed,
            dir.path(),
            "only this test installs a tracker in a test binary"
        );
        installed
    }

    /// A force-quit leaves a login shell running, and the next launch can only reap it from a pid
    /// record (`docs/research/lifecycle-bounds-audit-2026-09-11.md` §3 gap 2). So the record must
    /// exist while the shell does, and be gone the moment the tab closes.
    #[tokio::test]
    async fn a_terminal_shell_is_recorded_in_the_pid_directory_until_it_closes() {
        let pids = ambient_pid_dir();
        let root = tempfile::tempdir().unwrap();
        let id = spawn(root.path().to_path_buf(), 80, 24).unwrap();
        let record = pids.join(format!("{id}.json"));
        assert!(
            record.exists(),
            "a live shell must be recorded at {}",
            record.display()
        );
        let written = std::fs::read_to_string(&record).unwrap();
        let pid = lock()[&id].pid.expect("the shell has a pid");
        assert!(
            written.contains(&format!("\"pid\":{pid}")),
            "the record names the shell's own pid: {written}"
        );
        assert!(
            !written.contains("\"pgid\":0"),
            "the PTY makes the shell a group leader: {written}"
        );

        terminal_close(id.clone());
        assert!(
            !record.exists(),
            "a closed tab must leave nothing for the next launch to sweep"
        );
    }
}
