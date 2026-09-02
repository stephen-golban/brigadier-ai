//! Approvals survive a reload for rendering, and never survive a restart as answerable.

use std::time::SystemTime;

use brigadier_core::approval::PendingApproval;
use brigadier_core::event::{RequestId, RequestKind, SessionId, INPUT_EXCERPT_LIMIT};
use brigadier_core::session::Decision;
use brigadier_store::{Store, EXPIRED_REASON};

fn permission(tool: &str, input: &str) -> RequestKind {
    RequestKind::ToolPermission {
        tool_name: tool.to_owned(),
        input_excerpt: input.to_owned(),
        suggestions: Vec::new(),
        tool_call_id: Some("tu_1".to_owned()),
    }
}

#[tokio::test]
async fn a_pending_approval_survives_a_restart_only_as_expired() {
    let dir = tempfile::tempdir().expect("tempdir");
    let session = SessionId::new("s1");

    let first = Store::open(dir.path()).expect("open");
    let run_a = first.run_id().to_owned();
    first
        .handle()
        .approval_opened(
            session.clone(),
            PendingApproval {
                request_id: RequestId::new("r1"),
                kind: permission("Write", r#"{"path":"/a"}"#),
                opened_at: SystemTime::now(),
            },
        )
        .await
        .expect("open approval");
    first.handle().flush().await.expect("flush");

    // Still this launch: the prompt is pending and re-renderable, which is the whole point.
    let pending = first.handle().pending_approvals().await.expect("pending");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].run_id, run_a);
    assert_eq!(pending[0].session_id, session);
    assert!(matches!(pending[0].kind(), Some(RequestKind::ToolPermission { .. })));
    first.close().await.expect("close");

    // Restart. Nothing is listening on the in-memory one-shot any more.
    let second = Store::open(dir.path()).expect("reopen");
    assert_ne!(second.run_id(), run_a);
    assert!(second.handle().pending_approvals().await.expect("pending").is_empty());

    let all = second.handle().approvals(session).await.expect("approvals");
    assert_eq!(all.len(), 1);
    let row = &all[0];
    assert!(row.resolved_at.is_some(), "expired at startup");
    assert_eq!(row.run_id, run_a, "the row still names the launch that lost it");
    let decision: Decision =
        serde_json::from_str(row.decision_json.as_deref().expect("decision")).expect("decode");
    match decision {
        Decision::Deny { reason, .. } => assert_eq!(reason, EXPIRED_REASON),
        other => panic!("expected a denial, got {other:?}"),
    }
    second.close().await.expect("close");
}

#[tokio::test]
async fn an_answered_approval_is_not_touched_by_the_next_launch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let session = SessionId::new("s1");
    let first = Store::open(dir.path()).expect("open");
    first
        .handle()
        .approval_opened(
            session.clone(),
            PendingApproval {
                request_id: RequestId::new("r1"),
                kind: permission("Bash", "{}"),
                opened_at: SystemTime::now(),
            },
        )
        .await
        .expect("open");
    first
        .handle()
        .approval_resolved(RequestId::new("r1"), Decision::allow(), SystemTime::now())
        .await
        .expect("resolve");
    first.close().await.expect("close");

    let second = Store::open(dir.path()).expect("reopen");
    let all = second.handle().approvals(session).await.expect("approvals");
    let decision: Decision =
        serde_json::from_str(all[0].decision_json.as_deref().expect("decision")).expect("decode");
    assert!(matches!(decision, Decision::Allow { .. }), "the real answer was kept");
    second.close().await.expect("close");
}

#[tokio::test]
async fn an_oversized_tool_input_is_replaced_not_stored() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(dir.path()).expect("open");
    let huge = "z".repeat(INPUT_EXCERPT_LIMIT * 2);
    store
        .handle()
        .approval_opened(
            SessionId::new("s1"),
            PendingApproval {
                request_id: RequestId::new("r1"),
                kind: permission("Write", &huge),
                opened_at: SystemTime::now(),
            },
        )
        .await
        .expect("open");
    store.handle().flush().await.expect("flush");

    let pending = store.handle().pending_approvals().await.expect("pending");
    let json = &pending[0].kind_json;
    assert!(json.len() <= INPUT_EXCERPT_LIMIT, "kind_json is {} bytes", json.len());
    assert!(json.contains("\"oversized\""), "{json}");
    assert!(pending[0].kind().is_none(), "an oversized value does not pretend to decode");
    store.close().await.expect("close");
}
