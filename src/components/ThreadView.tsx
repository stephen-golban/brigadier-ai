import { Telescope as TelescopeIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Surface, Spinner } from "./controls/status";
import { Disclosure } from "./controls/disclosure";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  PencilSimpleIcon,
  HammerIcon,
  ArrowsClockwiseIcon,
  BugIcon,
} from "@phosphor-icons/react";
import { Button } from "./controls/button";
import { MessageAction } from "./assistant-ui/elements/tooltip-icon-button";
import { Thread } from "./assistant-ui/elements/thread";
import { Markdown, CopyButton } from "./Markdown";
import { BrandMark } from "./BrandMark";
import { WorkTrace } from "./WorkTrace";
import { ChangedFilesCard } from "./SessionReview";
import { useSessionChanges } from "../desktopApi";
import { workspaceApi, errorMessage, type ChatItem } from "../workspaceApi";
import { workbenchApi } from "../workbenchApi";
import { bridge } from "../bridge";
import * as store from "../feedStore";
import { projectThread, type ThreadRow } from "../threadProjection";
import type { PeerData } from "../peerApi";
export function ThreadView({
  requests,
  sessionId,
  projectName,
  projectId,
  onFile,
  onEdit,
  editing = false,
  revision = 0,
  peers,
  onSelectSession,
}: {
  requests?: ReactNode;
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
  const [greetingName, setGreetingName] = useState("");
  useEffect(() => {
    let live = true;
    const read = () => {
      void workbenchApi
        .load()
        .then((d) => {
          if (live) setGreetingName(d.displayName?.trim() ?? "");
        })
        .catch(() => {});
    };
    read();
    window.addEventListener("workbench-data-changed", read);
    return () => {
      live = false;
      window.removeEventListener("workbench-data-changed", read);
    };
  }, []);
  return (
    <section className="conversation flex min-h-0 min-w-0 flex-1 flex-col">
      {sessionId ? (
        <Transcript
          requests={requests}
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
        <div className="new-conversation flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-text-secondary">
          <BrandMark />
          <h1>
            {projectName
              ? `What should we build in ${projectName}?`
              : greetingName
                ? `What will you build, ${greetingName}?`
                : "What should we build?"}
          </h1>
          {projectId && (
            <div className="welcome-starters">
              {[
                {
                  title: "Explore and understand code",
                  prompt:
                    "Explore this project and explain its architecture and main flows.",
                  Icon: TelescopeIcon,
                  color: "#5795ed",
                },
                {
                  title: "Build a new feature, app, or tool",
                  prompt: "Help me build a new feature: ",
                  Icon: HammerIcon,
                  color: "#a77ddd",
                },
                {
                  title: "Review code and suggest changes",
                  prompt:
                    "Review the current changes and suggest improvements. Focus on bugs and regressions.",
                  Icon: ArrowsClockwiseIcon,
                  color: "#62a781",
                },
                {
                  title: "Fix issues and failures",
                  prompt: "Help me investigate and fix this issue: ",
                  Icon: BugIcon,
                  color: "#d88a55",
                },
              ].map(({ title, prompt, Icon, color }) => (
                <Button
                  key={title}
                  className="welcome-starter"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("workbench-starter", {
                        detail: { projectId, prompt },
                      }),
                    )
                  }
                >
                  <Icon size={18} style={{ color }} />
                  <span>{title}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Transcript({
  requests,
  sessionId,
  onFile,
  peers,
  onSelectSession,
  revision,
  onEdit,
  editing,
}: {
  requests?: ReactNode;
  sessionId: string;
  onFile: (path: string) => void;
  peers?: PeerData;
  onSelectSession?: (id: string) => void;
  revision: number;
  onEdit?: (item: ChatItem) => void;
  editing: boolean;
}) {
  const changes = useSessionChanges(sessionId);
  const [items, setItems] = useState<ChatItem[]>([]),
    [error, setError] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false),
    [hydrated, setHydrated] = useState(false);
  const state = useSyncExternalStore(store.subscribe, store.getState),
    session = state.sessions[sessionId],
    busy = session?.busy ?? false;
  const scroll = useRef<HTMLDivElement>(null),
    restored = useRef(false);
  const saved = useRef<{ top: number; following: boolean }>(
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
    try {
      localStorage.setItem(
        `brigadier:expanded:${sessionId}`,
        JSON.stringify([...expanded]),
      );
    } catch {
      /* Keep in-memory state. */
    }
  }, [expanded, sessionId]);
  useEffect(() => {
    setItems([]);
    setLoaded(false);
    setHydrated(false);
    restored.current = false;
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
  const rows = useMemo(() => projectThread(items, busy), [items, busy]);
  const messages = useMemo<ThreadMessageLike[]>(() => {
    let turn: string | null = null;
    return rows.map((row, index) => {
      if (row.type === "message" && row.item.kind.type === "user-text")
        turn = row.item.provider_uuid ?? row.item.id;
      return {
        id: row.id,
        role:
          row.type === "message" && row.item.kind.type === "user-text"
            ? "user"
            : "assistant",
        content: [
          {
            type: "text",
            text:
              row.type === "message"
                ? row.item.body
                : row.running
                  ? "Working…"
                  : "Activity",
          },
        ],
        metadata: { custom: { brigadier: row, index, turn } },
      };
    });
  }, [rows]);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    isRunning: busy,
    isLoading: !loaded,
    onNew: async (message) => {
      const text = message.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      await bridge().sendTurn(sessionId, text);
    },
    onCancel: async () => {
      await bridge().interrupt(sessionId);
    },
  });
  useLayoutEffect(() => {
    if (hydrated && !restored.current && scroll.current) {
      restored.current = true;
      if (!saved.current.following)
        scroll.current.scrollTop = saved.current.top;
    }
  }, [hydrated]);
  const toggle = (id: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        viewportRef={scroll}
        scrollToBottomOnInitialize={saved.current.following}
        onScroll={() => {
          const el = scroll.current;
          if (!el || !restored.current) return;
          try {
            localStorage.setItem(
              `brigadier:scroll:${sessionId}`,
              JSON.stringify({
                top: el.scrollTop,
                following:
                  el.scrollHeight - el.scrollTop - el.clientHeight < 64,
              }),
            );
          } catch {
            /* Scroll still works without storage. */
          }
        }}
      >
        {error && (
          <p role="alert" className="inline-error my-2 text-[13px] text-error">
            {error}
          </p>
        )}
        {!loaded ? (
          <div className="thread-empty mx-auto flex max-w-lg flex-col gap-3 p-6 text-text-disabled">
            <Spinner size="sm" /> Loading conversation…
          </div>
        ) : !rows.length ? (
          <p className="thread-empty mx-auto flex max-w-lg flex-col gap-3 p-6 text-text-disabled">
            {busy
              ? "Waiting for the first response…"
              : "No saved message bodies in this session."}
          </p>
        ) : null}
        <ThreadPrimitive.Messages>
          {({ message }) => {
            const row = message.metadata.custom.brigadier as ThreadRow;
            const index = message.metadata.custom.index as number;
            const turn = message.metadata.custom.turn as string | null;
            return (
              <MessagePrimitive.Root
                className={`aui-message mb-6 ${row.type === "work" ? "aui-activity" : row.item.kind.type}`}
              >
                {row.type === "work" ? (
                  <WorkTrace
                    row={row}
                    expanded={expanded}
                    toggle={toggle}
                    onFile={onFile}
                  />
                ) : row.item.kind.type === "user-text" ? (
                  <>
                    {row.item.at > 0 && (
                      <div className="message-separator mb-2 text-xs text-text-tertiary">
                        {dateLabel(row.item.at)}
                      </div>
                    )}
                    <UserMessage
                      item={row.item}
                      peers={peers}
                      initial={index === 0}
                      busy={busy}
                      editing={editing}
                      onEdit={onEdit}
                      onSelectSession={onSelectSession}
                    />
                  </>
                ) : (
                  <>
                    <Markdown text={row.item.body} onFile={onFile} />
                    <div className="aui-message-actions mt-2 flex items-center gap-1">
                      <CopyButton text={row.item.body} />
                    </div>
                    {turn && (
                      <ChangedFilesCard
                        sessionId={sessionId}
                        turn={turn}
                        files={
                          changes.turns.find((t) => t.turnId === turn)?.files ??
                          []
                        }
                      />
                    )}
                  </>
                )}
              </MessagePrimitive.Root>
            );
          }}
        </ThreadPrimitive.Messages>
        {peers?.messages
          .filter((m) => m.to === sessionId && !m.work)
          .map((m) => (
            <Disclosure key={m.id}>
              <Disclosure.Heading>
                <Disclosure.Trigger>
                  Message from {peers.titles[m.from] ?? "another session"}
                  <Disclosure.Indicator />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content>
                <Disclosure.Body>
                  <Button onClick={() => onSelectSession?.(m.from)}>
                    Open source session
                  </Button>
                  <Markdown text={m.text} onFile={onFile} />
                  <CopyButton text={m.text} />
                  {m.error && (
                    <p className="inline-error my-2 text-[13px] text-error">
                      {m.error}
                    </p>
                  )}
                </Disclosure.Body>
              </Disclosure.Content>
            </Disclosure>
          ))}
        {peers?.requests
          .filter((r) => r.to === sessionId && r.resolved)
          .map((r) => (
            <Disclosure key={r.id}>
              <Disclosure.Heading>
                <Disclosure.Trigger>
                  Resolved {r.action} request from{" "}
                  {peers.titles[r.from] ?? "another session"}
                  <Disclosure.Indicator />
                </Disclosure.Trigger>
              </Disclosure.Heading>
              <Disclosure.Content>
                <Disclosure.Body>This request was handled.</Disclosure.Body>
              </Disclosure.Content>
            </Disclosure>
          ))}
        {busy && !rows.some((r) => r.type === "work" && r.running) && (
          <div
            className="flex items-center gap-2 text-text-secondary"
            role="status"
          >
            <Spinner size="sm" />
            Working…
          </div>
        )}
        {!busy && session?.lastStop && session.lastStop !== "end-turn" && (
          <div className="turn-state">{stopLabel(session.lastStop)}</div>
        )}
        {requests}
      </Thread>
    </AssistantRuntimeProvider>
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
    <div className="flex min-w-0 flex-col items-end gap-1">
      {source && (
        <Button
          className="message-provenance"
          onClick={() => onSelectSession?.(source)}
        >
          Sent by {peers?.titles[source] ?? "Brigadier"} from another session
        </Button>
      )}
      <Surface className="max-w-[85%] rounded-lg px-4 py-3 whitespace-pre-wrap sm:max-w-[75%]">
        <div
          className={
            long && !expanded ? (source ? "line-clamp-2" : "line-clamp-5") : ""
          }
        >
          {text}
        </div>
        {long && (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 pt-2 text-text-secondary"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Show more"}
            <span aria-hidden="true">⌄</span>
          </Button>
        )}
      </Surface>
      <div className="gap-1 text-xs">
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
          <MessageAction
            tooltip={
              busy ? "Wait for the current turn to finish" : "Edit message"
            }
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Edit message"
              title={
                busy ? "Wait for the current turn to finish" : "Edit message"
              }
              disabled={busy || editing || !onEdit}
              onClick={() => onEdit?.(item)}
            >
              <PencilSimpleIcon size={15} />
            </Button>
          </MessageAction>
        )}
      </div>
    </div>
  );
}
