import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ContextChart } from "@/app/inspector/ContextChart";
import {
  type ContextPoint,
  deriveLog,
  formatTokens,
  GROUPS,
  groupOf,
  type InjectionRow,
  KIND_LABELS,
  sumOf,
} from "@/app/inspector/orchestratorLog";
import { Button } from "@/components/ui/button";
import { formatBytes, formatClock } from "@/lib/format";
import { tokenPx } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { loadEarlierOrchestratorLog, openOrchestratorLog } from "@/state/actions";
import { useBoard } from "@/state/board";
import { useApp } from "@/state/store";

const NO_ENTRIES: never[] = [];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The open session's id, or `null` when the main area shows a chat, a draft or nothing. */
function useOpenSession(): string | null {
  return useApp((s) => {
    if (s.selection.type !== "conversation") return null;
    const conversation = s.conversations[s.selection.id];
    return conversation?.kind === "session" ? conversation.id : null;
  });
}

/**
 * The open session's orchestrator: every context injection against the CLI's reported
 * context size, so it is visible that its context grows only by messages and reports.
 */
export function OrchestratorTab() {
  const sessionId = useOpenSession();
  const [failure, setFailure] = useState<{ sessionId: string; message: string } | null>(null);

  // Follow the open session's log while this tab shows; stop following when it closes.
  useEffect(() => {
    if (sessionId === null) return undefined;
    openOrchestratorLog(sessionId).catch((cause: unknown) =>
      setFailure({ sessionId, message: errorText(cause) }),
    );
    return () => {
      void openOrchestratorLog(null);
    };
  }, [sessionId]);

  if (sessionId === null) {
    return (
      <p className="text-muted-foreground p-4 text-xs">
        Open a session to see its orchestrator.
      </p>
    );
  }
  const error = failure?.sessionId === sessionId ? failure.message : null;
  return <OrchestratorLogView sessionId={sessionId} error={error} />;
}

function OrchestratorLogView({ sessionId, error }: { sessionId: string; error: string | null }) {
  const log = useBoard((s) =>
    s.orchestrator?.conversationId === sessionId ? s.orchestrator : null,
  );
  const entries = log?.entries ?? NO_ENTRIES;
  const derived = useMemo(() => deriveLog(entries), [entries]);
  const [earlierError, setEarlierError] = useState<string | null>(null);

  return (
    <>
      <div className="flex shrink-0 flex-col gap-3 border-b px-3 py-2.5 text-xs">
        <ContextMeter point={derived.latestContext} injected={sumOf(derived.totals)} />
        <ContextChart log={derived} />
        {log?.hasMore && (
          <p className="text-muted-foreground">
            Totals count from the oldest loaded entry.{" "}
            <Button
              size="xs"
              variant="ghost"
              disabled={log.loading}
              onClick={() => {
                setEarlierError(null);
                loadEarlierOrchestratorLog().catch((cause: unknown) =>
                  setEarlierError(errorText(cause)),
                );
              }}
            >
              Load earlier entries
            </Button>
          </p>
        )}
        {(error ?? earlierError) && (
          <p role="alert" className="text-destructive">
            {error ?? earlierError}
          </p>
        )}
      </div>
      <InjectionList
        injections={derived.injections}
        loading={log?.loading ?? true}
      />
    </>
  );
}

function ContextMeter({ point, injected }: { point: ContextPoint | null; injected: number }) {
  const used = point?.usedTokens ?? null;
  const windowTokens = point?.windowTokens ?? null;
  const share = used !== null && windowTokens ? Math.min(100, (used / windowTokens) * 100) : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="flex-1 font-medium">Context</span>
        <span className="text-muted-foreground tabular-nums">
          {used === null
            ? "not reported yet"
            : `${formatTokens(used)}${windowTokens ? ` of ${formatTokens(windowTokens)}` : ""} tokens${
                share === null ? "" : ` · ${Math.round(share)}%`
              }`}
        </span>
      </div>
      <div
        role="meter"
        aria-label="Orchestrator context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share === null ? undefined : Math.round(share)}
        className="bg-muted h-1.5 overflow-hidden rounded-full"
      >
        {share !== null && (
          <div
            className={cn("h-full", share >= 90 ? "bg-destructive" : "bg-primary")}
            style={{ width: `${share}%` }}
          />
        )}
      </div>
      <span className="text-muted-foreground tabular-nums">
        Brigadier injected about {formatTokens(injected)} tokens (≈ 4 bytes per token)
      </span>
    </div>
  );
}

const SWATCHES = Object.fromEntries(GROUPS.map((group) => [group.id, group.swatch]));

const InjectionRowView = memo(function InjectionRowView({
  row,
  taskNumber,
}: {
  row: InjectionRow;
  taskNumber: number | null;
}) {
  const { injection } = row;
  return (
    <div className="h-row-sm flex items-center gap-2 px-3 font-mono text-xs">
      <span className="text-muted-foreground shrink-0 tabular-nums">{formatClock(row.atMs)}</span>
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-xs", SWATCHES[groupOf(injection.kind)])}
      />
      <span className="text-foreground shrink-0">{KIND_LABELS[injection.kind]}</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate" title={injection.label}>
        {injection.label}
        {taskNumber !== null && ` · task-${taskNumber}`}
      </span>
      <span className="shrink-0 tabular-nums">{formatTokens(injection.tokensEstimate)} tok</span>
      <span className="text-muted-foreground w-16 shrink-0 text-end tabular-nums">
        {formatBytes(injection.bytes)}
      </span>
    </div>
  );
});

function InjectionList({
  injections,
  loading,
}: {
  injections: readonly InjectionRow[];
  loading: boolean;
}) {
  const density = useApp((s) => s.settings.density);
  const tasks = useBoard((s) => s.board?.tasks);
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = injections.length;
  // Newest first, like the Events tab.
  const at = (index: number) => injections[count - 1 - index];

  // The app does not use React Compiler, so the virtualizer's unmemoizable API is fine here.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => tokenPx("--spacing-row-sm"),
    getItemKey: (index) => at(index)?.streamSeq ?? index,
    overscan: 10,
  });

  // Row height is a density token.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [density, virtualizer]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-muted-foreground flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="flex-1">Context injections, newest first · {count}</span>
      </div>
      <div ref={scrollRef} data-selectable className="min-h-0 flex-1 overflow-y-auto">
        {count === 0 ? (
          <p className="text-muted-foreground p-4 text-xs">
            {loading ? "Loading…" : "Nothing has entered the orchestrator's context yet."}
          </p>
        ) : (
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = at(item.index);
              if (!row) return null;
              const taskId = row.injection.taskId;
              return (
                <div
                  key={item.key}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <InjectionRowView
                    row={row}
                    taskNumber={taskId ? (tasks?.[taskId]?.number ?? null) : null}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
