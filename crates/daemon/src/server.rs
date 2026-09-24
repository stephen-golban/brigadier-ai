//! Accepts IPC connections and serves requests and the live event feed.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use brigadier_core::Core;
use brigadier_ipc::metrics::{DaemonMetrics, Diagnostics, budgets};
use brigadier_ipc::protocol::{
    ClientFrame, ClientInfo, DaemonInfo, ErrorCode, EventEnvelope, IpcError, Outcome, Request,
    Response, ServerFrame,
};
use brigadier_ipc::{Connection, Listener, Reader, Token, Writer};
use brigadier_store::{Store, StoredEvent};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::metrics::Metrics;
use crate::supervisor::Supervisor;

/// Frames buffered between a connection's reader task and its handler.
const INBOUND_FRAMES: usize = 32;
/// Page size when replaying committed events to a new subscriber.
const REPLAY_PAGE: u32 = 500;
/// A subscriber further behind than this resyncs through `eventsSince` instead.
const MAX_REPLAY: usize = 10_000;
/// Consecutive accept failures (e.g. out of file descriptors) before the daemon gives up.
const MAX_ACCEPT_FAILURES: u32 = 50;

/// State shared by every connection.
pub struct Daemon {
    pub info: DaemonInfo,
    pub core: Arc<Core>,
    pub store: Store,
    pub metrics: Arc<Metrics>,
    pub supervisor: Supervisor,
    /// Cancelled once the store has drained; connections then say goodbye and close.
    pub closing: CancellationToken,
    /// A client asked the daemon to quit.
    pub quit: mpsc::Sender<()>,
    /// Becomes true when all admitted writes are committed during shutdown.
    pub drained: watch::Receiver<bool>,
    pub connections: TaskTracker,
    next_connection: AtomicU64,
}

impl Daemon {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        info: DaemonInfo,
        core: Arc<Core>,
        store: Store,
        metrics: Arc<Metrics>,
        supervisor: Supervisor,
        closing: CancellationToken,
        quit: mpsc::Sender<()>,
        drained: watch::Receiver<bool>,
    ) -> Self {
        Self {
            info,
            core,
            store,
            metrics,
            supervisor,
            closing,
            quit,
            drained,
            connections: TaskTracker::new(),
            next_connection: AtomicU64::new(1),
        }
    }
}

/// Accepts connections until shutdown begins. Each connection authenticates on its own task.
pub async fn accept_loop(
    daemon: Arc<Daemon>,
    listener: Listener,
    token: Token,
) -> anyhow::Result<()> {
    let stopping = daemon.supervisor.shutdown_token().clone();
    let mut failures = 0;
    loop {
        let pending = tokio::select! {
            _ = stopping.cancelled() => return Ok(()),
            pending = listener.accept() => pending,
        };
        let pending = match pending {
            Ok(pending) => {
                failures = 0;
                pending
            }
            Err(err) => {
                failures += 1;
                if failures >= MAX_ACCEPT_FAILURES {
                    anyhow::bail!("accept keeps failing: {err}");
                }
                tracing::warn!(error = %err, "accept failed");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let daemon_for_task = daemon.clone();
        let token = token.clone();
        let task = daemon.supervisor.monitor().instrument(async move {
            match pending.authenticate(&token).await {
                Ok((connection, client)) => serve(daemon_for_task, connection, client).await,
                Err(err) => tracing::warn!(error = %err, "rejected IPC connection"),
            }
        });
        daemon.connections.spawn(task);
    }
}

async fn serve(daemon: Arc<Daemon>, connection: Connection, client: ClientInfo) {
    let id = daemon.next_connection.fetch_add(1, Ordering::Relaxed);
    tracing::info!(connection = id, client = %client.name, pid = client.pid, "client connected");
    daemon.metrics.connection_opened(id, client);
    let mut session = Session {
        daemon: daemon.clone(),
        writer: connection.writer,
        feed: None,
        last_sent: 0,
        metrics: None,
    };
    if let Err(err) = session.run(connection.reader).await {
        tracing::debug!(connection = id, error = %err, "connection ended with an error");
    }
    if session.metrics.is_some() {
        daemon.metrics.set_streaming(false);
    }
    daemon.metrics.connection_closed(id);
    tracing::info!(connection = id, "client disconnected");
}

struct Session {
    daemon: Arc<Daemon>,
    writer: Writer,
    /// Live event feed, once subscribed.
    feed: Option<broadcast::Receiver<Arc<StoredEvent>>>,
    /// Highest `seq` delivered to this client.
    last_sent: i64,
    metrics: Option<watch::Receiver<DaemonMetrics>>,
}

enum Flow {
    Continue,
    Close,
}

impl Session {
    async fn run(&mut self, reader: Reader) -> anyhow::Result<()> {
        self.writer
            .write(&ServerFrame::Welcome {
                daemon: self.daemon.info.clone(),
                last_seq: self.daemon.store.last_seq(),
            })
            .await?;

        // Reading a frame is not cancel-safe, so it happens on its own task and whole frames
        // arrive over a channel the select below can poll safely.
        let (frames_tx, mut frames) = mpsc::channel(INBOUND_FRAMES);
        let reader_task = self.daemon.supervisor.spawn(async move {
            let mut reader = reader;
            loop {
                match reader.read::<ClientFrame>().await {
                    Ok(Some(frame)) => {
                        if frames_tx.send(Ok(frame)).await.is_err() {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(err) => {
                        let _ = frames_tx.send(Err(err)).await;
                        return;
                    }
                }
            }
        });

        let closing = self.daemon.closing.clone();
        let result = loop {
            tokio::select! {
                biased;
                _ = closing.cancelled() => {
                    let _ = self.writer.write(&ServerFrame::Closing).await;
                    break Ok(());
                }
                frame = frames.recv() => match frame {
                    Some(Ok(ClientFrame::Request { id, request })) => {
                        match self.handle(id, request).await? {
                            Flow::Continue => {}
                            Flow::Close => break Ok(()),
                        }
                    }
                    Some(Ok(ClientFrame::Hello { .. })) => {
                        break Err(anyhow::anyhow!("hello sent twice"));
                    }
                    Some(Err(err)) => break Err(err.into()),
                    None => break Ok(()),
                },
                event = next_event(&mut self.feed) => match event {
                    Ok(event) => {
                        if event.seq > self.last_sent {
                            self.last_sent = event.seq;
                            self.writer.write(&ServerFrame::Event { event: envelope(&event) }).await?;
                        }
                    }
                    Err(RecvError::Lagged(_)) => {
                        // Bounded feed: a slow client is cut off and resyncs from its cursor.
                        self.feed = None;
                        self.writer
                            .write(&ServerFrame::Lagged { resume_after: self.last_sent })
                            .await?;
                    }
                    Err(RecvError::Closed) => self.feed = None,
                },
                sample = next_metrics(&mut self.metrics) => {
                    if let Some(metrics) = sample {
                        self.writer.write(&ServerFrame::Metrics { metrics }).await?;
                    }
                }
            }
        };
        reader_task.abort();
        result
    }

    async fn handle(&mut self, id: u32, request: Request) -> anyhow::Result<Flow> {
        let outcome = match request {
            Request::Subscribe { after_seq, metrics } => {
                self.set_metrics(metrics);
                self.subscribe(after_seq).await.map_err(internal)
            }
            Request::SetMetricsStreaming { enabled } => {
                self.set_metrics(enabled);
                Ok(Response::SetMetricsStreaming { enabled })
            }
            Request::Shutdown => {
                // Stop admission and drain first; acknowledge only once writes are committed.
                let _ = self.daemon.quit.try_send(());
                let mut drained = self.daemon.drained.clone();
                let _ = drained.wait_for(|drained| *drained).await;
                self.respond(id, Ok(Response::Shutdown)).await?;
                return Ok(Flow::Close);
            }
            other => handle_request(&self.daemon, other).await,
        };
        self.respond(id, outcome).await?;
        Ok(Flow::Continue)
    }

    async fn respond(
        &mut self,
        id: u32,
        outcome: Result<Response, IpcError>,
    ) -> anyhow::Result<()> {
        self.writer
            .write(&ServerFrame::Response {
                id,
                result: Outcome::from(outcome),
            })
            .await?;
        Ok(())
    }

    fn set_metrics(&mut self, enabled: bool) {
        match (enabled, self.metrics.is_some()) {
            (true, false) => {
                self.metrics = Some(self.daemon.metrics.subscribe());
                self.daemon.metrics.set_streaming(true);
            }
            (false, true) => {
                self.metrics = None;
                self.daemon.metrics.set_streaming(false);
            }
            _ => {}
        }
    }

    /// Starts the live feed, first replaying committed events after `after_seq`.
    async fn subscribe(&mut self, after_seq: i64) -> Result<Response, brigadier_store::Error> {
        // Subscribe before reading so nothing committed in between is missed; duplicates are
        // skipped by `last_sent`.
        let feed = self.daemon.store.subscribe();
        let mut cursor = after_seq.max(0);
        let mut replayed = 0;
        loop {
            let page = self.daemon.store.read_since(cursor, REPLAY_PAGE).await?;
            for event in &page {
                cursor = event.seq;
                let frame = ServerFrame::Event {
                    event: envelope(event),
                };
                if self.writer.write_buffered(&frame).await.is_err() {
                    return Err(brigadier_store::Error::Io(
                        std::io::ErrorKind::BrokenPipe.into(),
                    ));
                }
            }
            replayed += page.len();
            if page.len() < REPLAY_PAGE as usize {
                break;
            }
            if replayed >= MAX_REPLAY {
                self.last_sent = cursor;
                self.feed = None;
                let _ = self
                    .writer
                    .write_buffered(&ServerFrame::Lagged {
                        resume_after: cursor,
                    })
                    .await;
                return Ok(Response::Subscribe { last_seq: cursor });
            }
        }
        self.last_sent = cursor;
        self.feed = Some(feed);
        Ok(Response::Subscribe { last_seq: cursor })
    }
}

async fn next_event(
    feed: &mut Option<broadcast::Receiver<Arc<StoredEvent>>>,
) -> Result<Arc<StoredEvent>, RecvError> {
    match feed {
        Some(feed) => feed.recv().await,
        None => std::future::pending().await,
    }
}

async fn next_metrics(
    metrics: &mut Option<watch::Receiver<DaemonMetrics>>,
) -> Option<DaemonMetrics> {
    match metrics {
        Some(rx) => match rx.changed().await {
            Ok(()) => Some(rx.borrow_and_update().clone()),
            Err(_) => {
                *metrics = None;
                None
            }
        },
        None => std::future::pending().await,
    }
}

fn envelope(event: &StoredEvent) -> EventEnvelope {
    EventEnvelope {
        seq: event.seq,
        stream: event.stream.clone(),
        stream_seq: event.stream_seq,
        at_ms: event.at_ms,
        event: event.payload.clone(),
    }
}

fn internal(err: brigadier_store::Error) -> IpcError {
    IpcError::from(brigadier_core::Error::from(err))
}

async fn handle_request(daemon: &Arc<Daemon>, request: Request) -> Result<Response, IpcError> {
    let core = &daemon.core;
    Ok(match request {
        Request::GetCatalog => Response::GetCatalog {
            catalog: core.catalog(),
        },
        Request::CreateProject { name } => Response::CreateProject {
            project: core.create_project(name).await?,
        },
        Request::CreateConversation {
            kind,
            project_id,
            title,
        } => Response::CreateConversation {
            conversation: core.create_conversation(kind, project_id, title).await?,
        },
        Request::RenameConversation { id, title } => Response::RenameConversation {
            conversation: core.rename_conversation(id, title).await?,
        },
        Request::SetPinned { id, pinned } => Response::SetPinned {
            conversation: core.set_pinned(id, pinned).await?,
        },
        Request::AppendMessage {
            conversation_id,
            text,
        } => Response::AppendMessage {
            message: core.append_message(conversation_id, text).await?,
        },
        Request::ListMessages {
            conversation_id,
            before,
            limit,
        } => Response::ListMessages {
            page: core.list_messages(conversation_id, before, limit).await?,
        },
        Request::ReadBlobText { hash } => Response::ReadBlobText {
            text: core.read_blob_text(hash).await?,
        },
        Request::UpdateSettings { settings } => Response::UpdateSettings {
            settings: core.update_settings(settings).await?,
        },
        Request::EventsSince { after_seq, limit } => {
            let events = daemon
                .store
                .read_since(after_seq, limit)
                .await
                .map_err(internal)?;
            Response::EventsSince {
                events: events.iter().map(envelope).collect(),
                last_seq: daemon.store.last_seq(),
            }
        }
        Request::GetDiagnostics => Response::GetDiagnostics {
            diagnostics: Box::new(Diagnostics {
                daemon: daemon.info.clone(),
                metrics: daemon.metrics.sample().await,
                processes: daemon.metrics.processes().await,
                budgets: budgets(),
            }),
        },
        Request::ProbeBurst { count, interval_ms } => {
            let (burst, run) = core.probe_burst(count, interval_ms)?;
            daemon.supervisor.spawn(run);
            Response::ProbeBurst { burst }
        }
        Request::Subscribe { .. } | Request::SetMetricsStreaming { .. } | Request::Shutdown => {
            return Err(IpcError {
                code: ErrorCode::Invalid,
                message: "handled by the session".into(),
            });
        }
    })
}
