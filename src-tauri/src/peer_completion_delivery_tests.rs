//! Exercise the production delivery loop against real supervisor/store and controlled actors.
use super::*;
use brigadier_core::{
    driver::{BoxFuture, DriverError, DriverInfo, DriverKind, ProviderDriver, ResumeSession},
    event::{ExitReason, InstanceId},
    session::{Command, NativeControl, SessionHandle},
};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Default)]
struct Actor {
    busy: AtomicBool,
    sends: AtomicUsize,
}
struct Driver {
    instance: InstanceId,
    actors: Arc<Mutex<HashMap<String, Arc<Actor>>>>,
}
impl ProviderDriver for Driver {
    fn kind(&self) -> DriverKind {
        DriverKind::new("completion-test")
    }
    fn instance_id(&self) -> &InstanceId {
        &self.instance
    }
    fn describe(&self) -> DriverInfo {
        DriverInfo {
            display_name: "Completion test".into(),
            binary_path: None,
            version: None,
            account_label: None,
        }
    }
    fn start_session(
        &self,
        req: StartSession,
    ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        Box::pin(async move {
            // The harness starts a fresh native call using the same durable task identity.
            let (id, start_seq) = req
                .resumed
                .as_ref()
                .map(|r| (r.session_id.clone(), r.start_seq))
                .unwrap_or_else(|| (SessionId::new(uuid::Uuid::new_v4().to_string()), 0));
            let actor = self
                .actors
                .lock()
                .unwrap()
                .entry(id.to_string())
                .or_insert_with(|| Arc::new(Actor::default()))
                .clone();
            let (handle, mut backend) =
                SessionHandle::channel(id.clone(), self.instance.clone(), 32);
            let instance = self.instance.clone();
            tokio::spawn(async move {
                backend
                    .events
                    .send(Envelope::new(
                        start_seq + 1,
                        instance.clone(),
                        id.clone(),
                        Event::SessionStarted {
                            provider_session_id: id.to_string(),
                            model: "fixture".into(),
                            cwd: req.cwd,
                            capabilities: vec![],
                            resume_token: Some(id.to_string()),
                        },
                    ))
                    .await
                    .unwrap();
                while let Some(command) = backend.commands.recv().await {
                    match command {
                        Command::Native {
                            request: NativeControl::Activity,
                            ack,
                        } => {
                            let _ = ack.send(Ok(json!({"status":if actor.busy.load(Ordering::SeqCst) {"Working"} else {"Idle"}})));
                        }
                        Command::SendTurn { ack, .. } => {
                            assert!(
                                !actor.busy.load(Ordering::SeqCst),
                                "must never dispatch into a busy parent"
                            );
                            actor.sends.fetch_add(1, Ordering::SeqCst);
                            let _ = ack.send(Ok(()));
                        }
                        Command::Kill { ack } | Command::EndSession { ack } => {
                            let _ = ack.send(Ok(()));
                            // Deliberate gap proves lifecycle consumers, not command acks, own exit.
                            tokio::time::sleep(Duration::from_millis(30)).await;
                            let _ = backend
                                .events
                                .send(Envelope::new(
                                    start_seq + 2,
                                    instance,
                                    id,
                                    Event::SessionExited {
                                        reason: ExitReason::Killed,
                                        exit_code: None,
                                    },
                                ))
                                .await;
                            break;
                        }
                        other => panic!("Unexpected completion-test command: {other:?}"),
                    }
                }
            });
            Ok(handle)
        })
    }
    fn resume_session(
        &self,
        _req: ResumeSession,
    ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        Box::pin(async { panic!("completion delivery must never resume a provider") })
    }
}

pub(crate) async fn run(state: &AppState, project: &str, root: &Path) {
    let actors = Arc::new(Mutex::new(HashMap::new()));
    let driver = Driver {
        instance: InstanceId::new("completion-test:default"),
        actors: actors.clone(),
    };
    let kind = driver.kind();
    let sup = &state.get().unwrap().supervisor;
    sup.register_driver(Arc::new(driver));
    let parent = sup
        .start_session(project, &kind, StartSession::new(root))
        .await
        .unwrap();
    let child = sup
        .start_session(project, &kind, StartSession::new(root))
        .await
        .unwrap();
    let owner = actors.lock().unwrap()[parent.as_str()].clone();
    let worker = actors.lock().unwrap()[child.as_str()].clone();
    change(|d| {
        d.origins.insert(child.to_string(), parent.to_string());
        Ok(())
    })
    .unwrap();
    let receipt =
        |turn, seq| change(|d| Ok(record(d, child.as_str(), turn, seq).unwrap())).unwrap();

    // Parent busy and a queued child follow-up: neither may be bypassed. Accepted child
    // delivery is still active work, so its receipt becoming delivered is insufficient.
    owner.busy.store(true, Ordering::SeqCst);
    worker.busy.store(true, Ordering::SeqCst);
    test_message(parent.as_str(), child.as_str(), true);
    let message = receipt("first", 10);
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(deliver_in(state, message.clone()), async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert_eq!(owner.sends.load(Ordering::SeqCst), 0);
            change(|d| {
                for m in &mut d.messages {
                    if m.to == child.as_str() {
                        m.delivered = true;
                    }
                }
                Ok(())
            })
            .unwrap();
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert_eq!(
                owner.sends.load(Ordering::SeqCst),
                0,
                "active accepted child follow-up still blocks wake"
            );
            worker.busy.store(false, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert_eq!(
                owner.sends.load(Ordering::SeqCst),
                0,
                "busy parent still blocks wake"
            );
            owner.busy.store(false, Ordering::SeqCst);
        });
    })
    .await
    .unwrap();
    assert_eq!(owner.sends.load(Ordering::SeqCst), 1);
    assert!(
        snapshot()
            .unwrap()
            .messages
            .iter()
            .find(|m| m.id == message.id)
            .unwrap()
            .delivered
    );
    deliver_in(state, message).await; // Repeated signal/dispatch cannot send twice.
    assert_eq!(owner.sends.load(Ordering::SeqCst), 1);

    // An active read/wait consumes the final result while delivery waits for the parent.
    owner.busy.store(true, Ordering::SeqCst);
    let message = receipt("observed", 20);
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(deliver_in(state, message.clone()), async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            observed_result(
                parent.as_str(),
                &json!({"sessionId":child,"status":"Idle","hasMore":false,
                "cursor":json!({"revision":20}).to_string()}),
            )
            .unwrap();
            owner.busy.store(false, Ordering::SeqCst);
        });
    })
    .await
    .unwrap();
    assert_eq!(owner.sends.load(Ordering::SeqCst), 1);
    let d = snapshot().unwrap();
    let consumed = d.messages.iter().find(|m| m.id == message.id).unwrap();
    assert!(consumed.delivered && consumed.error.is_none());

    // Stop cancellation while waiting cannot later turn into a continuation.
    owner.busy.store(true, Ordering::SeqCst);
    let message = receipt("stopped", 30);
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(deliver_in(state, message.clone()), async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            cancel_pending(parent.as_str()).unwrap();
            owner.busy.store(false, Ordering::SeqCst);
        });
    })
    .await
    .unwrap();
    assert_eq!(owner.sends.load(Ordering::SeqCst), 1);
    assert!(snapshot()
        .unwrap()
        .messages
        .iter()
        .find(|m| m.id == message.id)
        .unwrap()
        .error
        .as_deref()
        .unwrap()
        .contains("stopped"));

    sup.kill(&parent).await.unwrap();
    while sup.is_live(&parent) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let message = receipt("ended-parent", 40);
    deliver_in(state, message.clone()).await;
    assert_eq!(owner.sends.load(Ordering::SeqCst), 1);
    assert!(snapshot()
        .unwrap()
        .messages
        .iter()
        .find(|m| m.id == message.id)
        .unwrap()
        .error
        .is_some());
    sup.kill(&child).await.unwrap();
}
