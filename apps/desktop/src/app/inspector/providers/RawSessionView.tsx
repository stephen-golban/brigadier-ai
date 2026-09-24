import { ArrowLeft, ChevronRight } from "@openai/apps-sdk-ui/components/Icon";
import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  CODEX_OUTWARD_WARNING,
  PROVIDER_LABELS,
  QuotaWindows,
  STATE_VARIANTS,
} from "@/app/inspector/providers/shared";
import {
  foldTranscript,
  type TranscriptItem,
  type TranscriptStats,
} from "@/app/inspector/providers/transcript";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ApprovalRequest, Decider, ProviderError, RawSession } from "@/ipc/generated";
import { formatDateTime, formatMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  answerApproval,
  closeRawSession,
  forkRawSession,
  interruptRawSession,
  loadEarlierRawEntries,
  resumeRawSession,
  selectRawSession,
  sendRawSession,
  stopRawSession,
} from "@/state/actions";
import { useApp } from "@/state/store";

const EMPTY: never[] = [];

const DECIDERS: Record<Decider, string> = {
  policy: "Brigadier",
  user: "you",
  recorded: "the recording",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One raw session: its controls, live figures, transcript and composer. */
export function RawSessionView({ id }: { id: string }) {
  const session = useApp((s) => s.providers.view?.sessions.find((entry) => entry.id === id));
  const transcript = useApp((s) => s.providers.transcripts[id]);
  const entries = transcript?.entries ?? EMPTY;
  const folded = useMemo(() => foldTranscript(entries), [entries]);
  const [error, setError] = useState<string | null>(null);

  const act = (action: () => Promise<void>) => {
    setError(null);
    action().catch((err: unknown) => setError(errorText(err)));
  };

  if (!session) {
    return (
      <div className="p-4 text-xs">
        <Button size="xs" variant="ghost" onClick={() => selectRawSession(null)}>
          <ArrowLeft />
          Sessions
        </Button>
        <p className="text-muted-foreground mt-2">This session is not known to the daemon.</p>
      </div>
    );
  }

  const live = session.source.type === "live";
  const running = session.state === "running";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionHeader session={session} stats={folded.stats} act={act} />
      {error && <p className="text-destructive border-b px-3 py-1.5 text-xs">{error}</p>}
      <TranscriptList
        id={id}
        items={folded.items}
        hasMore={transcript?.hasMore ?? false}
        loading={transcript?.loading ?? true}
      />
      {folded.pending.length > 0 && running && (
        <div className="flex max-h-60 shrink-0 flex-col gap-2 overflow-y-auto border-t p-2">
          {folded.pending.map((request) => (
            <ApprovalCard key={request.id} sessionId={id} request={request} act={act} />
          ))}
        </div>
      )}
      {live && (
        <Composer
          disabled={!running}
          turnActive={folded.stats.turnActive}
          onSend={(text, steer) => act(() => sendRawSession(id, text, steer))}
          onInterrupt={() => act(() => interruptRawSession(id))}
        />
      )}
    </div>
  );
}

function SessionHeader({
  session,
  stats,
  act,
}: {
  session: RawSession;
  stats: TranscriptStats;
  act: (action: () => Promise<void>) => void;
}) {
  const live = session.source.type === "live";
  const { state } = session;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to sessions"
          onClick={() => selectRawSession(null)}
        >
          <ArrowLeft />
        </Button>
        <span className="text-sm font-medium">{PROVIDER_LABELS[session.provider]}</span>
        <Badge variant={STATE_VARIANTS[state]}>{state}</Badge>
        {session.source.type !== "live" && (
          <Badge variant="outline">{session.source.type}</Badge>
        )}
        {stats.turnActive && state === "running" && <Badge variant="warning">turn running</Badge>}
        <span className="flex-1" />
        {live && state === "running" && (
          <Button size="xs" variant="outline" onClick={() => act(() => stopRawSession(session.id))}>
            Stop
          </Button>
        )}
        {live && state === "stopped" && session.nativeId && (
          <Button size="xs" variant="outline" onClick={() => act(() => resumeRawSession(session.id))}>
            Resume
          </Button>
        )}
        {live && (state === "running" || state === "stopped") && session.nativeId && (
          <Button size="xs" variant="outline" onClick={() => act(() => forkRawSession(session.id))}>
            Fork
          </Button>
        )}
        {live && state !== "closing" && state !== "closed" && (
          <Button
            size="xs"
            variant="outline"
            title="End the CLI and remove every file its session created"
            onClick={() => act(() => closeRawSession(session.id))}
          >
            Close
          </Button>
        )}
      </div>
      <div data-selectable className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
        {session.cwd && <span className="font-mono">{session.cwd}</span>}
        <span>
          {stats.model ?? session.model ?? "default model"}
          {session.effort && ` · ${session.effort}`}
        </span>
        {live && (
          <span>
            {session.access.type === "workspace" ? "workspace" : session.access.type} ·{" "}
            {session.approvals === "delegated" ? "policy + me" : "decline all"}
          </span>
        )}
        {session.nativeId && <span className="font-mono">{session.nativeId}</span>}
        {stats.context && (
          <span className="tabular-nums">
            context {stats.context.usedTokens.toLocaleString()}
            {stats.context.windowTokens !== null &&
              ` / ${stats.context.windowTokens.toLocaleString()}`}
          </span>
        )}
        {stats.usage && (
          <span className="tabular-nums">
            {stats.usage.inputTokens.toLocaleString()} in ·{" "}
            {stats.usage.cachedInputTokens.toLocaleString()} cached ·{" "}
            {stats.usage.outputTokens.toLocaleString()} out
            {stats.usage.costUsd !== null && ` · $${stats.usage.costUsd.toFixed(4)}`}
          </span>
        )}
        {session.recording && <span className="font-mono">recording → {session.recording}</span>}
      </div>
      {live && session.provider === "codex" && session.access.type === "workspace" && (
        <p className="text-warning">{CODEX_OUTWARD_WARNING}</p>
      )}
      {session.error && <p className="text-destructive">{session.error}</p>}
      {stats.quota && <QuotaWindows quota={stats.quota} />}
    </div>
  );
}

function TranscriptList({
  id,
  items,
  hasMore,
  loading,
}: {
  id: string;
  items: readonly TranscriptItem[];
  hasMore: boolean;
  loading: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow new output while the view is scrolled to the bottom (items only change with it).
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  return (
    <div
      ref={scrollRef}
      data-selectable
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-xs"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {hasMore && (
        <Button
          size="xs"
          variant="ghost"
          className="self-center"
          disabled={loading}
          onClick={() => void loadEarlierRawEntries(id)}
        >
          Load earlier events
        </Button>
      )}
      {items.length === 0 && (
        <p className="text-muted-foreground">{loading ? "Loading…" : "No events yet."}</p>
      )}
      {items.map((item) => (
        <Item key={item.key} item={item} />
      ))}
    </div>
  );
}

const Item = memo(function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "message":
      return (
        <div
          className={cn(
            "rounded-lg px-2.5 py-1.5 whitespace-pre-wrap",
            item.role === "user" ? "bg-secondary self-end" : "bg-card border",
          )}
        >
          {item.text}
          {item.streaming && <span className="text-muted-foreground"> ▍</span>}
        </div>
      );
    case "reasoning":
      return (
        <Details summary={item.streaming ? "Thinking…" : "Reasoning"} muted>
          <p className="text-muted-foreground whitespace-pre-wrap">{item.text}</p>
        </Details>
      );
    case "command":
      return (
        <Details
          summary={
            <>
              <span className="font-mono">$ {item.command || "command"}</span>
              <StatusBadge status={item.status} />
              {item.exitCode !== null && (
                <span className="text-muted-foreground">exit {item.exitCode}</span>
              )}
              {item.durationMs !== null && (
                <span className="text-muted-foreground">{formatMs(item.durationMs)}</span>
              )}
            </>
          }
        >
          {item.cwd && <p className="text-muted-foreground font-mono">{item.cwd}</p>}
          {item.output && (
            <pre className="bg-code-surface rounded-control max-h-60 overflow-auto p-2 font-mono whitespace-pre-wrap">
              {item.output}
            </pre>
          )}
        </Details>
      );
    case "tool":
      return (
        <Details
          summary={
            <>
              <span className="font-mono">{item.name}</span>
              <StatusBadge status={item.status} />
            </>
          }
        >
          {item.input && (
            <pre className="bg-code-surface rounded-control max-h-40 overflow-auto p-2 font-mono whitespace-pre-wrap">
              {item.input}
            </pre>
          )}
          {item.output && (
            <pre className="bg-code-surface rounded-control max-h-40 overflow-auto p-2 font-mono whitespace-pre-wrap">
              {item.output}
            </pre>
          )}
        </Details>
      );
    case "files":
      return (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span>File changes</span>
            <StatusBadge status={item.status} />
          </div>
          {item.changes.map((change) => (
            <span key={change.path} className="text-muted-foreground font-mono">
              {change.kind} {change.path}
            </span>
          ))}
        </div>
      );
    case "image":
      return (
        <div className="flex items-center gap-2">
          <span>Image</span>
          <StatusBadge status={item.status} />
          <span className="text-muted-foreground min-w-0 truncate font-mono">
            {item.path ?? item.prompt}
          </span>
        </div>
      );
    case "approval":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={item.request.escalation ? "warning" : "outline"}>
            approval · {item.request.kind}
          </Badge>
          <span className="min-w-0 flex-1 truncate font-mono">
            {item.request.command ?? (item.request.paths.join(", ") || item.request.tool)}
          </span>
          {item.resolution ? (
            <span className="text-muted-foreground">
              {item.resolution.decision.type === "allow" ? "allowed" : "denied"} by{" "}
              {DECIDERS[item.resolution.decidedBy]}
            </span>
          ) : (
            <span className="text-warning">waiting</span>
          )}
        </div>
      );
    case "turnStarted":
      return <Divider label="Turn started" />;
    case "turnCompleted":
      return (
        <Divider
          label={`Turn ${item.status}${item.durationMs === null ? "" : ` · ${formatMs(item.durationMs)}`}`}
          tone={item.status === "completed" ? "muted" : "warning"}
        />
      );
    case "error":
      return <ErrorCard error={item.error} />;
    case "notice":
      return (
        <p className={item.level === "warning" ? "text-warning" : "text-muted-foreground"}>
          {item.text}
        </p>
      );
  }
});

function Details({
  summary,
  muted,
  children,
}: {
  summary: ReactNode;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger
        className={cn(
          "hover:text-foreground group flex max-w-full items-center gap-1.5 text-start",
          muted && "text-muted-foreground",
        )}
      >
        <ChevronRight className="size-icon-xs shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-1 ps-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "completed"
      ? "success"
      : status === "inProgress"
        ? "warning"
        : status === "failed"
          ? "destructive"
          : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

function Divider({ label, tone = "muted" }: { label: string; tone?: "muted" | "warning" }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2",
        tone === "warning" ? "text-warning" : "text-muted-foreground",
      )}
    >
      <span className="bg-border h-px flex-1" />
      <span>{label}</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

/** A classified provider error, with the limit it hit when it is one. */
function ErrorCard({ error }: { error: ProviderError }) {
  return (
    <div className="border-destructive/50 bg-destructive/10 flex flex-col gap-1 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="destructive">{error.kind}</Badge>
        {error.code && <span className="text-muted-foreground font-mono">{error.code}</span>}
        {error.willRetry && <Badge variant="secondary">CLI retries</Badge>}
      </div>
      {error.limit && (
        <p>
          Window <span className="font-mono">{error.limit.window ?? "unknown"}</span>
          {error.limit.resetsAtMs !== null &&
            ` · resets ${formatDateTime(error.limit.resetsAtMs)}`}
        </p>
      )}
      <p className="whitespace-pre-wrap">{error.message}</p>
    </div>
  );
}

function ApprovalCard({
  sessionId,
  request,
  act,
}: {
  sessionId: string;
  request: ApprovalRequest;
  act: (action: () => Promise<void>) => void;
}) {
  const answer = (allow: boolean) =>
    act(() =>
      answerApproval(
        sessionId,
        request.id,
        allow ? { type: "allow" } : { type: "deny", message: "Denied by the user." },
      ),
    );
  return (
    <div className="border-warning/50 bg-warning/10 flex flex-col gap-1.5 rounded-lg border p-2.5 text-xs">
      <div className="flex items-center gap-2">
        <Badge variant="warning">{request.kind}</Badge>
        <span className="font-mono">{request.tool}</span>
        {request.escalation && <Badge variant="destructive">outside the sandbox</Badge>}
      </div>
      {request.command && <pre className="font-mono whitespace-pre-wrap">{request.command}</pre>}
      {request.paths.length > 0 && (
        <p className="font-mono">{request.paths.join("\n")}</p>
      )}
      {request.reason && <p className="text-muted-foreground">{request.reason}</p>}
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="outline" onClick={() => answer(false)}>
          Deny
        </Button>
        <Button size="xs" onClick={() => answer(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}

function Composer({
  disabled,
  turnActive,
  onSend,
  onInterrupt,
}: {
  disabled: boolean;
  turnActive: boolean;
  onSend: (text: string, steer: boolean) => void;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const send = (steer: boolean) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed, steer);
    setText("");
  };
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t p-2">
      <textarea
        aria-label="Message"
        value={text}
        disabled={disabled}
        rows={3}
        placeholder={disabled ? "The session is not running." : "Message (⌘↩ to send, ⇧⌘↩ to steer)"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send(event.shiftKey);
          }
        }}
        className="bg-muted/60 focus-visible:bg-background rounded-control focus-visible:ring-ring/50 w-full resize-none border border-transparent p-2 text-xs outline-none focus-visible:ring-1 disabled:opacity-50"
      />
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground flex-1 text-xs">
          Steer delivers into the running turn, or starts one.
        </span>
        <Button size="xs" variant="outline" disabled={disabled || !turnActive} onClick={onInterrupt}>
          Interrupt
        </Button>
        <Button size="xs" variant="outline" disabled={disabled || !text.trim()} onClick={() => send(true)}>
          Steer
        </Button>
        <Button size="xs" disabled={disabled || !text.trim()} onClick={() => send(false)}>
          Send
        </Button>
      </div>
    </div>
  );
}
