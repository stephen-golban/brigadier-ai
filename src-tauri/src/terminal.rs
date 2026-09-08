//! Local PTYs owned by the window. Bytes stay bytes across reads (UTF-8 can split anywhere).
use crate::{error::AppError, state::AppState};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
};
use tauri::State;

struct Terminal {
    session_id: Option<String>,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    output: Arc<Mutex<Output>>,
    exited: Arc<AtomicBool>,
    pid: Option<u32>,
    drained: Arc<AtomicBool>,
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
impl Drop for Terminal {
    fn drop(&mut self) {
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
    let mut command = CommandBuilder::new(shell);
    command.arg("-l");
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    let mut reader = pair.master.try_clone_reader().map_err(error)?;
    let writer = pair.master.take_writer().map_err(error)?;
    let mut child = pair.slave.spawn_command(command).map_err(error)?;
    drop(pair.slave);
    let pid = child.process_id();
    let killer = child.clone_killer();
    let output = Arc::new(Mutex::new(Output::default()));
    let exited = Arc::new(AtomicBool::new(false));
    let sink = output.clone();
    let drained = Arc::new(AtomicBool::new(false));
    let reader_done = drained.clone();
    std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 {
                break;
            }
            let mut out = sink.lock().unwrap_or_else(|e| e.into_inner());
            out.bytes.extend(&bytes[..n]);
            let excess = out.bytes.len().saturating_sub(1024 * 1024);
            out.bytes.drain(..excess);
            out.dropped += excess;
        }
        reader_done.store(true, Ordering::Release);
    });
    let done = exited.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        drop(lease);
        done.store(true, Ordering::Release);
    });
    let id = format!("terminal-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    registry.insert(
        id.clone(),
        Terminal {
            session_id: None,
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            killer,
            output,
            exited,
            pid,
            drained,
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
}
