use brigadier_core::driver::McpPolicy;
use brigadier_core::event::SessionId;
use brigadier_store::{ProjectRow, SessionRow, Store};

async fn seed(path: &std::path::Path) -> Store {
    let store = Store::open(path).unwrap();
    for project in ["p", "other"] {
        store
            .handle()
            .upsert_project(ProjectRow {
                id: project.into(),
                name: project.into(),
                root_path: format!("/{project}").into(),
                created_at: std::time::SystemTime::now(),
                mcp: McpPolicy::Off,
            })
            .await
            .unwrap();
    }
    for (session, project) in [("s", "p"), ("fork", "p"), ("foreign", "other")] {
        let mut row = SessionRow::new(SessionId::new(session));
        row.project_id = Some(project.into());
        store.handle().upsert_session(row).await.unwrap();
    }
    store
}

#[tokio::test]
async fn imports_commit_immutable_bytes_and_scope_reads_to_project() {
    let dir = tempfile::tempdir().unwrap();
    let store = seed(dir.path()).await;
    let bytes = b"decoded and validated at IPC".to_vec();
    let metadata = store
        .handle()
        .import_attachment(
            "p".into(),
            "img".into(),
            "a.png".into(),
            "image/png".into(),
            bytes.clone(),
        )
        .await
        .unwrap();
    // A second connection sees the row immediately: acknowledgement means committed.
    let conn = rusqlite::Connection::open(store.path()).unwrap();
    let disk: Vec<u8> = conn
        .query_row(
            "SELECT bytes FROM conversation_attachments WHERE id='img'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(disk, bytes);
    assert!(store
        .handle()
        .import_attachment(
            "p".into(),
            "img".into(),
            "changed.png".into(),
            "image/png".into(),
            vec![0]
        )
        .await
        .is_err());
    assert!(store
        .handle()
        .attachment("other".into(), "img".into())
        .await
        .unwrap()
        .is_none());
    assert!(store
        .handle()
        .attachments("p".into(), vec!["img".into(), "missing".into()])
        .await
        .is_err());
    store.close().await.unwrap();
    let reopened = Store::open(dir.path()).unwrap();
    let image = reopened
        .handle()
        .attachment("p".into(), "img".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(image.metadata, metadata);
    assert_eq!(image.bytes, bytes);
    reopened.handle().delete_project("p".into()).await.unwrap();
    assert!(reopened
        .handle()
        .attachment("p".into(), "img".into())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn peer_attachment_copies_are_atomic_retry_safe_and_independent() {
    let dir = tempfile::tempdir().unwrap();
    let store = seed(dir.path()).await;
    let h = store.handle();
    let text = "Useful text from the owner".as_bytes().to_vec();
    h.import_attachment(
        "p".into(),
        "text".into(),
        "note.txt".into(),
        "text/plain".into(),
        text.clone(),
    )
    .await
    .unwrap();
    assert!(h
        .import_attachment(
            "p".into(),
            "bad".into(),
            "bad.txt".into(),
            "text/plain".into(),
            vec![0xff]
        )
        .await
        .is_err());
    assert!(h
        .copy_attachments(
            "p".into(),
            "other".into(),
            vec!["text".into(), "missing".into()]
        )
        .await
        .is_err());
    let conn = rusqlite::Connection::open(store.path()).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM conversation_attachments WHERE project_id='other'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 0,
        "a failed multi-copy leaves no partial destination bytes"
    );
    let copied = h
        .copy_attachments("p".into(), "other".into(), vec!["text".into()])
        .await
        .unwrap();
    let retry = h
        .copy_attachments("p".into(), "other".into(), vec!["text".into()])
        .await
        .unwrap();
    assert_eq!(copied, retry);
    assert_ne!(copied[0].id, "text");
    h.delete_project("p".into()).await.unwrap();
    let destination = h
        .attachment("other".into(), copied[0].id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(destination.bytes, text);
}

#[tokio::test]
async fn peer_hops_reuse_project_lineage_even_after_the_original_is_collected() {
    let dir = tempfile::tempdir().unwrap();
    let store = seed(dir.path()).await;
    let h = store.handle();
    let bytes = b"reusable artifact".to_vec();
    let original = h
        .import_attachment(
            "p".into(),
            "original".into(),
            "note.txt".into(),
            "text/plain".into(),
            bytes.clone(),
        )
        .await
        .unwrap();
    h.retain_attachments("s".into(), vec![original.id.clone()])
        .await
        .unwrap();
    let same_project = h
        .copy_attachments("p".into(), "p".into(), vec![original.id.clone()])
        .await
        .unwrap();
    assert_eq!(same_project, vec![original.clone()]);
    let other = h
        .copy_attachments("p".into(), "other".into(), vec![original.id.clone()])
        .await
        .unwrap()
        .remove(0);
    h.retain_attachments("foreign".into(), vec![other.id.clone()])
        .await
        .unwrap();
    for _ in 0..3 {
        assert_eq!(
            h.copy_attachments("other".into(), "p".into(), vec![other.id.clone()])
                .await
                .unwrap(),
            vec![original.clone()]
        );
        assert_eq!(
            h.copy_attachments("p".into(), "other".into(), vec![original.id.clone()])
                .await
                .unwrap(),
            vec![other.clone()]
        );
    }
    let conn = rusqlite::Connection::open(store.path()).unwrap();
    let count: i64 = conn
        .query_row("SELECT count(*) FROM conversation_attachments", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 2, "round trips keep one byte copy per project");
    h.delete_session(SessionId::new("s")).await.unwrap();
    assert!(h
        .attachment("p".into(), original.id.clone())
        .await
        .unwrap()
        .is_none());
    let returned = h
        .copy_attachments("other".into(), "p".into(), vec![other.id.clone()])
        .await
        .unwrap()
        .remove(0);
    assert_ne!(returned.id, original.id);
    assert_eq!(
        h.copy_attachments("p".into(), "other".into(), vec![returned.id.clone()])
            .await
            .unwrap(),
        vec![other.clone()]
    );
    assert_eq!(
        h.copy_attachments("other".into(), "p".into(), vec![other.id.clone()])
            .await
            .unwrap(),
        vec![returned.clone()]
    );
    assert_eq!(
        h.attachment("p".into(), returned.id.clone())
            .await
            .unwrap()
            .unwrap()
            .bytes,
        bytes
    );
    let stats: (i64, i64) = conn
        .query_row(
            "SELECT count(*),count(DISTINCT lineage_id) FROM conversation_attachments",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        stats,
        (2, 1),
        "collecting the import does not reset lineage"
    );
    assert!(
        h.copy_attachments("p".into(), "other".into(), vec![other.id.clone()])
            .await
            .is_err(),
        "lineage reuse never bypasses source project ownership"
    );
}

#[tokio::test]
async fn request_context_replaces_old_ids_and_refuses_foreign_ids_atomically() {
 let dir=tempfile::tempdir().unwrap(); let store=seed(dir.path()).await; let h=store.handle();
 for (project,id) in [("p","one"),("other","foreign")] {
 h.import_attachment(project.into(),id.into(),"note.txt".into(),"text/plain".into(),b"context".to_vec()).await.unwrap();
 }
 h.set_session_attachment_ids("s".into(),vec!["one".into()]).await.unwrap();
 assert!(h.set_session_attachment_ids("s".into(),vec!["foreign".into()]).await.is_err());
 assert_eq!(h.session_attachment_ids("s".into()).await.unwrap(),["one"]);
 h.set_session_attachment_ids("s".into(),vec![]).await.unwrap();
 assert!(h.session_attachment_ids("s".into()).await.unwrap().is_empty());
 assert!(h.attachment("p".into(),"one".into()).await.unwrap().is_some());
}
