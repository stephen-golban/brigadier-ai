import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownIcon,
  ChatCircleIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { Markdown, CopyButton } from "./Markdown";
import { Feed } from "./Feed";
import { workspaceApi, errorMessage, type ChatItem } from "../workspaceApi";
import * as store from "../feedStore";
import { projectThread } from "../threadProjection";
import { SessionContext } from "./SessionContext";
import { RewindHistory } from "./RewindHistory";
import { WorkTrace } from "./WorkTrace";

export function ThreadView({
  sessionId,
  projectId,
  projectName,
  onFile,
  onEdit,
  editing = false,
  revision = 0,
}: {
  sessionId: string | null;
  projectId: string | null;
  projectName: string | null;
  onFile: (path: string) => void;
  onEdit?: (item: ChatItem) => void;
  editing?: boolean;
  revision?: number;
}) {
  const [activity, setActivity] = useState(false);
  const [history, setHistory] = useState(false);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const current = sessionId ? state.sessions[sessionId] : undefined;
  // Keyed child owns fetch lifetime, scroll attachment and disclosure state.
  return (
    <section className="conversation">
      {history && sessionId && (
        <RewindHistory
          key={sessionId}
          sessionId={sessionId}
          onClose={() => setHistory(false)}
        />
      )}
      <div className="conversation-toolbar">
        <div role="group" aria-label="Thread view">
          <button
            aria-pressed={!activity && sessionId !== null}
            disabled={!sessionId}
            onClick={() => setActivity(false)}
          >
            Conversation
          </button>
          <button
            aria-pressed={activity || sessionId === null}
            onClick={() => setActivity(true)}
          >
            Activity
          </button>
        </div>
        {sessionId && (
          <button className="history-trigger" onClick={() => setHistory(true)}>
            Saved history
          </button>
        )}
        {sessionId && (
          <SessionContext
            key={sessionId}
            sessionId={sessionId}
            revision={revision + (current?.lastEventSeq ?? 0)}
            busy={current?.busy ?? false}
          />
        )}
      </div>
      {activity || sessionId === null ? (
        <Feed
          sessionId={sessionId}
          projectId={projectId}
          projectName={projectName}
        />
      ) : (
        <Transcript
          key={sessionId}
          sessionId={sessionId}
          onFile={onFile}
          onActivity={() => setActivity(true)}
          revision={revision}
          onEdit={onEdit}
          editing={editing}
        />
      )}
    </section>
  );
}

function Transcript({
  sessionId,
  onFile,
  onActivity,
  revision,
  onEdit,
  editing,
}: {
  sessionId: string;
  onFile: (path: string) => void;
  onActivity: () => void;
  revision: number;
  onEdit?: (item: ChatItem) => void;
  editing: boolean;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const savedScroll = useRef<{ top: number; following: boolean }>(
    (() => {
      try {
        return (
          JSON.parse(
            localStorage.getItem(`brigadier:scroll:${sessionId}`) ?? "null",
          ) ?? { top: 0, following: true }
        );
      } catch {
        return { top: 0, following: true };
      }
    })(),
  );
  const [following, setFollowing] = useState(savedScroll.current.following);
  const [hydrated, setHydrated] = useState(false);
  const restored = useRef(false);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const session = state.sessions[sessionId];
  const busy = session?.busy ?? false;
  const scroll = useRef<HTMLDivElement>(null);
  const atEnd = useRef(savedScroll.current.following);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(
        JSON.parse(
          localStorage.getItem(`brigadier:expanded:${sessionId}`) ?? "[]",
        ),
      );
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    localStorage.setItem(
      `brigadier:expanded:${sessionId}`,
      JSON.stringify([...expanded]),
    );
  }, [expanded, sessionId]);
  useEffect(() => {
    setItems([]);
    setLoaded(false);
    let cancelled = false,
      cursor = 0,
      timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const page = await workspaceApi.chat(sessionId, cursor);
        if (cancelled) return;
        if (page.length) {
          cursor = Math.max(cursor, ...page.map((i) => i.seq));
          setItems((previous) => {
            const merged = new Map(previous.map((i) => [i.id, i]));
            page.forEach((i) => merged.set(i.id, i));
            return [...merged.values()]
              .sort((a, b) => a.seq - b.seq)
              .slice(-2000);
          });
        }
        setLoaded(true);
        setError(null);
        if (page.length < 20) setHydrated(true);
        timer = setTimeout(() => void read(), page.length === 20 ? 0 : 700);
      } catch (e) {
        if (!cancelled) {
          setError(errorMessage(e));
          setLoaded(true);
          timer = setTimeout(() => void read(), 2500);
        }
      }
    };
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, revision]);
  const visible = useMemo(() => projectThread(items, busy), [items, busy]);
  const toggle = (id: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => (visible[index]?.type === "message" ? 180 : 40),
    getItemKey: (index) => visible[index]!.id,
    overscan: 5,
    useFlushSync: false,
  });
  const totalSize = virtual.getTotalSize();
  useLayoutEffect(() => {
    const el = scroll.current;
    // Collapsing activity can make the whole transcript fit without firing a scroll event.
    if (el && el.scrollHeight - el.clientHeight < 64) {
      atEnd.current = true;
      setFollowing(true);
    }
  }, [totalSize, expanded]);
  useLayoutEffect(() => {
    if (hydrated && !restored.current && scroll.current) {
      restored.current = true;
      if (!savedScroll.current.following)
        scroll.current.scrollTop = savedScroll.current.top;
    }
  }, [hydrated]);
  useLayoutEffect(() => {
    if (atEnd.current && visible.length)
      virtual.scrollToIndex(visible.length - 1, { align: "end" });
  }, [visible, virtual]);
  const follow = () => {
    atEnd.current = true;
    setFollowing(true);
    virtual.scrollToIndex(Math.max(0, visible.length - 1), { align: "end" });
  };
  return (
    <div className="transcript-wrap">
      <div
        className="transcript"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (!el) return;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          setFollowing(atEnd.current);
          if (restored.current)
            try {
              localStorage.setItem(
                `brigadier:scroll:${sessionId}`,
                JSON.stringify({ top: el.scrollTop, following: atEnd.current }),
              );
            } catch {
              /* In-memory scroll remains available. */
            }
        }}
      >
        {error ? (
          <p role="alert" className="inline-error">
            {error}
          </p>
        ) : null}
        {!loaded ? (
          <p className="thread-empty">Loading conversation…</p>
        ) : visible.length === 0 ? (
          <div className="thread-empty">
            <ChatCircleIcon size={28} />
            <p>
              {busy
                ? "Waiting for the first response…"
                : "No saved message bodies in this session."}
            </p>
            <button className="act" onClick={onActivity}>
              View activity history
            </button>
          </div>
        ) : null}
        <div className="chat-sizer" style={{ height: totalSize }}>
          {virtual.getVirtualItems().map((row) => {
            const entry = visible[row.index]!;
            return (
              <article
                key={entry.id}
                ref={virtual.measureElement}
                data-index={row.index}
                className={`chat-item ${entry.type === "work" ? "work-row" : entry.item.kind.type}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {entry.type === "work" ? (
                  <WorkTrace
                    row={entry}
                    expanded={expanded}
                    toggle={toggle}
                    onFile={onFile}
                  />
                ) : entry.item.kind.type === "user-text" ? (
                  <>
                    <div className="user-bubble">{entry.item.body}</div>
                    <div className="message-actions">
                      <CopyButton text={entry.item.body} />
                      <button
                        className="icon-button"
                        aria-label="Edit message"
                        title={
                          busy
                            ? "Wait for the current turn to finish"
                            : "Edit message"
                        }
                        disabled={busy || editing || !onEdit}
                        onClick={() => onEdit?.(entry.item)}
                      >
                        <PencilSimpleIcon size={15} />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <Markdown text={entry.item.body} onFile={onFile} />
                    <CopyButton text={entry.item.body} />
                  </>
                )}
              </article>
            );
          })}
        </div>
        {busy && !visible.some((row) => row.type === "work" && row.running) ? (
          <div className="working-state" role="status">
            <span className="working-dot" />
            Working…
          </div>
        ) : null}
        {!busy && session?.lastStop && session.lastStop !== "end-turn" ? (
          <div className="turn-state">{stopLabel(session.lastStop)}</div>
        ) : null}
      </div>
      {!following ? (
        <button className="jump-latest" onClick={follow}>
          <ArrowDownIcon size={14} />
          Latest
        </button>
      ) : null}
    </div>
  );
}

function stopLabel(reason: string) {
  if (reason === "end-turn") return "Completed";
  if (reason === "max-tokens") return "Response limit reached";
  if (reason === "max-turns") return "Turn limit reached";
  if (reason === "refusal") return "The agent could not fulfill this request";
  try {
    const value = JSON.parse(reason) as { error?: string; other?: string };
    return value.error ?? value.other ?? reason;
  } catch {
    return reason;
  }
}
