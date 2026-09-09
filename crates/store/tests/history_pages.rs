use brigadier_core::event::{Envelope, Event, InstanceId, ItemId, ItemKind, SessionId};
use brigadier_store::{chat::ChatItem, SessionRow, Store};

#[tokio::test]
async fn latest_backward_and_incremental_pages_preserve_history_and_stream_identity() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let h = store.handle();
    h.upsert_session(SessionRow::new(SessionId::new("s")))
        .await
        .unwrap();
    for seq in 1..=2100 {
        h.chat_item(ChatItem {
            session_id: "s".into(),
            id: format!("i{seq}"),
            seq,
            at: seq as i64,
            kind: ItemKind::AssistantText,
            body: format!("Message {seq}"),
            parent_id: None,
            provider_uuid: None,
        })
        .await
        .unwrap();
    }
    let latest = h
        .conversation_history_page("s".into(), None, None, 60)
        .await
        .unwrap();
    assert_eq!(latest.items.len(), 60);
    assert_eq!(latest.items[0].seq, 2041);
    assert_eq!(latest.next_after, 2100);
    assert!(latest.has_more);
    let older = h
        .conversation_history_page("s".into(), latest.next_before, None, 60)
        .await
        .unwrap();
    assert_eq!(older.items.first().unwrap().seq, 1981);
    assert_eq!(older.items.last().unwrap().seq, 2040);
    let oldest = h
        .conversation_history_page("s".into(), Some(3), None, 100)
        .await
        .unwrap();
    assert_eq!(
        oldest.items.iter().map(|i| i.seq).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert!(!oldest.has_more);
    let event = Envelope {
        seq: 2101,
        at: std::time::SystemTime::now(),
        instance_id: InstanceId::new("test"),
        session_id: SessionId::new("s"),
        event: Event::ContentDelta {
            item_id: ItemId::new("i2100"),
            text: " streamed".into(),
        },
        raw: None,
        body: None,
    };
    h.chat_content_delta(event.clone()).await.unwrap();
    h.chat_content_delta(event).await.unwrap();
    let updates = h
        .conversation_history_page("s".into(), None, Some(2100), 100)
        .await
        .unwrap();
    assert_eq!(updates.items.len(), 1);
    assert_eq!(updates.items[0].id, "i2100");
    assert_eq!(updates.items[0].body, "Message 2100 streamed");
    store.close().await.unwrap();
    let reopened = Store::open(dir.path()).unwrap();
    assert_eq!(
        reopened
            .handle()
            .conversation_history_page("s".into(), Some(3), None, 10)
            .await
            .unwrap()
            .items
            .len(),
        2
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn historical_turn_ranges_keep_old_boundaries_and_bound_response_size() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store
        .handle()
        .upsert_session(SessionRow::new(SessionId::new("history")))
        .await
        .unwrap();
    assert!(store
        .handle()
        .session(SessionId::new("history"))
        .await
        .unwrap()
        .is_some());
    {
        let mut conn = rusqlite::Connection::open(store.path()).unwrap();
        let transaction = conn.transaction().unwrap();
        for turn in 1..=2100 {
            transaction.execute("INSERT INTO chat_turns(session_id,id,start_seq,end_seq,started_at,ended_at,status) VALUES ('history',?1,?2,?3,?2,?3,'completed')", (format!("turn-{turn}"), turn * 10, turn * 10 + 9)).unwrap();
        }
        transaction.execute("INSERT INTO chat_turns(session_id,id,start_seq,started_at,status) VALUES ('history','running',21010,21010,'running')", []).unwrap();
        transaction.commit().unwrap();
    }
    let handle = store.handle();
    assert_eq!(
        handle.chat_turns("history".into()).await.unwrap().len(),
        2000
    );
    let old = handle
        .chat_turns_in_range("history".into(), 15, 20)
        .await
        .unwrap();
    assert_eq!(
        old.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["turn-2", "turn-1"]
    );
    assert_eq!(old[1].end_seq, Some(19));
    let bounded = handle
        .chat_turns_in_range("history".into(), 0, u64::MAX)
        .await
        .unwrap();
    assert_eq!(bounded.len(), 600);
    assert_eq!(bounded[0].id, "running");
    let running = handle
        .chat_turns_in_range("history".into(), 21015, 21020)
        .await
        .unwrap();
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].end_seq, None);
    assert!(handle
        .chat_turns_in_range("other".into(), 0, u64::MAX)
        .await
        .unwrap()
        .is_empty());
    store.close().await.unwrap();
    let reopened = Store::open(dir.path()).unwrap();
    assert_eq!(
        reopened
            .handle()
            .chat_turns_in_range("history".into(), 15, 15)
            .await
            .unwrap()[0]
            .id,
        "turn-1"
    );
    reopened.close().await.unwrap();
}
