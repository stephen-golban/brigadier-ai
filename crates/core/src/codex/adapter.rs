//! One actor owns a session's RPC stream, acknowledgements and event sequence.
use super::{
    capabilities,
    rpc::{protocol, Rpc},
};
use crate::{
    driver::{DriverError, Resumed, StartSession},
    event::{
        bounded, AbortReason, CompactTrigger, Envelope, Event, ExitReason, InstanceId, ItemId,
        ItemKind, RequestId, RequestKind, SessionId, StopReason, TurnId, Usage,
    },
    session::{
        Command, CommandError, Decision, FinalText, NativeControl, SessionBackend, SessionHandle,
        TurnInput,
    },
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};

const RPC_TIMEOUT: Duration = Duration::from_secs(30);
type Ack = oneshot::Sender<Result<(), CommandError>>;
enum Pending {
    Steer {
        ack: oneshot::Sender<Result<Value, CommandError>>,
        native: String,
        message_id: TurnId,
        display: String,
    },
    Send {
        ack: Ack,
        turn: TurnId,
        display: String,
    },
    Control(Ack),
    Compact {
        ack: oneshot::Sender<Result<Value, CommandError>>,
        turn: TurnId,
    },
}
struct Active {
    id: TurnId,
    native: Option<String>,
    text: BTreeMap<String, String>,
    order: Vec<String>,
    compacting: bool,
}
impl Active {
    fn record_text(&mut self, id: &str, text: &str, append: bool) {
        if !self.text.contains_key(id) {
            if self.text.len() >= 64 {
                return;
            }
            self.order.push(id.into());
        }
        let held = self.text.entry(id.into()).or_default();
        if append {
            if held.len() < 128 * 1024 {
                held.push_str(text);
                *held = bounded(held, 128 * 1024);
            }
        } else {
            *held = bounded(text, 128 * 1024);
        }
    }
    fn final_text(&self) -> String {
        let mut text = String::new();
        for id in &self.order {
            if let Some(part) = self.text.get(id) {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(part);
                if text.len() > 128 * 1024 {
                    break;
                }
            }
        }
        bounded(&text, 128 * 1024)
    }
}
#[derive(Clone)]
struct OpenApproval {
    native_id: Value,
    method: String,
}
struct Actor {
    rpc: Rpc,
    backend: SessionBackend,
    instance: InstanceId,
    session: SessionId,
    seq: u64,
    thread: String,
    model: String,
    req: StartSession,
    active: Option<Active>,
    pending: HashMap<u64, (Instant, Pending)>,
    open_approvals: HashMap<RequestId, OpenApproval>,
    approvals: mpsc::Receiver<(Value, RequestId, Decision, String)>,
    approval_tx: mpsc::Sender<(Value, RequestId, Decision, String)>,
    final_text: FinalText,
    usage: Usage,
    context: Value,
    action: Option<String>,
    barrier: Option<(u64, Option<TurnId>)>,
    files: PathBuf,
    ephemeral_files: bool,
    outbox: VecDeque<Envelope>,
}
pub(super) async fn connect(
    rpc: Rpc,
    instance: InstanceId,
    mut req: StartSession,
    resumed: Option<Resumed>,
    thread: String,
    model: String,
    attachment_dir: Option<PathBuf>,
) -> Result<SessionHandle, DriverError> {
    let (session, seq) = resumed
        .map(|r| (r.session_id, r.start_seq))
        .unwrap_or_else(|| (SessionId::new(uuid::Uuid::new_v4().to_string()), 0));
    let (mut handle, backend) =
        SessionHandle::channel(session.clone(), instance.clone(), req.event_buffer);
    handle.pid = rpc.child.id();
    let final_text = handle.commands.final_text_slot();
    let first = req.prompt.take().map(|text| TurnInput {
        text,
        display_text: req.display_prompt.take(),
        attachments: std::mem::take(&mut req.attachments),
        ..Default::default()
    });
    let (approval_tx, approvals) = mpsc::channel(32);
    let ephemeral_files = attachment_dir.is_none();
    let files = attachment_dir
        .map(|p| p.join(session.as_str()))
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("brigadier-codex-{}", uuid::Uuid::new_v4()))
        });
    let actor = Actor {
        rpc,
        backend,
        instance,
        session,
        seq,
        thread,
        model,
        req,
        active: None,
        pending: HashMap::new(),
        open_approvals: HashMap::new(),
        approvals,
        approval_tx,
        final_text,
        usage: Usage::default(),
        context: Value::Null,
        action: None,
        barrier: None,
        outbox: VecDeque::new(),
        files,
        ephemeral_files,
    };
    tokio::spawn(actor.run());
    if let Some(input) = first {
        if let Err(error) = handle.commands.send_turn(input).await {
            let _ = handle.commands.kill().await;
            return Err(protocol(error.to_string()));
        }
    }
    Ok(handle)
}
impl Actor {
    async fn emit(&mut self, event: Event, body: Option<&str>, raw: Option<&Value>) {
        self.seq += 1;
        let mut envelope =
            Envelope::new(self.seq, self.instance.clone(), self.session.clone(), event);
        if let Some(body) = body {
            envelope = envelope.with_body(body);
        }
        if let Some(raw) = raw {
            envelope = envelope.with_raw(&raw.to_string());
        }
        self.outbox.push_back(envelope);
    }
    async fn run(mut self) {
        self.emit(
            Event::SessionStarted {
                provider_session_id: self.thread.clone(),
                model: self.model.clone(),
                cwd: self.req.cwd.clone(),
                capabilities: vec![
                    "codex_app_server_v2".into(),
                    "interrupt_receipt_v1".into(),
                    "attachments_v1".into(),
                ],
                resume_token: Some(self.thread.clone()),
            },
            None,
            None,
        )
        .await;
        let mut timer = tokio::time::interval(Duration::from_millis(100));
        let exit;
        let event_tx = self.backend.events.clone();
        let event_capacity = self.req.event_buffer.max(1);
        loop {
            let result = tokio::select! {
                biased;
                // A queued Stop wins over a broker answer that has not reached the provider.
                command=self.backend.commands.recv()=>match command {
                    Some(Command::Kill{ack})=>{let _=self.cancel_approvals("Codex session stopped",false).await;let _=ack.send(Ok(()));exit=ExitReason::Killed;break;},
                    Some(Command::EndSession{ack})=>{let _=self.cancel_approvals("Codex session ended",false).await;let _=ack.send(Ok(()));exit=ExitReason::Graceful;break;},
                    Some(command)=>self.command(command).await,
                    None=>{exit=ExitReason::Graceful;break;}
                },
                frame=self.rpc.read(), if self.outbox.len()<event_capacity=>match frame {Ok(frame)=>self.frame(frame).await,Err(e)=>Err(e)},
                answer=self.approvals.recv()=>if let Some((id,request,decision,method))=answer{self.answer(id,request,decision,method).await}else{Ok(())},
                permit=event_tx.reserve(),if !self.outbox.is_empty()=>match permit { Ok(permit)=>{if let Some(event)=self.outbox.pop_front(){permit.send(event);}Ok(())},Err(_)=>{exit=ExitReason::Graceful;break;}},
                _=timer.tick()=>{
                    if self.pending.values().any(|(at,_)|at.elapsed()>RPC_TIMEOUT){Err(protocol("Codex request timed out; delivery is unconfirmed"))}else{Ok(())}
                },
            };
            if let Err(error) = result {
                let message = error.to_string();
                self.emit(
                    Event::RuntimeError {
                        message: message.clone(),
                        fatal: true,
                    },
                    None,
                    None,
                )
                .await;
                exit = ExitReason::Error(message);
                break;
            }
        }
        // Stop owns this private process group. No global Codex app daemon or transcripts touched.
        self.rpc.kill().await;
        let resolution_reason = if matches!(&exit, ExitReason::Error(_)) {
            "Codex connection ended; any pending approval delivery is unconfirmed"
        } else {
            "Codex session ended"
        };
        let _ = self.cancel_approvals(resolution_reason, false).await;
        for (_, (_, pending)) in self.pending.drain() {
            let ack = match pending {
                Pending::Send { ack, .. } | Pending::Control(ack) => ack,
                Pending::Compact { ack, .. } | Pending::Steer { ack, .. } => {
                    let _ = ack.send(Err(CommandError::DeliveryUnknown(
                        "Provider control acknowledgement was lost".into(),
                    )));
                    continue;
                }
            };
            let _ = ack.send(Err(CommandError::DeliveryUnknown(
                "Codex stopped before acknowledgement; inspect retained history before retrying"
                    .into(),
            )));
        }
        if let Some(active) = self.active.take() {
            self.final_text.set(active.id.clone(), active.final_text());
            self.emit(
                Event::TurnAborted {
                    turn_id: active.id,
                    reason: if exit == ExitReason::Killed {
                        AbortReason::Killed
                    } else {
                        AbortReason::Error("Codex session ended".into())
                    },
                },
                None,
                None,
            )
            .await;
        }
        self.emit(
            Event::SessionExited {
                reason: exit,
                exit_code: None,
            },
            None,
            None,
        )
        .await;
        // The process is already stopped; retaining final events may wait for the reader safely.
        while let Some(event) = self.outbox.pop_front() {
            if self.backend.events.send(event).await.is_err() {
                break;
            }
        }
        if self.ephemeral_files {
            let _ = tokio::fs::remove_dir_all(&self.files).await;
        }
    }
    async fn request(
        &mut self,
        method: &str,
        params: Value,
        pending: Pending,
    ) -> Result<(), DriverError> {
        let id = self.rpc.next_id;
        self.rpc.next_id += 1;
        self.pending.insert(id, (Instant::now(), pending));
        self.rpc
            .write(&json!({"id":id,"method":method,"params":params}))
            .await
    }
    async fn command(&mut self, command: Command) -> Result<(), DriverError> {
        match command {
            Command::SendTurn {
                turn_id,
                input,
                ack,
            } => {
                if self.active.is_some() {
                    let _ = ack.send(Err(CommandError::NotDispatched(
                        "Codex is busy; queue this message".into(),
                    )));
                    return Ok(());
                }
                if let Some((seq, reserved)) = &self.barrier {
                    if *seq != self.seq || reserved.as_ref() != Some(&turn_id) {
                        let _ = ack.send(Err(CommandError::NotDispatched(
                            "Workspace capture holds this session".into(),
                        )));
                        return Ok(());
                    }
                }
                self.barrier = None;
                if input.text.split_whitespace().next().is_some_and(|first| {
                    first.strip_prefix('/').is_some_and(|command| {
                        !command.is_empty()
                            && command.chars().all(|c| {
                                c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':'
                            })
                    })
                }) {
                    let _ = ack.send(Err(CommandError::NotDispatched(
                        "Codex app-server does not execute TUI slash commands as prompt text"
                            .into(),
                    )));
                    return Ok(());
                }
                let parts = match inputs(&input, &self.files).await {
                    Ok(parts) => parts,
                    Err(error) => {
                        let _ = ack.send(Err(CommandError::NotDispatched(error.to_string())));
                        return Ok(());
                    }
                };
                let mut params = json!({"threadId":self.thread,"clientUserMessageId":turn_id.as_str(),"input":parts,"model":self.model});
                if let Some(effort) = &self.req.effort {
                    params["effort"] = json!(effort);
                }
                self.active = Some(Active {
                    id: turn_id.clone(),
                    native: None,
                    text: BTreeMap::new(),
                    order: Vec::new(),
                    compacting: false,
                });
                self.request(
                    "turn/start",
                    params,
                    Pending::Send {
                        ack,
                        turn: turn_id,
                        display: input.display_text.unwrap_or(input.text),
                    },
                )
                .await?;
            }
            Command::Interrupt { ack } => {
                self.cancel_approvals("Turn interrupted", true).await?;
                if let Some(turn) = self.active.as_ref().and_then(|t| t.native.clone()) {
                    self.request(
                        "turn/interrupt",
                        json!({"threadId":self.thread,"turnId":turn}),
                        Pending::Control(ack),
                    )
                    .await?;
                } else if self.active.is_some() {
                    // A start in flight may already be executing. Kill rather than acknowledge a no-op.
                    let _ = ack.send(Err(CommandError::DeliveryUnknown(
                        "Codex turn start is awaiting acknowledgement; stopping process".into(),
                    )));
                    return Err(protocol("Stop during unacknowledged Codex turn start"));
                } else {
                    let _ = ack.send(Ok(()));
                }
            }
            Command::SetModel { model, ack } => {
                let result = if self.active.is_some() {
                    Err(CommandError::Rejected(
                        "Wait for the active turn to finish".into(),
                    ))
                } else {
                    capabilities::validate(
                        &capabilities::models(self.instance.as_str()),
                        Some(&model),
                        self.req.effort.as_deref(),
                    )
                    .map_err(|e| CommandError::Rejected(e.to_string()))
                    .map(|_| {
                        self.model = model;
                    })
                };
                let _ = ack.send(result);
            }
            Command::SetPermissionMode { mode: _, ack } => {
                let _ = ack.send(Err(CommandError::Rejected(
                    "Resume Codex with a new permission selection to change its sandbox".into(),
                )));
            }
            Command::Native { request, ack } => {
                if let NativeControl::Steer { message_id, input } = request {
                    let Some(native) = self
                        .active
                        .as_ref()
                        .and_then(|active| active.native.clone())
                    else {
                        let _ = ack.send(Err(CommandError::NotDispatched(
                            "No acknowledged active Codex turn to steer".into(),
                        )));
                        return Ok(());
                    };
                    let parts = match inputs(&input, &self.files).await {
                        Ok(parts) => parts,
                        Err(error) => {
                            let _ = ack.send(Err(CommandError::NotDispatched(error.to_string())));
                            return Ok(());
                        }
                    };
                    self.request("turn/steer", json!({"threadId":self.thread,"expectedTurnId":native,"clientUserMessageId":message_id.as_str(),"input":parts}), Pending::Steer { ack, native, message_id, display: input.display_text.unwrap_or(input.text) }).await?;
                    return Ok(());
                }
                let busy = self.active.is_some()
                    || !self.pending.is_empty()
                    || !self.backend.approvals.pending().is_empty();
                if matches!(request, NativeControl::Compact) {
                    if busy || self.barrier.is_some() {
                        let _ = ack.send(Err(CommandError::Rejected(
                            "Wait for Codex to become idle before compacting".into(),
                        )));
                        return Ok(());
                    }
                    let turn = TurnId::new(uuid::Uuid::new_v4().to_string());
                    self.active = Some(Active {
                        id: turn.clone(),
                        native: None,
                        text: BTreeMap::new(),
                        order: vec![],
                        compacting: true,
                    });
                    self.action = Some("Compacting context".into());
                    self.request(
                        "thread/compact/start",
                        json!({"threadId":self.thread}),
                        Pending::Compact { ack, turn },
                    )
                    .await?;
                    return Ok(());
                }
                let result = match request {
                    NativeControl::Activity => Ok(
                        json!({"provider":"Codex","cli":"codex","instance":self.instance,"model":self.model,"status":if !self.backend.approvals.pending().is_empty(){"Needs approval"}else if busy{"Working"}else{"Idle"},"action":self.action,"agents":[]}),
                    ),
                    NativeControl::ContextSummary => {
                        if self.context.is_null() {
                            Err(CommandError::Rejected(
                                "Codex has not reported context usage yet".into(),
                            ))
                        } else {
                            Ok(self.context.clone())
                        }
                    }
                    NativeControl::CheckpointBarrier if !busy && self.barrier.is_none() => {
                        self.barrier = Some((self.seq, None));
                        Ok(json!({"seq":self.seq}))
                    }
                    NativeControl::CheckpointVerify { seq }
                        if !busy
                            && self
                                .barrier
                                .as_ref()
                                .is_some_and(|(held, _)| *held == seq && seq == self.seq) =>
                    {
                        Ok(Value::Null)
                    }
                    NativeControl::CheckpointRelease { seq, turn_id }
                        if !busy
                            && self
                                .barrier
                                .as_ref()
                                .is_some_and(|(held, _)| *held == seq && seq == self.seq) =>
                    {
                        self.barrier = turn_id.map(|id| (seq, Some(id)));
                        Ok(Value::Null)
                    }
                    NativeControl::FinishRewind => {
                        self.barrier = None;
                        Ok(Value::Null)
                    }
                    NativeControl::RewindFiles { .. }
                    | NativeControl::RewindConversation { .. } => Err(CommandError::Rejected(
                        "Native rewind is unavailable for Codex; use Brigadier workspace history"
                            .into(),
                    )),
                    _ => Err(CommandError::Rejected(
                        "Workspace capture requires an unchanged idle Codex session".into(),
                    )),
                };
                let _ = ack.send(result);
            }
            Command::Kill { .. } | Command::EndSession { .. } => unreachable!(),
        }
        Ok(())
    }
    async fn frame(&mut self, msg: Value) -> Result<(), DriverError> {
        let Some(method) = msg["method"].as_str() else {
            let Some(id) = msg["id"].as_u64() else {
                return Ok(());
            };
            if let Some((_, pending)) = self.pending.remove(&id) {
                let response = super::rpc::result(msg);
                match pending {
                    Pending::Steer {
                        ack,
                        native,
                        message_id,
                        display,
                    } => {
                        match response {
                            Ok(result) if result["turnId"].as_str() == Some(native.as_str()) => {
                                self.emit(
                                    Event::item_completed(
                                        ItemId::new(format!("user:{message_id}")),
                                        ItemKind::UserText,
                                        &display,
                                        None,
                                    ),
                                    Some(&display),
                                    None,
                                )
                                .await;
                                let _ = ack.send(Ok(result));
                            }
                            Ok(_) => {
                                let _ = ack.send(Err(CommandError::DeliveryUnknown("Codex steer acknowledgement omitted or changed the active turn id".into())));
                            }
                            Err(error) => {
                                let _ =
                                    ack.send(Err(CommandError::NotDispatched(error.to_string())));
                            }
                        }
                    }
                    Pending::Send { ack, turn, display } => match response {
                        Ok(result) => {
                            let Some(native) = result["turn"]["id"].as_str().map(str::to_owned)
                            else {
                                let _ = ack.send(Err(CommandError::DeliveryUnknown(
                                    "Codex acknowledged start without a turn id".into(),
                                )));
                                return Err(protocol("Codex turn/start omitted turn id"));
                            };
                            if let Some(active) = &mut self.active {
                                active.native = Some(native);
                            }
                            self.emit(
                                Event::TurnStarted {
                                    turn_id: turn.clone(),
                                },
                                None,
                                None,
                            )
                            .await;
                            self.emit(
                                Event::item_completed(
                                    ItemId::new(format!("user:{turn}")),
                                    ItemKind::UserText,
                                    &display,
                                    None,
                                ),
                                Some(&display),
                                None,
                            )
                            .await;
                            let _ = ack.send(Ok(()));
                        }
                        Err(error) => {
                            self.active = None;
                            let _ = ack.send(Err(CommandError::NotDispatched(error.to_string())));
                        }
                    },
                    Pending::Compact { ack, turn } => match response {
                        Ok(_) => {
                            self.emit(Event::TurnStarted { turn_id: turn }, None, None)
                                .await;
                            let _=ack.send(Ok(json!({"accepted":true,"operation":"compact","message":"Compaction started; progress appears in the conversation"})));
                        }
                        Err(error) => {
                            self.active = None;
                            let _ = ack.send(Err(CommandError::Rejected(error.to_string())));
                        }
                    },
                    Pending::Control(ack) => {
                        let _ = ack.send(
                            response
                                .map(|_| ())
                                .map_err(|e| CommandError::Rejected(e.to_string())),
                        );
                    }
                }
            }
            return Ok(());
        };
        let params = &msg["params"];
        if msg.get("id").is_some() {
            return self.approval(msg.clone(), method.to_owned()).await;
        }
        if params
            .get("threadId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != self.thread)
        {
            return Ok(());
        }
        match method {
            "turn/started" => {
                if let Some(active) = &mut self.active {
                    active.native = params["turn"]["id"].as_str().map(str::to_owned);
                }
            }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                let Some(id) = item["id"].as_str() else {
                    return Ok(());
                };
                let typ = item["type"].as_str().unwrap_or("unknown");
                // User text is emitted once from acknowledged app-owned input, preserving mentions.
                if typ == "userMessage" {
                    return Ok(());
                }
                let completed = method == "item/completed";
                if typ == "contextCompaction" && completed {
                    self.emit(
                        Event::SessionCompacted {
                            trigger: if self.active.as_ref().is_some_and(|a| a.compacting) {
                                CompactTrigger::Manual
                            } else {
                                CompactTrigger::Auto
                            },
                            pre_tokens: None,
                        },
                        None,
                        Some(&msg),
                    )
                    .await;
                    return Ok(());
                }
                let (kind, text) = item_content(item);
                self.action = Some(bounded(&text, 240));
                if typ == "agentMessage" && completed {
                    if let Some(active) = &mut self.active {
                        active.record_text(id, &text, false);
                    }
                }
                let is_tool = matches!(kind, ItemKind::ToolCall { .. });
                let event = if completed {
                    Event::item_completed(ItemId::new(id), kind, &text, None)
                } else {
                    Event::item_started(ItemId::new(id), kind, &text, None)
                };
                self.emit(event, Some(&text), Some(&msg)).await;
                if completed && is_tool {
                    let output = tool_result(item);
                    let failed = item["status"] == "failed"
                        || item["status"] == "declined"
                        || item["exitCode"].as_i64().is_some_and(|c| c != 0)
                        || !item["error"].is_null();
                    self.emit(
                        Event::item_completed(
                            ItemId::new(format!("{id}:result")),
                            ItemKind::ToolResult {
                                tool_call_id: id.into(),
                                is_error: failed,
                            },
                            &output,
                            None,
                        ),
                        Some(&output),
                        Some(&msg),
                    )
                    .await;
                }
            }
            "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta"
            | "item/commandExecution/outputDelta"
            | "item/plan/delta" => {
                if let (Some(id), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    if method == "item/agentMessage/delta" {
                        if let Some(active) = &mut self.active {
                            active.record_text(id, delta, true);
                        }
                    }
                    self.emit(
                        Event::ContentDelta {
                            item_id: ItemId::new(id),
                            text: delta.into(),
                        },
                        None,
                        None,
                    )
                    .await;
                }
            }
            "thread/tokenUsage/updated" => {
                let usage = &params["tokenUsage"];
                let total = &usage["total"];
                self.usage = Usage {
                    input_tokens: total["inputTokens"]
                        .as_u64()
                        .unwrap_or(0)
                        .saturating_sub(total["cachedInputTokens"].as_u64().unwrap_or(0)),
                    output_tokens: total["outputTokens"].as_u64().unwrap_or(0),
                    cache_read_tokens: total["cachedInputTokens"].as_u64().unwrap_or(0),
                    cache_creation_tokens: total["cacheWriteInputTokens"].as_u64().unwrap_or(0),
                    context_window: usage["modelContextWindow"].as_u64(),
                };
                self.context = json!({"provider":"codex","source":"thread/tokenUsage/updated","tokenUsage":usage,"totalTokens":usage["last"]["totalTokens"],"maxTokens":usage["modelContextWindow"],"model":self.model});
            }
            "account/rateLimits/updated" => {
                capabilities::record_usage(self.instance.as_str(), params.clone());
            }
            "turn/completed" => {
                if let Some(active) = self.active.take() {
                    self.final_text.set(active.id.clone(), active.final_text());
                    let turn = &params["turn"];
                    crate::allowance::record(
                        "codex",
                        self.instance.as_str(),
                        turn["error"].clone(),
                    );
                    let event = match turn["status"].as_str() {
                        Some("interrupted") => Event::TurnAborted {
                            turn_id: active.id,
                            reason: AbortReason::Interrupted,
                        },
                        status => Event::TurnCompleted {
                            turn_id: active.id,
                            stop_reason: if status == Some("completed") {
                                StopReason::EndTurn
                            } else {
                                StopReason::Error(
                                    turn["error"]["message"]
                                        .as_str()
                                        .unwrap_or("Codex turn failed")
                                        .into(),
                                )
                            },
                            usage: self.usage,
                            cost_usd_cumulative: 0.0,
                        },
                    };
                    self.emit(event, None, Some(&msg)).await;
                    self.cancel_approvals("Codex turn ended", false).await?;
                }
            }
            "serverRequest/resolved" => {
                let request = self
                    .open_approvals
                    .iter()
                    .find(|(_, entry)| entry.native_id == params["requestId"])
                    .map(|(request, _)| request.clone());
                if let Some(request) = request {
                    self.open_approvals.remove(&request);
                    let decision = cancelled("Provider resolved this approval");
                    let _ = self.backend.approvals.resolve(&request, decision.clone());
                    self.emit(
                        Event::RequestResolved {
                            request_id: request,
                            decision,
                        },
                        None,
                        None,
                    )
                    .await;
                }
            }
            "error" => {
                crate::allowance::record("codex", self.instance.as_str(), params["error"].clone());
                let fatal = params["willRetry"] != true;
                self.emit(
                    Event::RuntimeError {
                        message: params["error"]["message"]
                            .as_str()
                            .unwrap_or("Codex provider error")
                            .into(),
                        fatal,
                    },
                    None,
                    Some(&msg),
                )
                .await;
            }
            _ => {}
        }
        Ok(())
    }
    async fn approval(&mut self, msg: Value, method: String) -> Result<(), DriverError> {
        let id = msg["id"].clone();
        let params = &msg["params"];
        if !id.is_string() && id.as_i64().is_none() {
            return self.rpc.write(&json!({"id":id,"error":{"code":-32600,"message":"Invalid Codex request identity"}})).await;
        }
        if self
            .open_approvals
            .values()
            .any(|open| open.native_id == id)
        {
            return Ok(());
        }
        let name = match method.as_str() {
            "item/commandExecution/requestApproval" => "Bash".to_owned(),
            "item/fileChange/requestApproval" => "Edit".to_owned(),
            "mcpServer/elicitation/request" if mcp_tool_approval(params) => {
                if params["threadId"] != self.thread
                    || !self
                        .active
                        .as_ref()
                        .and_then(|a| a.native.as_deref())
                        .is_some_and(|turn| params["turnId"] == turn)
                {
                    return self.rpc.write(&json!({"id":id,"result":approval_result(&method,&cancelled("Stale MCP approval"))})).await;
                }
                format!("MCP · {}", params["serverName"].as_str().unwrap_or(""))
            }
            _ => {
                self.rpc.write(&json!({"id":id,"error":{"code":-32601,"message":"Brigadier does not support this Codex request"}})).await?;
                self.emit(
                    Event::RuntimeWarning {
                        message: format!("Unsupported Codex request {method}; no action approved"),
                    },
                    None,
                    Some(&msg),
                )
                .await;
                return Ok(());
            }
        };
        if self.backend.approvals.pending().len() >= 32 {
            return Err(protocol("Too many concurrent Codex approvals"));
        }
        let request = RequestId::new(uuid::Uuid::new_v4().to_string());
        // Apply the shared scoped policy before presenting native escalations.
        let mut input = params.clone();
        if let Some(cwd) = params.get("cwd") {
            input["cwd"] = cwd.clone();
        }
        if let Some(policy) = self.req.hook_policy.policy() {
            let policy_name = if method == "mcpServer/elicitation/request" {
                format!("mcp__{}", params["serverName"].as_str().unwrap_or(""))
            } else {
                name.clone()
            };
            let output = serde_json::to_value(policy.pre_tool_use(Some(&policy_name), &input))
                .map_err(|e| protocol(e.to_string()))?;
            if output["hookSpecificOutput"]["permissionDecision"] == "deny" {
                return self
                    .rpc
                    .write(&json!({"id":id,"result":approval_result(&method,&Decision::deny("Session policy denied this tool"))}))
                    .await;
            }
        }
        // This server is injected by thread_config from the app-owned endpoint.
        // Its tools enforce task ownership and action-specific approval themselves.
        // Preserve native identity/schema checks and scoped policy denials above.
        if method == "mcpServer/elicitation/request"
            && params["serverName"] == "brigadier"
            && [
                "BRIGADIER_EXECUTABLE",
                "BRIGADIER_PEER_TOKEN",
                "BRIGADIER_PEER_ENDPOINT",
            ]
            .iter()
            .all(|key| {
                self.req
                    .env_overrides
                    .get(*key)
                    .is_some_and(|v| !v.is_empty())
            })
        {
            return self
                .rpc
                .write(&json!({"id":id,"result":approval_result(&method,&Decision::allow())}))
                .await;
        }
        let display = if method == "mcpServer/elicitation/request" {
            json!({"message":params["message"],"description":params["_meta"]["tool_description"],"arguments":params["_meta"]["tool_params"]})
        } else {
            params.clone()
        };
        let kind = RequestKind::tool_permission(
            &name,
            &display.to_string(),
            vec![],
            params["itemId"].as_str().map(str::to_owned),
        );
        self.open_approvals.insert(
            request.clone(),
            OpenApproval {
                native_id: id.clone(),
                method: method.clone(),
            },
        );
        let wait = self.backend.approvals.open(
            request.clone(),
            kind.clone(),
            Some(Duration::from_secs(600)),
        );
        self.emit(
            Event::RequestOpened {
                request_id: request.clone(),
                kind,
                turn_id: self.active.as_ref().map(|a| a.id.clone()),
            },
            None,
            Some(&msg),
        )
        .await;
        let tx = self.approval_tx.clone();
        tokio::spawn(async move {
            let decision = wait
                .await
                .unwrap_or_else(|_| Decision::deny("request expired"));
            let _ = tx.send((id, request, decision, method)).await;
        });
        Ok(())
    }
    async fn cancel_approvals(&mut self, reason: &str, reply: bool) -> Result<(), DriverError> {
        let open = std::mem::take(&mut self.open_approvals);
        self.backend.approvals.cancel_all(reason);
        let mut write_error = None;
        for (request, entry) in open {
            let decision = cancelled(reason);
            // Always persist the closed prompt, including Kill/End where the actor no
            // longer consumes waiter messages. Clearing the registry rejects late Allow.
            self.emit(
                Event::RequestResolved {
                    request_id: request,
                    decision: decision.clone(),
                },
                None,
                None,
            )
            .await;
            if reply && write_error.is_none() {
                if let Err(error)=self.rpc.write(&json!({"id":entry.native_id,"result":approval_result(&entry.method,&decision)})).await {write_error=Some(error);}
            }
        }
        if let Some(error) = write_error {
            Err(error)
        } else {
            Ok(())
        }
    }
    async fn answer(
        &mut self,
        id: Value,
        request: RequestId,
        mut decision: Decision,
        method: String,
    ) -> Result<(), DriverError> {
        if !self
            .open_approvals
            .get(&request)
            .is_some_and(|entry| entry.native_id == id && entry.method == method)
        {
            return Ok(());
        }
        // Keep the registry entry until write succeeds, so disconnect teardown
        // still closes a persisted prompt if delivery fails.
        // Codex cannot rewrite an approved command. Never quietly execute original after edits.
        if matches!(
            &decision,
            Decision::Allow {
                updated_input: Some(_),
                ..
            }
        ) {
            decision = Decision::deny("Codex approval does not support editing tool input");
        }
        self.rpc
            .write(&json!({"id":id,"result":approval_result(&method,&decision)}))
            .await?;
        self.open_approvals.remove(&request);
        self.emit(
            Event::RequestResolved {
                request_id: request,
                decision,
            },
            None,
            None,
        )
        .await;
        Ok(())
    }
}
fn item_content(item: &Value) -> (ItemKind, String) {
    let typ = item["type"].as_str().unwrap_or("unknown");
    match typ {
        "agentMessage" | "plan" => (
            ItemKind::AssistantText,
            item["text"].as_str().unwrap_or("").into(),
        ),
        "reasoning" => (
            ItemKind::Thinking,
            item["summary"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        "commandExecution" => (
            ItemKind::ToolCall {
                name: "Bash".into(),
            },
            json!({"command":item["command"],"cwd":item["cwd"]}).to_string(),
        ),
        "fileChange" => (
            ItemKind::ToolCall {
                name: "Edit".into(),
            },
            item["changes"].to_string(),
        ),
        "mcpToolCall" => (
            ItemKind::ToolCall {
                name: format!(
                    "mcp__{}__{}",
                    item["server"].as_str().unwrap_or(""),
                    item["tool"].as_str().unwrap_or("")
                ),
            },
            item["arguments"].to_string(),
        ),
        _ => (ItemKind::ToolCall { name: typ.into() }, item.to_string()),
    }
}
async fn inputs(input: &TurnInput, files: &std::path::Path) -> Result<Vec<Value>, DriverError> {
    use base64::Engine;
    let mut parts = vec![json!({"type":"text","text":input.text,"text_elements":[]})];
    for attachment in &input.attachments {
        if let Some(text) = &attachment.text {
            parts.push(json!({"type":"text","text":format!("Attached file {:?} ({}):\n{}",attachment.name,attachment.id,text),"text_elements":[]}));
        } else if attachment.media_type.starts_with("image/") {
            parts.push(json!({"type":"image","url":format!("data:{};base64,{}",attachment.media_type,attachment.base64)}));
        } else {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&attachment.base64)
                .map_err(|_| protocol("Invalid attachment encoding"))?;
            tokio::fs::create_dir_all(files)
                .await
                .map_err(|e| protocol(e.to_string()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(files, std::fs::Permissions::from_mode(0o700))
                    .await
                    .map_err(|e| protocol(e.to_string()))?;
            }
            let filename = std::path::Path::new(&attachment.name)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("attachment.bin");
            let path = files.join(format!("{}-{filename}", uuid::Uuid::new_v4()));
            tokio::fs::write(&path, bytes)
                .await
                .map_err(|e| protocol(e.to_string()))?;
            parts.push(json!({"type":"mention","name":attachment.name,"path":path}));
        }
    }
    for path in &input.attachment_paths {
        if !path.is_absolute() || !path.is_file() {
            return Err(protocol(
                "Attachment path must be an existing absolute file",
            ));
        }
        parts.push(json!({"type":"mention","name":path.file_name().and_then(|n|n.to_str()).unwrap_or("attachment"),"path":path}));
    }
    Ok(parts)
}

fn tool_result(item: &Value) -> String {
    match item["type"].as_str() {
        Some("commandExecution") => item["aggregatedOutput"].as_str().unwrap_or("").into(),
        Some("mcpToolCall") => {
            if !item["error"].is_null() {
                return item["error"].to_string();
            }
            item["result"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => item.to_string(),
    }
}

fn cancelled(reason: &str) -> Decision {
    Decision::Deny {
        reason: reason.into(),
        interrupt: true,
    }
}
fn approval_result(method: &str, decision: &Decision) -> Value {
    let action = match decision {
        Decision::Allow { .. } => "accept",
        Decision::Deny {
            interrupt: true, ..
        } => "cancel",
        Decision::Deny { .. } => "decline",
    };
    if method == "mcpServer/elicitation/request" {
        json!({"action":action,"content":if action=="accept"{json!({})}else{Value::Null},"_meta":Value::Null})
    } else {
        json!({"decision":action})
    }
}
// This is a native tool approval encoded as MCP elicitation, not an arbitrary form.
// Checked against codex-cli 0.153.4 generated McpServerElicitationRequestResponse.
fn mcp_tool_approval(params: &Value) -> bool {
    let Some(schema) = params["requestedSchema"].as_object() else {
        return false;
    };
    params["mode"] == "form"
        && params["_meta"]["codex_approval_kind"] == "mcp_tool_call"
        && params["serverName"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
        && params["message"].is_string()
        && params["_meta"]["tool_params"].is_object()
        && schema.get("type") == Some(&json!("object"))
        && schema
            .get("properties")
            .and_then(Value::as_object)
            .is_some_and(|p| p.is_empty())
        && schema
            .keys()
            .all(|key| matches!(key.as_str(), "type" | "properties" | "required"))
        && schema
            .get("required")
            .is_none_or(|v| v.as_array().is_some_and(|v| v.is_empty()))
}
