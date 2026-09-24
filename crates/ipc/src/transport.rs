//! Listener and connector over the platform's local socket: a Unix domain socket inside a
//! private (0700) directory, or a named pipe whose DACL admits only the current user.

use std::io;
use std::time::Duration;

use brigadier_sandbox::{IpcEndpoint, Platform};
use interprocess::local_socket::tokio::{Listener as TokioListener, RecvHalf, SendHalf, Stream};
use interprocess::local_socket::traits::tokio::{Listener as _, Stream as _};
use interprocess::local_socket::{ListenerOptions, Name};

use crate::Error;
use crate::frame::{FrameReader, FrameWriter};
use crate::protocol::{ClientFrame, ClientInfo, DaemonInfo, PROTOCOL_VERSION, ServerFrame};
use crate::token::Token;

/// Time a new connection has to present a valid hello.
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(2);

/// Reading half of a connection.
pub type Reader = FrameReader<RecvHalf>;
/// Writing half of a connection.
pub type Writer = FrameWriter<SendHalf>;

/// An authenticated connection, split into halves.
pub struct Connection {
    pub reader: Reader,
    pub writer: Writer,
}

impl Connection {
    fn new(stream: Stream) -> Self {
        let (recv, send) = stream.split();
        Self {
            reader: FrameReader::new(recv),
            writer: FrameWriter::new(send),
        }
    }
}

/// The daemon's listening endpoint.
pub struct Listener {
    inner: TokioListener,
}

impl Listener {
    /// Binds the endpoint. The caller must hold the instance lock: a leftover Unix socket from
    /// a crashed daemon is removed.
    pub fn bind(platform: &dyn Platform) -> Result<Self, Error> {
        let paths = platform.paths();
        platform.private_fs().create_private_dir(&paths.run_dir)?;
        if let Some(dir) = paths.socket_dir() {
            platform.private_fs().create_private_dir(dir)?;
        }
        let options = ListenerOptions::new().name(endpoint_name(&paths.ipc_endpoint)?);

        #[cfg(unix)]
        let options = {
            if let IpcEndpoint::UnixSocket(path) = &paths.ipc_endpoint {
                remove_stale_socket(path)?;
            }
            options.reclaim_name(true)
        };
        #[cfg(windows)]
        let options = {
            use interprocess::os::windows::local_socket::ListenerOptionsExt;
            use interprocess::os::windows::security_descriptor::SecurityDescriptor;
            let sddl = brigadier_sandbox::windows::current_user_only_sddl(false)?;
            let sddl = widestring::U16CString::from_str(&sddl)
                .map_err(|err| Error::Io(io::Error::new(io::ErrorKind::InvalidInput, err)))?;
            options.security_descriptor(SecurityDescriptor::deserialize(&sddl)?)
        };

        Ok(Self {
            inner: options.create_tokio()?,
        })
    }

    /// Waits for the next raw connection. Authenticate it with [`Pending::authenticate`] on its
    /// own task so a slow client never holds up the accept loop.
    pub async fn accept(&self) -> Result<Pending, Error> {
        Ok(Pending {
            stream: self.inner.accept().await?,
        })
    }
}

/// A connection that has not yet presented the token.
pub struct Pending {
    stream: Stream,
}

impl Pending {
    /// Reads the hello within [`AUTH_TIMEOUT`] and checks the token and protocol version.
    /// Any failure drops the connection without a reply.
    pub async fn authenticate(self, token: &Token) -> Result<(Connection, ClientInfo), Error> {
        let mut connection = Connection::new(self.stream);
        let hello = tokio::time::timeout(AUTH_TIMEOUT, connection.reader.read::<ClientFrame>())
            .await
            .map_err(|_| Error::Unauthorized("no hello before the deadline"))?;
        match hello {
            Ok(Some(ClientFrame::Hello {
                token: presented,
                protocol,
                client,
            })) => {
                if !token.matches(&presented) {
                    return Err(Error::Unauthorized("wrong token"));
                }
                if protocol != PROTOCOL_VERSION {
                    return Err(Error::Unauthorized("unsupported protocol version"));
                }
                Ok((connection, client))
            }
            Ok(Some(_)) => Err(Error::Unauthorized("first frame was not a hello")),
            Ok(None) => Err(Error::Unauthorized("closed before hello")),
            // Oversized or malformed first frames are rejected here too.
            Err(_) => Err(Error::Unauthorized("malformed hello")),
        }
    }
}

/// Connects to a running daemon and completes the handshake.
pub async fn connect(
    platform: &dyn Platform,
    client: ClientInfo,
) -> Result<(Connection, DaemonInfo, i64), Error> {
    let paths = platform.paths();
    let token = Token::read(&paths.token_path)?;
    let stream = Stream::connect(endpoint_name(&paths.ipc_endpoint)?).await?;
    let mut connection = Connection::new(stream);
    connection
        .writer
        .write(&ClientFrame::Hello {
            token: token.as_str().to_owned(),
            protocol: PROTOCOL_VERSION,
            client,
        })
        .await?;
    let welcome = tokio::time::timeout(AUTH_TIMEOUT, connection.reader.read::<ServerFrame>())
        .await
        .map_err(|_| Error::Unauthorized("daemon did not answer the hello"))??;
    match welcome {
        Some(ServerFrame::Welcome { daemon, last_seq }) => Ok((connection, daemon, last_seq)),
        Some(_) => Err(Error::Protocol("expected welcome")),
        None => Err(Error::Unauthorized("daemon rejected the hello")),
    }
}

fn endpoint_name(endpoint: &IpcEndpoint) -> io::Result<Name<'static>> {
    match endpoint {
        #[cfg(unix)]
        IpcEndpoint::UnixSocket(path) => {
            use interprocess::local_socket::{GenericFilePath, ToFsName};
            path.clone().to_fs_name::<GenericFilePath>()
        }
        #[cfg(windows)]
        IpcEndpoint::NamedPipe(name) => {
            use interprocess::local_socket::{GenericNamespaced, ToNsName};
            name.clone().to_ns_name::<GenericNamespaced>()
        }
        #[allow(unreachable_patterns)]
        _ => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "IPC endpoint type not available on this platform",
        )),
    }
}

#[cfg(unix)]
fn remove_stale_socket(path: &std::path::Path) -> io::Result<()> {
    use std::os::unix::fs::FileTypeExt;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_socket() => std::fs::remove_file(path),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} exists and is not a socket", path.display()),
        )),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}
