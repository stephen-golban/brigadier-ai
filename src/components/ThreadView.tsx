import { TaskProgress } from "./TaskProgress";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useConversationHistory } from "../hooks/useConversationHistory";
import { Telescope as TelescopeIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Spinner } from "./controls/status";
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
import {
  ChatPanelAssistantMessage,
  ChatPanelUserMessage,
} from "./assistant-ui/elements/chat-panel";
import { ThinkingIndicator } from "./assistant-ui/elements/thinking-indicator";
import "./assistant-ui/elements/elements.css";
import { Markdown, CopyButton } from "./Markdown";
import { BrandMark } from "./BrandMark";
import { WorkTrace } from "./WorkTrace";
import { ChangedFilesCard } from "./SessionReview";
import { useSessionChanges } from "../desktopApi";
import {
  type ChatItem,
} from "../workspaceApi";
import { workbenchApi } from "../workbenchApi";
import { bridge } from "../bridge";
import * as store from "../feedStore";
import { projectThread } from "../threadProjection";
import { PeerTaskCardScope } from "./peer/PeerTaskCardScope";
import { PeerIncomingMessage, PeerMessages } from "./peer/PeerMessages";
import { PeerAttachmentPreviews } from "./peer/PeerAttachmentPreviews";
import { peerMessageContent } from "../peerPresentation";
import { peerApi, type PeerAttachment, type PeerData } from "../peerApi";
import {AttachmentPreview} from "./composer/AttachmentPreview";
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
          projectId={projectId}
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
  projectId,
  onFile,
  peers,
  onSelectSession,
  revision,
  onEdit,
  editing,
}: {
  requests?: ReactNode;
  sessionId: string;
  projectId: string | null;
  onFile: (path: string) => void;
  peers?: PeerData;
  onSelectSession?: (id: string) => void;
  revision: number;
  onEdit?: (item: ChatItem) => void;
  editing: boolean;
}) {
  const changes = useSessionChanges(sessionId);
  const {items, turns: turnRecords, loaded, error, hasOlder, paging, historical, older, latest} = useConversationHistory(sessionId, revision);
  const hydrated = loaded;
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
  const rows = useMemo(
    () => projectThread(items, busy, turnRecords, session?.lastStop),
    [items, busy, turnRecords, session?.lastStop],
  );
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current,
    estimateSize: () => 140, overscan: 6, getItemKey: index => rows[index]!.id,
    enabled: rows.length > 60, initialRect: {width: 800, height: 800} });
  const visibleRows = rows.length > 60 ? virtual.getVirtualItems().map(item => ({row: rows[item.index]!, index: item.index, virtual: item})) : rows.map((row,index)=>({row,index,virtual: null}));
  // The runtime owns only viewport behavior. Render saved rows directly with the
  // standalone Elements, so its synthetic startup message cannot enter our renderer.
  const messages = useMemo<ThreadMessageLike[]>(
    () =>
      rows.map((row) => ({
        id: row.id,
        role:
          row.type === "message" && row.item.kind.type === "user-text"
            ? "user"
            : "assistant",
        content:
          row.type === "message" ? [{ type: "text", text: row.item.body }] : [],
      })),
    [rows],
  );
  const turns = useMemo(() => {
    let turn: string | null = null;
    return rows.map((row) => {
      if (row.type === "message" && row.item.kind.type === "user-text")
        turn = row.item.provider_uuid ?? row.item.id;
      return turn;
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
      <PeerTaskCardScope rows={rows} sessionTitles={peers?.titles} sessionId={sessionId} peers={peers}>
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
        <TaskProgress sessionId={sessionId} />
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
        {hasOlder && <Button className="mx-auto mb-4" disabled={paging} onClick={() => void older()}>{paging ? 'Loading…' : 'Load earlier messages'}</Button>}
        {historical && <Button className="mx-auto mb-4" onClick={() => void latest()}>Return to latest messages</Button>}
        <div style={rows.length > 60 ? {height: virtual.getTotalSize(), position: 'relative'} : undefined}>
        {visibleRows.map(({row, index, virtual: position}) => {
          const turn = turns[index];
          return (
            <div
              key={row.id}
              data-message-id={row.id}
              data-index={index}
              ref={position ? virtual.measureElement : undefined}
              style={position ? {position: 'absolute', width: '100%', top: 0, left: 0, transform: `translateY(${position.start}px)`} : undefined}
              className={`aui-message group/message ${row.type === "work" ? "aui-activity" : row.item.kind.type}`}
            >
              {row.type === "work" ? (
                <WorkTrace
                  row={row}
                  sessionTitles={peers?.titles}
                  onSelectSession={onSelectSession}
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
                    projectId={projectId ?? session?.projectId ?? null}
                    onFile={onFile}
                    peers={peers}
                    initial={index === 0}
                    busy={busy}
                    editing={editing}
                    onEdit={onEdit}
                    onSelectSession={onSelectSession}
                  />
                </>
              ) : (
                <ChatPanelAssistantMessage className="w-full max-w-none text-sm text-text leading-relaxed">
                  <Markdown text={row.item.body} onFile={onFile} />
                  <div className="aui-message-actions flex items-center gap-1">
                    <CopyButton text={row.item.body} />
                  </div>
                  {row.final && turn && (
                    <ChangedFilesCard
                      sessionId={sessionId}
                      turn={turn}
                      files={
                        changes.turns.find((t) => t.turnId === turn)?.files ??
                        []
                      }
                    />
                  )}
                </ChatPanelAssistantMessage>
              )}
            </div>
          );
        })}
        </div>
        <PeerMessages sessionId={sessionId} peers={peers} onSelectSession={onSelectSession}
          renderAttachments={message => <PeerAttachmentPreviews message={message} />} />
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
          <ThinkingIndicator label="Working…" role="status" className="py-2" />
        )}
        {!busy && session?.lastStop && session.lastStop !== "end-turn" && (
          <div className="turn-state">{stopLabel(session.lastStop)}</div>
        )}
        {requests}
      </Thread>
      </PeerTaskCardScope>
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
  projectId,
  onFile,
  peers,
  initial,
  busy,
  editing,
  onEdit,
  onSelectSession,
}: {
  item: ChatItem;
  projectId: string | null;
  onFile: (path: string) => void;
  peers?: PeerData;
  initial: boolean;
  busy: boolean;
  editing: boolean;
  onEdit?: (item: ChatItem) => void;
  onSelectSession?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [attachment, setAttachment] = useState<PeerAttachment | null>(null);
  const [sourceError, setSourceError] = useState('');
  const openReference = (path: string) => {
    if (!path.startsWith('brigadier-attachment:')) { onFile(path); return; }
    if (!projectId) {setSourceError('Attachment project is unavailable.');return;}
    void peerApi.attachment(projectId, path.slice('brigadier-attachment:'.length)).then(file=>setAttachment(file.metadata), error=>setSourceError(String(error)));
  };
  const { source, text } = peerMessageContent(item, peers, initial);
  if (source) return <PeerIncomingMessage item={item} peers={peers} onSelectSession={onSelectSession} />;
  const long =
    text.length > 480 || text.split("\n").length > 8;
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <ChatPanelUserMessage className="max-w-[85%] bg-elevated px-4 py-3 text-sm whitespace-pre-wrap sm:max-w-[75%]">
        <div
          className={
            long && !expanded ? "line-clamp-5" : ""
          }
        >
          <Markdown text={text} onFile={openReference} />
        </div>
        {attachment && <AttachmentPreview attachment={attachment}/>}
        {sourceError && <p role="alert">{sourceError}</p>}
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
      </ChatPanelUserMessage>
      <div className="aui-message-actions flex items-center gap-1 text-xs text-text-tertiary">
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
