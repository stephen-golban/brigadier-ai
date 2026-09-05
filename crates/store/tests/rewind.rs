use brigadier_core::event::{ItemKind, SessionId};
use brigadier_store::chat::ChatItem;
use brigadier_store::{SessionRow, Store};
fn item(id: &str, seq: u64) -> ChatItem {
    ChatItem {
        session_id: "s".into(),
        id: id.into(),
        seq,
        at: 0,
        kind: ItemKind::UserText,
        body: format!("text {id}"),
        parent_id: None,
        provider_uuid: Some(id.into()),
    }
}
#[tokio::test]
async fn rewind_is_durable_retains_refused_history_and_suppresses_late_discarded_rows() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let handle = store.handle();
    handle.upsert_session(SessionRow::new(SessionId::new("s"))).await.unwrap();
    for (id, seq) in [("a", 1), ("b", 2), ("c", 3)] {
        handle.chat_item(item(id, seq)).await.unwrap();
    }
    handle.prepare_rewind("refused".into(), "s".into(), "b".into()).await.unwrap();
    assert!(handle.rewind_pending("s".into()).await.unwrap());
    assert_eq!(handle.chat_items("s".into(), 0).await.unwrap().len(), 3);
    handle.finish_rewind("refused".into(), None).await.unwrap();
    assert!(!handle.rewind_pending("s".into()).await.unwrap());
    assert_eq!(handle.chat_items("s".into(), 0).await.unwrap().len(), 3);
    handle.prepare_rewind("applied".into(), "s".into(), "b".into()).await.unwrap();
    assert!(handle.prepare_rewind("racing".into(), "s".into(), "b".into()).await.is_err());
    handle.finish_rewind("applied".into(), Some(4)).await.unwrap();
    handle.chat_item(item("late", 4)).await.unwrap();
    handle.chat_item(item("edited", 5)).await.unwrap();
    let ids = handle
        .chat_items("s".into(), 0)
        .await
        .unwrap()
        .into_iter()
        .map(|i| i.id)
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["a", "edited"]);
    handle.flush().await.unwrap();
    let db = rusqlite::Connection::open(dir.path().join("brigadier.sqlite")).unwrap();
    let archived: i64 = db
        .query_row("SELECT count(*) FROM chat_archive WHERE rewind_id='applied'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(archived, 3);
}
