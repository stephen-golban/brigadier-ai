//! Accepts IPC connections and serves requests and the live event feed.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use brigadier_core::manager::SessionManager;
use brigadier_core::runtime::{Runtime, StartRaw};
use brigadier_core::{Core, MAX_ATTACHMENT_BYTES};
use brigadier_ipc::metrics::{DaemonMetrics, Diagnostics, budgets};
use brigadier_ipc::protocol::{
    ArtifactText, ClientFrame, ClientInfo, DaemonInfo, ErrorCode, EventEnvelope, IpcError, Outcome,
    RawJson, Request, Response, SendOutcome, ServerFrame,
};
use brigadier_ipc::{Accepted, Connection, Listener, Reader, Token, Writer};
use brigadier_store::{Store, StoredEvent};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc, watch};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::metrics::Metrics;
use crate::supervisor::Supervisor;
use crate::upgrade;

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
    /// Provider sessions and what Brigadier knows about each provider.
    pub runtime: Arc<Runtime>,
    /// Live sessions, Chats and workers; answers the Brigadier MCP tools and the gate.
    pub sessions: Arc<SessionManager>,
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
        runtime: Arc<Runtime>,
        sessions: Arc<SessionManager>,
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
            runtime,
            sessions,
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

/// Accepts connections until shutdown begins. Each connection authenticates on its own task:
/// the app with the token, CLI sessions' MCP bridges and gate checks with their grant.
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
            match pending.handshake(&token).await {
                Ok(Accepted::Client { connection, client }) => {
                    serve(daemon_for_task, connection, client).await
                }
                Ok(Accepted::Mcp { grant, stream }) => {
                    upgrade::serve_mcp(daemon_for_task, grant, stream).await
                }
                Ok(Accepted::Gate {
                    grant,
                    argv,
                    cwd,
                    check,
                }) => upgrade::serve_gate(daemon_for_task, grant, argv, cwd, check).await,
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
                    Some(Ok(_)) => {
                        break Err(anyhow::anyhow!("handshake frame after the handshake"));
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
        event: RawJson(event.payload.clone()),
    }
}

fn internal(err: brigadier_store::Error) -> IpcError {
    IpcError::from(brigadier_core::Error::from(err))
}

async fn handle_request(daemon: &Arc<Daemon>, request: Request) -> Result<Response, IpcError> {
    let core = &daemon.core;
    let sessions = &daemon.sessions;
    Ok(match request {
        Request::GetCatalog => Response::GetCatalog {
            catalog: core.catalog(),
        },
        Request::GetActivity => Response::GetActivity {
            activity: core.activity().await,
        },
        Request::CreateProject { name, repo } => Response::CreateProject {
            project: Box::new(core.create_project(name, repo).await?),
        },
        Request::UpdateProject { id, patch } => Response::UpdateProject {
            project: Box::new(core.update_project(id, patch).await?),
        },
        Request::CreateConversation {
            kind,
            project_id,
            title,
            setup,
        } => Response::CreateConversation {
            conversation: Box::new(
                sessions
                    .create_conversation(kind, project_id, title, setup)
                    .await?,
            ),
        },
        Request::ForkConversation {
            conversation_id,
            message_id,
            place,
        } => Response::ForkConversation {
            conversation: Box::new(sessions.fork(conversation_id, message_id, place).await?),
        },
        Request::UpdateSetup { id, setup } => Response::UpdateSetup {
            conversation: Box::new(core.set_setup(id, setup).await?),
        },
        Request::GetConversation { id, limit } => Response::GetConversation {
            view: Box::new(core.conversation_view(id, limit).await?),
        },
        Request::SendMessage {
            conversation_id,
            text,
            attachments,
            mentions,
            steer,
        } => Response::SendMessage {
            outcome: match sessions
                .send_message(conversation_id, text, attachments, mentions, steer)
                .await?
            {
                brigadier_core::manager::SendOutcome::Sent(message) => SendOutcome::Sent {
                    message: Box::new(message),
                },
                brigadier_core::manager::SendOutcome::Queued(item) => SendOutcome::Queued { item },
            },
        },
        Request::EditQueued {
            conversation_id,
            item_id,
            text,
            attachments,
            mentions,
        } => Response::EditQueued {
            queue: core
                .edit_queued(&conversation_id, &item_id, text, attachments, mentions)
                .await?,
        },
        Request::DeleteQueued {
            conversation_id,
            item_id,
        } => {
            core.take_queued(&conversation_id, &item_id).await?;
            Response::DeleteQueued {
                queue: core.conversation_view(conversation_id, 1).await?.queue,
            }
        }
        Request::MoveQueued {
            conversation_id,
            item_id,
            index,
        } => Response::MoveQueued {
            queue: core.move_queued(&conversation_id, &item_id, index).await?,
        },
        Request::ResumeQueue { conversation_id } => Response::ResumeQueue {
            queue: sessions.resume_queue(conversation_id).await?,
        },
        Request::AddAttachment { name, mime, data } => {
            if data.len() > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 {
                return Err(IpcError {
                    code: ErrorCode::Invalid,
                    message: "the attachment is too large".into(),
                });
            }
            let bytes = BASE64.decode(data.as_bytes()).map_err(|err| IpcError {
                code: ErrorCode::Invalid,
                message: format!("the attachment is not valid base64: {err}"),
            })?;
            Response::AddAttachment {
                attachment: core.add_attachment(name, mime, bytes).await?,
            }
        }
        Request::ListWorkerEvents {
            task_id,
            before,
            limit,
        } => Response::ListWorkerEvents {
            page: core.list_worker_events(&task_id, before, limit).await?,
        },
        Request::ListOrchestratorLog {
            conversation_id,
            before,
            limit,
        } => Response::ListOrchestratorLog {
            page: core
                .list_orchestrator_log(&conversation_id, before, limit)
                .await?,
        },
        Request::ReadArtifact { id, offset, limit } => {
            let (bytes, total_bytes) = core.read_blob_range(id, offset, limit).await?;
            let text = match String::from_utf8(bytes) {
                Ok(text) => Some(text),
                // A slice can end inside a character; keep what decodes.
                Err(err) if err.utf8_error().error_len().is_none() => {
                    let valid = err.utf8_error().valid_up_to();
                    let mut bytes = err.into_bytes();
                    bytes.truncate(valid);
                    String::from_utf8(bytes).ok()
                }
                Err(_) => None,
            };
            Response::ReadArtifact {
                text: ArtifactText {
                    binary: text.is_none(),
                    text: text.unwrap_or_default(),
                    offset,
                    total_bytes,
                },
            }
        }
        Request::SaveArtifact { id, path } => {
            sessions.save_artifact(id, path).await?;
            Response::SaveArtifact
        }
        Request::OpenArtifact { id, file_name } => Response::OpenArtifact {
            path: sessions
                .artifact_copy(id, file_name)
                .await?
                .display()
                .to_string(),
        },
        Request::GetRepoInfo { path } => Response::GetRepoInfo {
            repo: sessions.repo_info(path).await?,
        },
        Request::ListFiles { conversation_id } => {
            let (files, truncated) = sessions.list_files(&conversation_id).await?;
            Response::ListFiles { files, truncated }
        }
        Request::RateMessage {
            conversation_id,
            subject,
            rating,
        } => {
            sessions.rate(&conversation_id, subject, rating).await?;
            Response::RateMessage
        }
        Request::GetSessionDiff { id } => Response::GetSessionDiff {
            stat: sessions.session_diff_stat(&id).await?,
        },
        Request::SteerQueued {
            conversation_id,
            item_id,
        } => {
            sessions.steer_queued(conversation_id, item_id).await?;
            Response::SteerQueued
        }
        Request::Interrupt { conversation_id } => {
            sessions.interrupt(conversation_id).await?;
            Response::Interrupt
        }
        Request::Resume { conversation_id } => {
            sessions.resume(conversation_id).await?;
            Response::Resume
        }
        Request::Compact { conversation_id } => {
            sessions.compact(conversation_id).await?;
            Response::Compact
        }
        Request::GetConversationStatus { conversation_id } => Response::GetConversationStatus {
            status: sessions.conversation_status(conversation_id).await?,
        },
        Request::EditMessage {
            conversation_id,
            message_id,
            text,
        } => {
            sessions
                .edit_message(conversation_id, message_id, text)
                .await?;
            Response::EditMessage
        }
        Request::Regenerate {
            conversation_id,
            request_id,
        } => {
            sessions.regenerate(conversation_id, request_id).await?;
            Response::Regenerate
        }
        Request::SwitchBranch {
            conversation_id,
            head,
        } => {
            sessions.switch_branch(conversation_id, head).await?;
            Response::SwitchBranch
        }
        Request::AnswerCard {
            conversation_id,
            card_id,
            decision,
        } => {
            sessions
                .answer_card(conversation_id, card_id, decision)
                .await?;
            Response::AnswerCard
        }
        Request::AnswerQuestion {
            conversation_id,
            card_id,
            answer,
        } => {
            sessions
                .answer_question(conversation_id, card_id, answer)
                .await?;
            Response::AnswerQuestion
        }
        Request::DecidePlan {
            conversation_id,
            card_id,
            approve,
            message,
        } => {
            sessions
                .decide_plan(conversation_id, card_id, approve, message)
                .await?;
            Response::DecidePlan
        }
        Request::StopTask { task_id } => {
            sessions.stop_task(task_id).await?;
            Response::StopTask
        }
        Request::PauseTask { task_id } => {
            sessions.pause_task(task_id).await?;
            Response::PauseTask
        }
        Request::ResumeTask { task_id } => {
            sessions.resume_task(task_id).await?;
            Response::ResumeTask
        }
        Request::RestoreKeptWork { task_id } => Response::RestoreKeptWork {
            outcome: sessions.restore_kept_work(task_id).await?,
        },
        Request::Hibernate { id } => Response::Hibernate {
            conversation: Box::new(sessions.hibernate(id).await?),
        },
        Request::Archive { id } => Response::Archive {
            conversation: Box::new(sessions.archive(id).await?),
        },
        Request::Restore { id } => Response::Restore {
            conversation: Box::new(sessions.restore(id).await?),
        },
        Request::Delete {
            id,
            delete_branches,
            forget_brain: _,
        } => {
            sessions.delete(id, delete_branches).await?;
            Response::Delete
        }
        Request::RenameConversation { id, title } => Response::RenameConversation {
            conversation: Box::new(core.rename_conversation(id, title).await?),
        },
        Request::SetPinned { id, pinned } => Response::SetPinned {
            conversation: Box::new(core.set_pinned(id, pinned).await?),
        },
        Request::AppendMessage {
            conversation_id,
            text,
        } => Response::AppendMessage {
            message: Box::new(core.append_message(conversation_id, text).await?),
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
        Request::GetProviders => Response::GetProviders {
            view: daemon.runtime.view().await,
        },
        Request::RefreshProviders => {
            daemon.runtime.refresh_providers();
            Response::RefreshProviders
        }
        Request::StartRawSession {
            provider,
            cwd,
            model,
            effort,
            access,
            approvals,
            record,
        } => Response::StartRawSession {
            session: Box::new(
                daemon
                    .runtime
                    .start_session(StartRaw {
                        provider,
                        cwd,
                        model,
                        effort,
                        access,
                        approvals,
                        record,
                    })
                    .await?,
            ),
        },
        Request::ResumeRawSession { id } => Response::ResumeRawSession {
            session: Box::new(daemon.runtime.resume_session(id).await?),
        },
        Request::ForkRawSession { id } => Response::ForkRawSession {
            session: Box::new(daemon.runtime.fork_session(id).await?),
        },
        Request::SendRawSession { id, text, steer } => {
            daemon.runtime.send(&id, text, steer).await?;
            Response::SendRawSession
        }
        Request::InterruptRawSession { id } => {
            daemon.runtime.interrupt(&id).await?;
            Response::InterruptRawSession
        }
        Request::AnswerApproval {
            id,
            approval_id,
            decision,
        } => {
            daemon.runtime.answer(&id, approval_id, decision).await?;
            Response::AnswerApproval
        }
        Request::StopRawSession { id } => {
            daemon.runtime.stop_session(&id).await?;
            Response::StopRawSession
        }
        Request::CloseRawSession { id } => Response::CloseRawSession {
            session: Box::new(daemon.runtime.close_session(id).await?),
        },
        Request::ListRawEvents { id, before, limit } => Response::ListRawEvents {
            page: daemon.runtime.transcript(&id, before, limit).await?,
        },
        Request::ReplayFixture { fixture_id } => Response::ReplayFixture {
            session: Box::new(daemon.runtime.replay(&fixture_id).await?),
        },
        Request::SimulateUsageLimit { provider } => Response::SimulateUsageLimit {
            session: Box::new(daemon.runtime.simulate_usage_limit(provider).await?),
        },
        Request::Subscribe { .. } | Request::SetMetricsStreaming { .. } | Request::Shutdown => {
            return Err(IpcError {
                code: ErrorCode::Invalid,
                message: "handled by the session".into(),
            });
        }
    })
}
