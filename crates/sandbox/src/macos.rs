//! macOS: Keychain credentials, Seatbelt sandbox, login-shell environment.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Read};
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use security_framework::passwords;

use crate::unix::{self, UnixPrivateFs};
use crate::{
    APP_ID, AppPaths, CredentialStore, DetachedChild, Error, Platform, PrivateFs, Processes,
    Result, Sandbox, SandboxPolicy, Shell, SpawnSpec,
};

pub(crate) struct MacOs {
    paths: AppPaths,
}

impl MacOs {
    pub(crate) fn new(paths: AppPaths) -> Self {
        Self { paths }
    }
}

impl Platform for MacOs {
    fn name(&self) -> &'static str {
        "macos"
    }
    fn paths(&self) -> &AppPaths {
        &self.paths
    }
    fn private_fs(&self) -> &dyn PrivateFs {
        &UnixPrivateFs
    }
    fn processes(&self) -> &dyn Processes {
        &MacProcesses
    }
    fn credentials(&self) -> &dyn CredentialStore {
        &Keychain
    }
    fn shell(&self) -> &dyn Shell {
        &LoginShell
    }
    fn sandbox(&self) -> &dyn Sandbox {
        &Seatbelt
    }
}

struct MacProcesses;

impl Processes for MacProcesses {
    fn spawn_detached(&self, spec: &SpawnSpec) -> Result<DetachedChild> {
        unix::spawn_detached(spec)
    }
    fn piped_command(&self, spec: &SpawnSpec) -> std::process::Command {
        unix::piped_command(spec)
    }
    fn is_alive(&self, pid: u32) -> bool {
        unix::is_alive(pid)
    }
    fn terminate(&self, pid: u32) -> Result<()> {
        unix::terminate(pid)
    }
    fn kill_tree(&self, pid: u32) -> Result<()> {
        unix::kill_tree(pid)
    }
    fn start_time_ms(&self, pid: u32) -> Result<f64> {
        let pid = i32::try_from(pid)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid pid"))?;
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        // SAFETY: `info` is a writable buffer of exactly `size` bytes, which is what
        // PROC_PIDTBSDINFO fills; the return value is checked before `info` is read.
        #[allow(unsafe_code)]
        let (written, info) = unsafe {
            let written = libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size as libc::c_int,
            );
            (written, info.assume_init())
        };
        if written != size as libc::c_int {
            return Err(io::Error::last_os_error().into());
        }
        Ok(info.pbi_start_tvsec as f64 * 1000.0 + info.pbi_start_tvusec as f64 / 1000.0)
    }
}

struct Keychain;

/// `errSecItemNotFound`
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

impl CredentialStore for Keychain {
    fn set(&self, account: &str, secret: &[u8]) -> Result<()> {
        passwords::set_generic_password(APP_ID, account, secret)
            .map_err(|err| Error::Credentials(err.to_string()))
    }

    fn get(&self, account: &str) -> Result<Option<Vec<u8>>> {
        match passwords::get_generic_password(APP_ID, account) {
            Ok(secret) => Ok(Some(secret)),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(err) => Err(Error::Credentials(err.to_string())),
        }
    }

    fn delete(&self, account: &str) -> Result<()> {
        match passwords::delete_generic_password(APP_ID, account) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(err) => Err(Error::Credentials(err.to_string())),
        }
    }
}

struct LoginShell;

const ENV_MARKER: &[u8] = b"\0__BRIGADIER_ENV__\0";
const SHELL_TIMEOUT: Duration = Duration::from_secs(10);

impl Shell for LoginShell {
    fn login_shell(&self) -> Result<PathBuf> {
        let uid = nix::unistd::getuid();
        match nix::unistd::User::from_uid(uid) {
            Ok(Some(user)) if !user.shell.as_os_str().is_empty() => Ok(user.shell),
            _ => std::env::var_os("SHELL")
                .map(PathBuf::from)
                .ok_or_else(|| Error::Shell("no login shell configured".into())),
        }
    }

    fn login_environment(&self) -> Result<BTreeMap<OsString, OsString>> {
        let shell = self.login_shell()?;
        // A marker separates whatever the user's rc files print from the environment dump.
        let script = "printf '\\0__BRIGADIER_ENV__\\0'; exec /usr/bin/env -0";
        let mut child = Command::new(&shell)
            .args(["-l", "-i", "-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| Error::Shell(format!("spawning {}: {err}", shell.display())))?;
        let pid = child.id();
        let mut stdout = child.stdout.take().expect("stdout is piped");

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let result = stdout.read_to_end(&mut out).map(|_| out);
            let _ = tx.send(result);
        });
        let output = match rx.recv_timeout(SHELL_TIMEOUT) {
            Ok(output) => output?,
            Err(_) => {
                let _ = unix::kill_tree(pid);
                let _ = child.wait();
                return Err(Error::Shell(format!(
                    "{} did not finish within {SHELL_TIMEOUT:?}",
                    shell.display()
                )));
            }
        };
        let _ = child.wait();

        let start = output
            .windows(ENV_MARKER.len())
            .rposition(|window| window == ENV_MARKER)
            .ok_or_else(|| Error::Shell("login shell produced no environment".into()))?;
        Ok(output[start + ENV_MARKER.len()..]
            .split(|byte| *byte == 0)
            .filter_map(|entry| {
                let eq = entry.iter().position(|byte| *byte == b'=')?;
                Some((
                    OsString::from_vec(entry[..eq].to_vec()),
                    OsString::from_vec(entry[eq + 1..].to_vec()),
                ))
            })
            .collect())
    }
}

struct Seatbelt;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Read-anywhere, write-only-where-allowed profile. Writable roots are passed as `-D`
/// parameters so paths never need escaping inside the profile.
const SEATBELT_BASE: &str = r#"(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow file-read*)
(allow file-write-data
  (require-all (vnode-type CHARACTER-DEVICE)
    (require-any (path "/dev/null") (path "/dev/zero") (path "/dev/dtracehelper") (path "/dev/tty"))))
(allow file-ioctl (path "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))
(allow pseudo-tty)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-sem)
(allow ipc-posix-shm-read* ipc-posix-shm-write-create ipc-posix-shm-write-data)
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow user-preference-read)
"#;

const SEATBELT_NETWORK: &str = r#"(allow network-outbound)
(allow network-inbound)
(allow system-socket)
(allow network-bind (local ip "localhost:*"))
"#;

impl Seatbelt {
    fn profile(policy: &SandboxPolicy) -> String {
        let mut profile = String::from(SEATBELT_BASE);
        if !policy.writable_roots.is_empty() {
            profile.push_str("(allow file-write*");
            for index in 0..policy.writable_roots.len() {
                profile.push_str(&format!(" (subpath (param \"WRITABLE_ROOT_{index}\"))"));
            }
            profile.push_str(")\n");
        }
        if policy.network {
            profile.push_str(SEATBELT_NETWORK);
        }
        profile
    }
}

impl Sandbox for Seatbelt {
    fn confine(&self, spec: SpawnSpec, policy: &SandboxPolicy) -> Result<SpawnSpec> {
        let mut args: Vec<OsString> = vec!["-p".into(), Self::profile(policy).into()];
        for (index, root) in policy.writable_roots.iter().enumerate() {
            // Seatbelt matches resolved paths, so symlinks such as /tmp must be resolved first.
            let root = root.canonicalize()?;
            let mut define = OsString::from(format!("WRITABLE_ROOT_{index}="));
            define.push(root.as_os_str());
            args.push("-D".into());
            args.push(define);
        }
        args.push("--".into());
        args.push(spec.program.into_os_string());
        args.extend(spec.args);
        Ok(SpawnSpec {
            program: PathBuf::from(SANDBOX_EXEC),
            args,
            env: spec.env,
            clear_env: spec.clear_env,
            cwd: spec.cwd,
        })
    }
}
