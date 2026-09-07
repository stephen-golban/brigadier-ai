import type { PeerData } from "../peerApi";
import { useSessionChanges } from "../desktopApi";
import { ChangedFilesCard } from "./SessionReview";
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
import { workspaceApi, errorMessage, type ChatItem } from "../workspaceApi";
import * as store from "../feedStore";
import { projectThread } from "../threadProjection";
import { WorkTrace } from "./WorkTrace";
import { BrandMark } from "./BrandMark";
import { workbenchApi } from "../workbenchApi";

export function ThreadView({
  sessionId,
  projectName,
  onFile,
  onEdit,
  editing = false,
  revision = 0,
  peers,
  onSelectSession,
}: {
  sessionId: string | null;
  projectId: string | null;
  projectName: string | null;
  onFile: (path: string) => void;
  onEdit?: (item: ChatItem) => void;
  editing?: boolean;
  revision?: number;
  peers?: PeerData;
  onSelectSession?: (id: string) => void;
}) {
  const [greetingName,setGreetingName]=useState("");
  useEffect(()=>{
    let live=true;
    const read=()=>{void workbenchApi.load().then(d=>{if(live)setGreetingName(d.displayName?.trim()??"");}).catch(()=>{});};
    read();window.addEventListener("workbench-data-changed",read);
    return()=>{live=false;window.removeEventListener("workbench-data-changed",read);};
  },[]);
  return (
    <section className="conversation">
      {sessionId ? (
        <Transcript
          key={sessionId}
          sessionId={sessionId}
          onFile={onFile}
          revision={revision}
          onEdit={onEdit}
          editing={editing}
          peers={peers}
          onSelectSession={onSelectSession}
        />
      ) : (
        <div className="new-conversation">
          <BrandMark />
          <h1>
            {projectName
              ? `What should we build in ${projectName}?`
              : greetingName ? `What will you build, ${greetingName}?` : "What should we build?"}
          </h1>
        </div>
      )}
    </section>
  );
}

function Transcript({
  sessionId,
  onFile,
  peers,
  onSelectSession,
  revision,
  onEdit,
  editing,
}: {
  sessionId: string;
  onFile: (path: string) => void;
  peers?: PeerData;
  onSelectSession?: (id: string) => void;
  revision: number;
  onEdit?: (item: ChatItem) => void;
  editing: boolean;
}) {
  const changes = useSessionChanges(sessionId);
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
          </div>
        ) : null}
        <div className="chat-sizer" style={{ height: totalSize }}>
          {virtual.getVirtualItems().map((row) => {
            const entry = visible[row.index]!;
            const user = visible
              .slice(0, row.index + 1)
              .reverse()
              .find(
                (r) => r.type === "message" && r.item.kind.type === "user-text",
              );
            const turn =
              user?.type === "message"
                ? (user.item.provider_uuid ?? user.item.id)
                : null;
            const files =
              changes.turns.find((t) => t.turnId === turn)?.files ?? [];
            const previousUser = visible
              .slice(0, row.index)
              .reverse()
              .find(
                (r) => r.type === "message" && r.item.kind.type === "user-text",
              );
            const separator =
              entry.type === "message" &&
              entry.item.kind.type === "user-text" &&
              entry.item.at > 0 &&
              (!previousUser ||
                (previousUser.type === "message" &&
                  entry.item.at - previousUser.item.at > 15 * 60 * 1000));
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
                    {separator && (
                      <div className="message-separator">
                        {dateLabel(entry.item.at)}
                      </div>
                    )}
                    <UserMessage
                      item={entry.item}
                      peers={peers}
                      initial={row.index === 0}
                      busy={busy}
                      editing={editing}
                      onEdit={onEdit}
                      onSelectSession={onSelectSession}
                    />
                  </>
                ) : (
                  <>
                    <Markdown text={entry.item.body} onFile={onFile} />
                    <div className="assistant-actions">
                      <CopyButton text={entry.item.body} />
                    </div>
                    {turn && (
                      <ChangedFilesCard
                        sessionId={sessionId}
                        turn={turn}
                        files={files}
                      />
                    )}
                  </>
                )}
              </article>
            );
          })}
        </div>
        {peers?.messages
          .filter((m) => m.to === sessionId && !m.work)
          .map((message) => (
            <details className="peer-inline-message" key={message.id}>
              <summary>
                Message from {peers.titles[message.from] ?? "another session"}
              </summary>
              <button
                className="message-provenance"
                onClick={() => onSelectSession?.(message.from)}
              >
                Open source session
              </button>
              <Markdown text={message.text} onFile={onFile} />
              <CopyButton text={message.text} />
              {message.error && <p className="inline-error">{message.error}</p>}
            </details>
          ))}
        {peers?.requests
          .filter((r) => r.to === sessionId && r.resolved)
          .map((request) => (
            <details className="peer-inline-message" key={request.id}>
              <summary>
                Resolved {request.action} request from{" "}
                {peers.titles[request.from] ?? "another session"}
              </summary>
              <p>This request was handled.</p>
            </details>
          ))}
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
        <button
          className="jump-latest"
          aria-label="Jump to latest"
          onClick={follow}
        >
          <ArrowDownIcon size={19} />
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

function dateLabel(at: number) {
  const date = new Date(at);
  return `${date.toDateString() === new Date().toDateString() ? "Today" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
function UserMessage({
  item,
  peers,
  initial,
  busy,
  editing,
  onEdit,
  onSelectSession,
}: {
  item: ChatItem;
  peers?: PeerData;
  initial: boolean;
  busy: boolean;
  editing: boolean;
  onEdit?: (item: ChatItem) => void;
  onSelectSession?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const match = item.body.match(
    /^Work request from peer session ([^:\n]+):\n([\s\S]*)$/,
  );
  const source =
    match?.[1] ?? (initial ? peers?.origins[item.session_id] : undefined);
  let text = item.body.split("\n\nBrigadier exposes native MCP tools:")[0]!;
  if (match) {
    try {
      text = JSON.parse(match[2]!);
    } catch {
      text = match[2]!;
    }
  }
  const long =
    text.length > (source ? 200 : 480) || text.split("\n").length > 8;
  return (
    <div className={`user-message ${source ? "peer-message" : ""}`}>
      {source && (
        <button
          className="message-provenance"
          onClick={() => onSelectSession?.(source)}
        >
          Sent by {peers?.titles[source] ?? "Brigadier"} from another session
        </button>
      )}
      <div className="user-bubble">
        <div className={long && !expanded ? "message-collapsed" : ""}>
          {text}
        </div>
        {long && (
          <button
            className="show-more"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Show more"}
            <span aria-hidden="true">⌄</span>
          </button>
        )}
      </div>
      <div className="message-actions">
        {item.at > 0 && (
          <time dateTime={new Date(item.at).toISOString()}>
            {new Date(item.at).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        )}
        <CopyButton text={text} />
        {!source && (
          <button
            className="icon-button"
            aria-label="Edit message"
            title={
              busy ? "Wait for the current turn to finish" : "Edit message"
            }
            disabled={busy || editing || !onEdit}
            onClick={() => onEdit?.(item)}
          >
            <PencilSimpleIcon size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
