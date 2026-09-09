//! Deterministic subprocess tests for the installed-schema Codex app-server adapter.
use brigadier_core::{
    codex::{CodexDriver, CodexDriverConfig},
    driver::{PermissionMode, ProviderDriver, ResumeSession, Resumed, StartSession},
    event::{AbortReason, Event, TurnId},
    session::{CommandError, Decision, NativeControl, SessionHandle, TurnAttachment, TurnInput},
};
use serde_json::Value;
use std::time::Duration;

const FAKE: &str = r#"#!/usr/bin/env python3
import sys,json,os
log=os.environ.get('BRIGADIER_TEST_LOG')
mcp_ids=[]
def out(v):
 print(json.dumps(v),flush=True)
def note(m,p):out({'method':m,'params':dict({'threadId':'native'},**p)})
for line in sys.stdin:
 q=json.loads(line)
 if log:
  with open(log,'a') as f:f.write(json.dumps(q)+'\n')
 m=q.get('method');i=q.get('id');p=q.get('params',{})
 if m is None:
  if i in mcp_ids:note('turn/completed',{'turn':{'id':'native-turn','status':'completed'}})
  continue
 if m=='initialized':continue
 if m=='initialize':r={}
 elif m=='account/read':r={'account':{'type':'apiKey'},'requiresOpenaiAuth':True}
 elif m=='account/rateLimits/read':r={'rateLimits':None}
 elif m=='model/list':r={'data':[{'id':'exact-model','model':'exact-model','displayName':'Exact','isDefault':True,'supportedReasoningEfforts':[{'reasoningEffort':'low'},{'reasoningEffort':'high'}]}],'nextCursor':None}
 elif m=='config/read':r={'config':{'model':'exact-model','mcp_servers':{'external':{'command':'external'}}}}
 elif m in ['thread/start','thread/resume','thread/fork']:
  r={'thread':{'id':'native'},'model':p.get('model','exact-model'),'reasoningEffort':p.get('config',{}).get('model_reasoning_effort')}
 elif m=='thread/compact/start':
  out({'id':i,'result':{}})
  note('turn/started',{'turn':{'id':'compact-turn'}})
  note('item/completed',{'item':{'id':'compact','type':'contextCompaction'}})
  note('turn/completed',{'turn':{'id':'compact-turn','status':'completed'}});continue
 elif m=='turn/start':
  text=p['input'][0]['text']
  if text=='reject':out({'id':i,'error':{'code':-1,'message':'Rejected before dispatch'}});continue
  if text=='malformed':out({'id':i,'result':{}});continue
  out({'id':i,'result':{'turn':{'id':'native-turn'}}})
  note('turn/started',{'turn':{'id':'native-turn'}})
  if text in ['park','park-edit']:
   out({'id':'approval-native','method':'item/fileChange/requestApproval' if text=='park-edit' else 'item/commandExecution/requestApproval','params':{'threadId':'native','turnId':'native-turn','itemId':'tool','command':'echo approved','cwd':os.getcwd()}});continue
  if text.startswith('mcp-'):
   native_id=77 if text=='mcp-numeric' else 'mcp-native'
   params={'threadId':'native','turnId':'native-turn','serverName':'brigadier','mode':'form','message':'Allow the brigadier MCP server to run tool "task_checkpoint"?', 'requestedSchema':{'type':'object','properties':{}},'_meta':{'codex_approval_kind':'mcp_tool_call','tool_description':'Read task state','tool_params':{},'persist':['session','always']}}
   if text=='mcp-unknown':params['_meta']['codex_approval_kind']='other'
   if text=='mcp-malformed':params['requestedSchema']['properties']={'secret':{'type':'string'}}
   if text=='mcp-url':params['mode']='url'
   if text=='mcp-missing-args':del params['_meta']['tool_params']
   if text=='mcp-stale':params['threadId']='other-thread'
   if text=='mcp-wrong-turn':params['turnId']='other-turn'
   mcp_ids.append(native_id)
   frame={'id':native_id,'method':'mcpServer/elicitation/request','params':params}
   if text=='mcp-write-failure':os.close(0)
   out(frame)
   if text=='mcp-write-failure':
    import time
    time.sleep(5)
   if text=='mcp-duplicate':out(frame)
   if text=='mcp-resolved':
    note('serverRequest/resolved',{'requestId':native_id})
    note('turn/completed',{'turn':{'id':'native-turn','status':'completed'}})
   continue
  if text=='busy':continue
  note('item/started',{'item':{'id':'answer','type':'agentMessage','text':''}})
  note('item/agentMessage/delta',{'itemId':'answer','delta':'hello '})
  note('item/agentMessage/delta',{'itemId':'answer','delta':'world'})
  note('item/completed',{'item':{'id':'answer','type':'agentMessage','text':'hello world'}})
  note('thread/tokenUsage/updated',{'tokenUsage':{'total':{'inputTokens':100,'cachedInputTokens':20,'outputTokens':5},'last':{'totalTokens':105},'modelContextWindow':1000}})
  note('turn/completed',{'turn':{'id':'native-turn','status':'completed'}});continue
 elif m=='turn/interrupt':
  out({'id':i,'result':{}});note('turn/completed',{'turn':{'id':'native-turn','status':'interrupted'}});continue
 else:out({'id':i,'error':{'code':-32601,'message':'unsupported'}});continue
 out({'id':i,'result':r})
"#;
struct Fixture {
    dir: tempfile::TempDir,
    driver: CodexDriver,
}
impl Fixture {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("codex");
        std::fs::write(&binary, FAKE).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let driver = CodexDriver::with_version(
            CodexDriverConfig::new(format!("codex:test-{}", uuid::Uuid::new_v4())),
            &binary,
            "0.153.4",
        );
        Self { dir, driver }
    }
    fn request(&self) -> StartSession {
        let mut req = StartSession::new(self.dir.path());
        req.model = Some("exact-model".into());
        req.effort = Some("high".into());
        req.env_overrides.insert(
            "BRIGADIER_TEST_LOG".into(),
            self.dir.path().join("log").display().to_string(),
        );
        req
    }
    fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("log"))
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
}
async fn event(handle: &mut SessionHandle) -> brigadier_core::event::Envelope {
    tokio::time::timeout(Duration::from_secs(5), handle.events.recv())
        .await
        .expect("event deadline")
        .expect("stream")
}
async fn completed(handle: &mut SessionHandle) -> TurnId {
    loop {
        if let Event::TurnCompleted { turn_id, .. } = event(handle).await.event {
            return turn_id;
        }
    }
}
#[tokio::test]
async fn exact_model_effort_and_attachments_round_trip_with_stable_stream_ids() {
    let fixture = Fixture::new();
    let mut req = fixture.request();
    req.env_overrides
        .insert("BRIGADIER_EXECUTABLE".into(), "/app/brigadier".into());
    req.env_overrides
        .insert("BRIGADIER_PEER_TOKEN".into(), "secret".into());
    let mut handle = fixture.driver.start_session(req).await.unwrap();
    assert!(matches!(
        event(&mut handle).await.event,
        Event::SessionStarted { .. }
    ));
    let input = TurnInput {
        text: "hello".into(),
        display_text: Some("visible".into()),
        attachments: vec![
            TurnAttachment {
                id: "img".into(),
                name: "picture.png".into(),
                media_type: "image/png".into(),
                text: None,
                base64: "AQID".into(),
            },
            TurnAttachment {
                id: "file".into(),
                name: "note.txt".into(),
                media_type: "text/plain".into(),
                text: Some("literal **code**\n".into()),
                base64: "".into(),
            },
            TurnAttachment {
                id: "pdf".into(),
                name: "../report.pdf".into(),
                media_type: "application/pdf".into(),
                text: None,
                base64: "JVBERg==".into(),
            },
        ],
        ..Default::default()
    };
    let turn = handle.commands.send_turn(input).await.unwrap();
    let mut ids = vec![];
    let mut display = None;
    loop {
        let e = event(&mut handle).await;
        match e.event {
            Event::ContentDelta { item_id, .. } => ids.push(item_id.to_string()),
            Event::ItemCompleted {
                kind: brigadier_core::event::ItemKind::UserText,
                ..
            } => display = e.body,
            Event::TurnCompleted { turn_id, .. } => {
                assert_eq!(turn_id, turn);
                break;
            }
            _ => {}
        }
    }
    assert_eq!(ids, vec!["answer", "answer"]);
    assert_eq!(display.as_deref(), Some("visible"));
    assert_eq!(
        handle.commands.final_assistant_text(turn).await.unwrap(),
        "hello world"
    );
    let log = fixture.log();
    let start = log.iter().find(|q| q["method"] == "thread/start").unwrap();
    assert_eq!(start["params"]["config"]["model_reasoning_effort"], "high");
    assert_eq!(
        start["params"]["config"]["mcp_servers"]["external"]["enabled"],
        false
    );
    assert_eq!(
        start["params"]["config"]["mcp_servers"]["brigadier"]["args"][0],
        "--peer-mcp"
    );
    assert!(!start.to_string().contains("secret"));
    let sent = log.iter().find(|q| q["method"] == "turn/start").unwrap();
    assert_eq!(sent["params"]["model"], "exact-model");
    assert_eq!(sent["params"]["effort"], "high");
    assert_eq!(
        sent["params"]["input"][1]["url"],
        "data:image/png;base64,AQID"
    );
    assert!(sent["params"]["input"][2]["text"]
        .as_str()
        .unwrap()
        .contains("literal **code**\n"));
    let file = sent["params"]["input"][3]["path"].as_str().unwrap();
    assert_eq!(std::fs::read(file).unwrap(), b"%PDF");
    let context = handle
        .commands
        .native_control(NativeControl::ContextSummary)
        .await
        .unwrap();
    assert_eq!(context["totalTokens"], 105);
    assert_eq!(context["maxTokens"], 1000);
    handle.commands.end_session().await.unwrap();
}
#[tokio::test]
async fn resume_preserves_identity_event_sequence_and_permissions() {
    let fixture = Fixture::new();
    let mut req = ResumeSession::new("previous", fixture.dir.path());
    req.model = Some("exact-model".into());
    req.effort = Some("low".into());
    req.permission_mode = PermissionMode::Plan;
    req.resumed = Some(Resumed {
        session_id: "kept".into(),
        start_seq: 41,
    });
    req.env_overrides = fixture.request().env_overrides;
    let mut handle = fixture.driver.resume_session(req).await.unwrap();
    let first = event(&mut handle).await;
    assert_eq!(first.seq, 42);
    assert_eq!(first.session_id.as_str(), "kept");
    let log = fixture.log();
    let q = log.iter().find(|q| q["method"] == "thread/resume").unwrap();
    assert_eq!(q["params"]["threadId"], "previous");
    assert_eq!(q["params"]["sandbox"], "read-only");
    assert_eq!(q["params"]["approvalPolicy"], "never");
    handle.commands.kill().await.unwrap();
}
#[tokio::test]
async fn unsupported_selections_fail_before_thread_creation() {
    let fixture = Fixture::new();
    let mut req = fixture.request();
    req.effort = Some("made-up".into());
    assert!(fixture.driver.start_session(req).await.is_err());
    assert!(!fixture.log().iter().any(|q| q["method"] == "thread/start"));
    let mut req = fixture.request();
    req.permission_mode = PermissionMode::Auto;
    assert!(fixture.driver.start_session(req).await.is_err());
}
#[tokio::test]
async fn failed_send_is_not_dispatched_and_busy_send_never_steers() {
    let fixture = Fixture::new();
    let mut handle = fixture
        .driver
        .start_session(fixture.request())
        .await
        .unwrap();
    event(&mut handle).await;
    assert!(matches!(
        handle.commands.send_turn(TurnInput::text("reject")).await,
        Err(CommandError::NotDispatched(_))
    ));
    handle
        .commands
        .send_turn(TurnInput::text("busy"))
        .await
        .unwrap();
    assert!(matches!(
        handle.commands.send_turn(TurnInput::text("second")).await,
        Err(CommandError::NotDispatched(_))
    ));
    handle.commands.interrupt().await.unwrap();
    loop {
        if let Event::TurnAborted { reason, .. } = event(&mut handle).await.event {
            assert_eq!(reason, AbortReason::Interrupted);
            break;
        }
    }
    handle
        .commands
        .send_turn(TurnInput::text("next"))
        .await
        .unwrap();
    completed(&mut handle).await;
    handle.commands.kill().await.unwrap();
}
#[tokio::test]
async fn approval_is_native_and_cancel_expiry_is_observable() {
    let fixture = Fixture::new();
    let mut handle = fixture
        .driver
        .start_session(fixture.request())
        .await
        .unwrap();
    event(&mut handle).await;
    handle
        .commands
        .send_turn(TurnInput::text("park"))
        .await
        .unwrap();
    let id = loop {
        if let Event::RequestOpened { request_id, .. } = event(&mut handle).await.event {
            break request_id;
        }
    };
    handle
        .commands
        .respond(id.clone(), Decision::allow())
        .await
        .unwrap();
    loop {
        if let Event::RequestResolved { request_id, .. } = event(&mut handle).await.event {
            assert_eq!(request_id, id);
            break;
        }
    }
    handle.commands.interrupt().await.unwrap();
    assert!(fixture
        .log()
        .iter()
        .any(|q| q["id"] == "approval-native" && q["result"]["decision"] == "accept"));
    handle.commands.kill().await.unwrap();
}
#[tokio::test]
async fn checkpoint_reserves_exactly_one_send() {
    let fixture = Fixture::new();
    let mut handle = fixture
        .driver
        .start_session(fixture.request())
        .await
        .unwrap();
    event(&mut handle).await;
    let held = handle
        .commands
        .native_control(NativeControl::CheckpointBarrier)
        .await
        .unwrap();
    assert!(matches!(
        handle.commands.send_turn(TurnInput::text("hello")).await,
        Err(CommandError::NotDispatched(_))
    ));
    let turn = TurnId::new("reserved");
    handle
        .commands
        .native_control(NativeControl::CheckpointRelease {
            seq: held["seq"].as_u64().unwrap(),
            turn_id: Some(turn.clone()),
        })
        .await
        .unwrap();
    handle
        .commands
        .send_reserved_turn(turn, TurnInput::text("hello"))
        .await
        .unwrap();
    completed(&mut handle).await;
    handle.commands.kill().await.unwrap();
}
#[tokio::test]
#[ignore = "live local CLI/account smoke; opt in explicitly"]
async fn live_codex_smoke() {
    let driver = CodexDriver::probe(CodexDriverConfig::new("codex:live-test"))
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut req = StartSession::new(dir.path());
    req.permission_mode = PermissionMode::Plan;
    let mut handle = driver.start_session(req).await.unwrap();
    event(&mut handle).await;
    let turn = handle
        .commands
        .send_turn({
            use base64::Engine;
            TurnInput {
                text: "An image and marker.txt are attached. Reply with exactly the marker from marker.txt. Do not run tools.".into(),
                attachments: vec![
                    TurnAttachment {id:"live-image".into(),name:"icon.png".into(),media_type:"image/png".into(),text:None,base64:base64::engine::general_purpose::STANDARD.encode(include_bytes!("../../../src-tauri/icons/128x128.png"))},
                    TurnAttachment {id:"live-text".into(),name:"marker.txt".into(),media_type:"text/plain".into(),text:Some("BRIGADIER_CODEX_OK".into()),base64:String::new()},
                ],
                ..Default::default()
            }
        })
        .await
        .unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let e = handle.events.recv().await.expect("live stream");
            if let Event::TurnCompleted { turn_id, .. } = e.event {
                break turn_id;
            }
            if let Event::RuntimeError {
                message,
                fatal: true,
            } = e.event
            {
                panic!("{message}");
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(turn, completed);
    assert!(handle
        .commands
        .final_assistant_text(turn)
        .await
        .unwrap()
        .contains("BRIGADIER_CODEX_OK"));
    handle
        .commands
        .native_control(NativeControl::Compact)
        .await
        .unwrap();
    let mut compacted = false;
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            match handle.events.recv().await.expect("compact stream").event {
                Event::SessionCompacted { .. } => compacted = true,
                Event::TurnCompleted { .. } => break,
                Event::RuntimeError {
                    message,
                    fatal: true,
                } => panic!("{message}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(compacted, "real manual compaction notification");
    handle.commands.end_session().await.unwrap();
}

#[tokio::test]
async fn malformed_start_is_delivery_unknown_and_kill_survives_backpressure() {
    let fixture = Fixture::new();
    let mut req = fixture.request();
    req.event_buffer = 1;
    let mut handle = fixture.driver.start_session(req).await.unwrap();
    assert!(matches!(
        handle
            .commands
            .send_turn(TurnInput::text("malformed"))
            .await,
        Err(CommandError::DeliveryUnknown(_))
    ));
    while !matches!(event(&mut handle).await.event, Event::SessionExited { .. }) {}
    let mut req = fixture.request();
    req.event_buffer = 1;
    let handle = fixture.driver.start_session(req).await.unwrap();
    handle
        .commands
        .send_turn(TurnInput::text("hello"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle.commands.kill())
        .await
        .expect("stop is never blocked by full event channel")
        .unwrap();
}

#[tokio::test]
#[ignore = "live local account and native MCP transport smoke; opt in explicitly"]
async fn live_codex_native_mcp_smoke() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("peer");
    std::fs::write(&executable,r#"#!/usr/bin/env python3
import sys,json,os
for line in sys.stdin:
 q=json.loads(line);m=q.get('method');i=q.get('id')
 if i is None:continue
 if m=='initialize':r={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'brigadier-test','version':'1'}}
 elif m=='tools/list':r={'tools':[{'name':'brigadier_probe','description':'Read the Brigadier transport test marker. Call exactly once.','inputSchema':{'type':'object','properties':{}},'annotations':{'readOnlyHint':True}}]}
 elif m=='tools/call':
  assert os.environ.get('BRIGADIER_PEER_TOKEN')=='test-token'
  assert os.environ.get('BRIGADIER_PEER_ENDPOINT')=='test-endpoint'
  r={'content':[{'type':'text','text':'BRIGADIER_NATIVE_MCP_OK'}]}
 else:r={}
 print(json.dumps({'jsonrpc':'2.0','id':i,'result':r}),flush=True)
"#).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let driver = CodexDriver::probe(CodexDriverConfig::new("codex:live-mcp"))
        .await
        .unwrap();
    let mut req = StartSession::new(dir.path());
    req.permission_mode = PermissionMode::Plan;
    req.env_overrides.insert(
        "BRIGADIER_EXECUTABLE".into(),
        executable.display().to_string(),
    );
    req.env_overrides
        .insert("BRIGADIER_PEER_TOKEN".into(), "test-token".into());
    req.env_overrides
        .insert("BRIGADIER_PEER_ENDPOINT".into(), "test-endpoint".into());
    let mut handle = driver.start_session(req).await.unwrap();
    event(&mut handle).await;
    let turn=handle.commands.send_turn(TurnInput::text("Call the brigadier_probe MCP tool exactly once. Then reply with only its returned marker. Do not use other tools.")).await.unwrap();
    let mut native_tool = false;
    let mut native_result = false;
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let e = handle.events.recv().await.expect("live stream");
            match e.event {
                Event::ItemCompleted {
                    kind: brigadier_core::event::ItemKind::ToolCall { name },
                    ..
                } => {
                    native_tool |= name == "mcp__brigadier__brigadier_probe";
                }
                Event::ItemCompleted {
                    kind: brigadier_core::event::ItemKind::ToolResult { .. },
                    ..
                } => {
                    native_result |= e
                        .body
                        .as_deref()
                        .is_some_and(|b| b.contains("BRIGADIER_NATIVE_MCP_OK"));
                }
                Event::TurnCompleted { .. } => break,
                Event::RuntimeError {
                    message,
                    fatal: true,
                } => panic!("{message}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(native_tool, "native MCP call observed");
    assert!(native_result, "MCP output projected into tool result");
    assert!(handle
        .commands
        .final_assistant_text(turn)
        .await
        .unwrap()
        .contains("BRIGADIER_NATIVE_MCP_OK"));
    handle.commands.end_session().await.unwrap();
}

#[tokio::test]
async fn app_owned_binary_sources_survive_end_and_native_resume() {
    let mut fixture = Fixture::new();
    let mut config = CodexDriverConfig::new("codex:durable-test");
    config.attachment_dir = Some(fixture.dir.path().join("durable"));
    fixture.driver = CodexDriver::with_version(config, fixture.dir.path().join("codex"), "0.153.4");
    let mut handle = fixture
        .driver
        .start_session(fixture.request())
        .await
        .unwrap();
    event(&mut handle).await;
    let session = handle.session_id.clone();
    handle
        .commands
        .send_turn(TurnInput {
            text: "hello".into(),
            attachments: vec![TurnAttachment {
                id: "binary".into(),
                name: "file.pdf".into(),
                media_type: "application/pdf".into(),
                text: None,
                base64: "JVBERg==".into(),
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    completed(&mut handle).await;
    let log = fixture.log();
    let path = log.iter().find(|v| v["method"] == "turn/start").unwrap()["params"]["input"][1]
        ["path"]
        .as_str()
        .unwrap()
        .to_owned();
    handle.commands.end_session().await.unwrap();
    while !matches!(event(&mut handle).await.event, Event::SessionExited { .. }) {}
    assert_eq!(std::fs::read(&path).unwrap(), b"%PDF");
    let mut resume = ResumeSession::new("native", fixture.dir.path());
    resume.resumed = Some(Resumed {
        session_id: session,
        start_seq: 99,
    });
    let resumed = fixture.driver.resume_session(resume).await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"%PDF");
    resumed.commands.kill().await.unwrap();
}

#[tokio::test]
async fn native_compaction_uses_control_and_reports_manual_progress() {
    let fixture = Fixture::new();
    let mut handle = fixture
        .driver
        .start_session(fixture.request())
        .await
        .unwrap();
    event(&mut handle).await;
    let accepted = handle
        .commands
        .native_control(NativeControl::Compact)
        .await
        .unwrap();
    assert_eq!(accepted["accepted"], true);
    let mut compacted = false;
    loop {
        match event(&mut handle).await.event {
            Event::SessionCompacted { trigger, .. } => {
                assert_eq!(trigger, brigadier_core::event::CompactTrigger::Manual);
                compacted = true;
            }
            Event::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    assert!(compacted);
    assert!(fixture
        .log()
        .iter()
        .any(|q| q["method"] == "thread/compact/start"));
    assert!(!fixture.log().iter().any(|q| q["method"] == "turn/start"));
    handle.commands.kill().await.unwrap();
}

async fn approval_opened(handle: &mut SessionHandle) -> brigadier_core::event::RequestId {
    loop {
        if let Event::RequestOpened {
            request_id, kind, ..
        } = event(handle).await.event
        {
            if let brigadier_core::event::RequestKind::ToolPermission {
                tool_name,
                input_excerpt,
                suggestions,
                tool_call_id,
            } = kind
            {
                if tool_name.starts_with("MCP") {
                    assert_eq!(tool_name, "MCP · brigadier");
                    assert!(suggestions.is_empty());
                    assert!(tool_call_id.is_none());
                    let details: Value = serde_json::from_str(&input_excerpt).unwrap();
                    assert_eq!(details["arguments"], serde_json::json!({}));
                    assert!(details["message"]
                        .as_str()
                        .unwrap()
                        .contains("task_checkpoint"));
                }
            }
            return request_id;
        }
    }
}
#[tokio::test]
async fn mcp_tool_approval_allow_and_deny_use_exact_native_identity_and_schema() {
    for (prompt, id, decision, action) in [
        (
            "mcp-numeric",
            serde_json::json!(77),
            Decision::allow(),
            "accept",
        ),
        (
            "mcp-allow",
            serde_json::json!("mcp-native"),
            Decision::deny("No"),
            "decline",
        ),
        (
            "mcp-allow",
            serde_json::json!("mcp-native"),
            Decision::Deny {
                reason: "Stop".into(),
                interrupt: true,
            },
            "cancel",
        ),
    ] {
        let fixture = Fixture::new();
        let mut handle = fixture
            .driver
            .start_session(fixture.request())
            .await
            .unwrap();
        event(&mut handle).await;
        handle
            .commands
            .send_turn(TurnInput::text(prompt))
            .await
            .unwrap();
        let request = approval_opened(&mut handle).await;
        handle
            .commands
            .respond(request.clone(), decision)
            .await
            .unwrap();
        let mut resolved = 0;
        loop {
            match event(&mut handle).await.event {
                Event::RequestResolved { request_id, .. } => {
                    assert_eq!(request_id, request);
                    resolved += 1;
                }
                Event::TurnCompleted { .. } => break,
                _ => {}
            }
        }
        assert_eq!(resolved, 1);
        let log = fixture.log();
        let reply = log
            .iter()
            .find(|q| q["id"] == id && q.get("method").is_none())
            .unwrap();
        assert_eq!(reply["result"]["action"], action);
        assert_eq!(
            reply["result"]["content"],
            if action == "accept" {
                serde_json::json!({})
            } else {
                Value::Null
            }
        );
        assert_eq!(reply["result"]["_meta"], Value::Null);
        assert!(reply["result"].get("decision").is_none());
        assert!(handle
            .commands
            .respond(request, Decision::allow())
            .await
            .is_err());
        handle.commands.kill().await.unwrap();
    }
}
#[tokio::test]
async fn mcp_unknown_forms_and_stale_turns_never_open_or_approve() {
    for prompt in [
        "mcp-unknown",
        "mcp-malformed",
        "mcp-url",
        "mcp-missing-args",
        "mcp-stale",
        "mcp-wrong-turn",
    ] {
        let fixture = Fixture::new();
        let mut handle = fixture
            .driver
            .start_session(fixture.request())
            .await
            .unwrap();
        event(&mut handle).await;
        handle
            .commands
            .send_turn(TurnInput::text(prompt))
            .await
            .unwrap();
        loop {
            match event(&mut handle).await.event {
                Event::RequestOpened { .. } => {
                    panic!("Unrecognized request became an approval: {prompt}")
                }
                Event::TurnCompleted { .. } => break,
                _ => {}
            }
        }
        let log = fixture.log();
        let reply = log
            .iter()
            .find(|q| q["id"] == "mcp-native" && q.get("method").is_none())
            .unwrap();
        if matches!(prompt, "mcp-stale" | "mcp-wrong-turn") {
            assert_eq!(reply["result"]["action"], "cancel");
            assert!(reply["result"]["content"].is_null());
        } else {
            assert_eq!(reply["error"]["code"], -32601);
        }
        handle.commands.kill().await.unwrap();
    }
}
#[tokio::test]
async fn stopped_mcp_and_edit_approvals_are_resolved_once_and_reject_late_allow() {
    for prompt in ["mcp-allow", "park-edit"] {
        for end in [false, true] {
            let fixture = Fixture::new();
            let mut handle = fixture
                .driver
                .start_session(fixture.request())
                .await
                .unwrap();
            event(&mut handle).await;
            handle
                .commands
                .send_turn(TurnInput::text(prompt))
                .await
                .unwrap();
            let request = approval_opened(&mut handle).await;
            if end {
                handle.commands.end_session().await.unwrap();
            } else {
                handle.commands.kill().await.unwrap();
            }
            assert!(handle
                .commands
                .respond(request.clone(), Decision::allow())
                .await
                .is_err());
            let mut resolutions = 0;
            loop {
                match event(&mut handle).await.event {
                    Event::RequestResolved {
                        request_id,
                        decision,
                    } => {
                        assert_eq!(request_id, request);
                        assert!(matches!(
                            decision,
                            Decision::Deny {
                                interrupt: true,
                                ..
                            }
                        ));
                        resolutions += 1;
                    }
                    Event::SessionExited { .. } => break,
                    _ => {}
                }
            }
            assert_eq!(resolutions, 1);
            assert!(handle.approvals.pending().is_empty());
            assert!(!fixture
                .log()
                .iter()
                .any(|q| q["result"]["action"] == "accept" || q["result"]["decision"] == "accept"));
        }
    }
}
#[tokio::test]
async fn interrupted_mcp_approval_sends_cancel_before_interrupt() {
    let fixture = Fixture::new();
    let mut handle = fixture
        .driver
        .start_session(fixture.request())
        .await
        .unwrap();
    event(&mut handle).await;
    handle
        .commands
        .send_turn(TurnInput::text("mcp-allow"))
        .await
        .unwrap();
    let request = approval_opened(&mut handle).await;
    handle.commands.interrupt().await.unwrap();
    assert!(handle
        .commands
        .respond(request, Decision::allow())
        .await
        .is_err());
    let log = fixture.log();
    let reply = log
        .iter()
        .position(|q| q["id"] == "mcp-native" && q["result"]["action"] == "cancel")
        .unwrap();
    let interrupt = log
        .iter()
        .position(|q| q["method"] == "turn/interrupt")
        .unwrap();
    assert!(reply < interrupt);
    handle.commands.kill().await.unwrap();
}
#[tokio::test]
async fn server_resolved_and_duplicate_mcp_requests_do_not_leave_stale_prompts() {
    let fixture = Fixture::new();
    let mut handle = fixture
        .driver
        .start_session(fixture.request())
        .await
        .unwrap();
    event(&mut handle).await;
    handle
        .commands
        .send_turn(TurnInput::text("mcp-resolved"))
        .await
        .unwrap();
    let request = approval_opened(&mut handle).await;
    loop {
        if let Event::RequestResolved { request_id, .. } = event(&mut handle).await.event {
            assert_eq!(request_id, request);
            break;
        }
    }
    assert!(handle
        .commands
        .respond(request, Decision::allow())
        .await
        .is_err());
    completed(&mut handle).await;
    assert!(!fixture
        .log()
        .iter()
        .any(|q| q["id"] == "mcp-native" && q.get("method").is_none()));
    handle
        .commands
        .send_turn(TurnInput::text("mcp-duplicate"))
        .await
        .unwrap();
    let request = approval_opened(&mut handle).await;
    handle
        .commands
        .respond(request, Decision::allow())
        .await
        .unwrap();
    loop {
        match event(&mut handle).await.event {
            Event::RequestOpened { .. } => panic!("Duplicate RPC opened another approval"),
            Event::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    assert_eq!(
        fixture
            .log()
            .iter()
            .filter(|q| q["id"] == "mcp-native" && q["result"]["action"] == "accept")
            .count(),
        1
    );
    handle.commands.kill().await.unwrap();
}
#[tokio::test]
async fn queued_allow_cannot_outrun_a_queued_stop() {
    let fixture = Fixture::new();
    let mut handle = fixture
        .driver
        .start_session(fixture.request())
        .await
        .unwrap();
    event(&mut handle).await;
    handle
        .commands
        .send_turn(TurnInput::text("mcp-allow"))
        .await
        .unwrap();
    let request = approval_opened(&mut handle).await;
    let (allowed, stopped) = tokio::join!(
        handle.commands.respond(request.clone(), Decision::allow()),
        handle.commands.kill()
    );
    allowed.unwrap();
    stopped.unwrap();
    loop {
        match event(&mut handle).await.event {
            Event::RequestResolved {
                request_id,
                decision,
            } => {
                assert_eq!(request_id, request);
                assert!(matches!(
                    decision,
                    Decision::Deny {
                        interrupt: true,
                        ..
                    }
                ));
            }
            Event::SessionExited { .. } => break,
            _ => {}
        }
    }
    assert!(!fixture
        .log()
        .iter()
        .any(|q| q["result"]["action"] == "accept"));
}

#[tokio::test]
async fn failed_mcp_approval_write_closes_the_durable_prompt_as_unconfirmed() {
    let fixture = Fixture::new();
    let mut handle = fixture
        .driver
        .start_session(fixture.request())
        .await
        .unwrap();
    event(&mut handle).await;
    handle
        .commands
        .send_turn(TurnInput::text("mcp-write-failure"))
        .await
        .unwrap();
    let request = approval_opened(&mut handle).await;
    handle
        .commands
        .respond(request.clone(), Decision::allow())
        .await
        .unwrap();
    let mut resolutions = 0;
    loop {
        match event(&mut handle).await.event {
            Event::RequestResolved {
                request_id,
                decision,
            } => {
                assert_eq!(request_id, request);
                let Decision::Deny { reason, .. } = decision else {
                    panic!("write failure reported delivered approval")
                };
                assert!(reason.contains("unconfirmed"));
                resolutions += 1;
            }
            Event::SessionExited { .. } => break,
            _ => {}
        }
    }
    assert_eq!(resolutions, 1);
    assert!(handle.approvals.pending().is_empty());
}
#[tokio::test]
async fn mcp_approval_preserves_scoped_policy_denial() {
    struct DenyMcp;
    impl brigadier_core::claude::hook::HookPolicy for DenyMcp {
        fn pre_tool_use(&self, name: Option<&str>, input: &Value) -> claude_wire::HookJsonOutput {
            assert_eq!(name, Some("mcp__brigadier"));
            assert_eq!(input["_meta"]["codex_approval_kind"], "mcp_tool_call");
            claude_wire::HookJsonOutput {
                hook_specific_output: Some(serde_json::json!({"permissionDecision":"deny"})),
                ..Default::default()
            }
        }
    }
    let fixture = Fixture::new();
    let mut req = fixture.request();
    req.hook_policy = brigadier_core::driver::HookOverride::new(std::sync::Arc::new(DenyMcp));
    let mut handle = fixture.driver.start_session(req).await.unwrap();
    event(&mut handle).await;
    handle
        .commands
        .send_turn(TurnInput::text("mcp-allow"))
        .await
        .unwrap();
    loop {
        match event(&mut handle).await.event {
            Event::RequestOpened { .. } => panic!("policy denial reached interactive approval"),
            Event::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    assert!(fixture.log().iter().any(|q| q["id"] == "mcp-native"
        && q["result"]["action"] == "decline"
        && q["result"]["content"].is_null()));
    handle.commands.kill().await.unwrap();
}
