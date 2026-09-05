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
  CaretRightIcon,
  BrainIcon,
  TerminalIcon,
  ArrowDownIcon,
  ChatCircleIcon,
} from "@phosphor-icons/react";
import { Markdown, CopyButton } from "./Markdown";
import { Feed } from "./Feed";
import { workspaceApi, errorMessage, type ChatItem } from "../workspaceApi";
import * as store from "../feedStore";

export function ThreadView({
  sessionId,
  projectId,
  projectName,
  onFile,
}: {
  sessionId: string | null;
  projectId: string | null;
  projectName: string | null;
  onFile: (path: string) => void;
}) {
  const [activity, setActivity] = useState(false);
  // Keyed child owns fetch lifetime, scroll attachment and disclosure state.
  return (
    <section className="conversation">
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
        />
      )}
    </section>
  );
}

function Transcript({
  sessionId,
  onFile,
  onActivity,
}: {
  sessionId: string;
  onFile: (path: string) => void;
  onActivity: () => void;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [following, setFollowing] = useState(true);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const session = state.sessions[sessionId];
  const busy = session?.busy ?? false;
  const scroll = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
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
  }, [sessionId]);
  const results = useMemo(
    () =>
      new Map(
        items
          .filter((i) => i.kind.type === "tool-result")
          .map((i) => [
            i.kind.type === "tool-result" ? i.kind.tool_call_id : "",
            i,
          ]),
      ),
    [items],
  );
  const visible = useMemo(() => {
    const calls = new Set(
      items.filter((i) => i.kind.type === "tool-call").map((i) => i.id),
    );
    return items.filter(
      (i) => i.kind.type !== "tool-result" || !calls.has(i.kind.tool_call_id),
    );
  }, [items]);
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) =>
      visible[index]?.kind.type === "assistant-text" ? 180 : 70,
    getItemKey: (index) => visible[index]!.id,
    overscan: 5,
    useFlushSync: false,
  });
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
        <div className="chat-sizer" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((row) => {
            const item = visible[row.index]!;
            const result = results.get(item.id);
            const open = expanded.has(item.id);
            return (
              <article
                key={item.id}
                ref={virtual.measureElement}
                data-index={row.index}
                className={`chat-item ${item.kind.type}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {item.kind.type === "assistant-text" ? (
                  <>
                    <Markdown text={item.body} onFile={onFile} />
                    <CopyButton text={item.body} />
                  </>
                ) : item.kind.type === "user-text" ? (
                  <div className="user-bubble">{item.body}</div>
                ) : (
                  <div
                    className={`activity-card ${result?.kind.type === "tool-result" && result.kind.is_error ? "failed" : ""}`}
                  >
                    <button
                      className="activity-summary"
                      aria-expanded={open}
                      onClick={() =>
                        setExpanded((old) => {
                          const next = new Set(old);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        })
                      }
                    >
                      <CaretRightIcon className={open ? "rotated" : ""} />
                      {item.kind.type === "thinking" ? (
                        <BrainIcon />
                      ) : (
                        <TerminalIcon />
                      )}
                      <span>
                        {item.kind.type === "thinking"
                          ? "Thought process"
                          : item.kind.type === "tool-call"
                            ? item.kind.name
                            : item.kind.type === "subagent"
                              ? (item.kind.description ?? "Agent task")
                              : "Tool result"}
                      </span>
                      <span className="activity-outcome">
                        {result?.kind.type === "tool-result"
                          ? result.kind.is_error
                            ? "Failed"
                            : "Completed"
                          : item.kind.type === "tool-call"
                            ? "Called"
                            : ""}
                      </span>
                    </button>
                    {open ? (
                      <div className="activity-body">
                        <Markdown text={item.body} onFile={onFile} />
                        {result ? <pre>{result.body}</pre> : null}
                      </div>
                    ) : null}
                    {!open &&
                    result?.kind.type === "tool-result" &&
                    result.kind.is_error ? (
                      <p className="inline-error">
                        {result.body.slice(0, 300)}
                      </p>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}
        </div>
        {busy ? (
          <div className="working-state" role="status">
            <span className="working-dot" />
            Working…{" "}
            <span>Activity appears as the agent completes each step</span>
          </div>
        ) : null}
        {!busy && session?.lastStop ? (
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
