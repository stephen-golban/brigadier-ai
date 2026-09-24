import type {
  ApprovalDecision,
  ApprovalRequest,
  Decider,
  FileChange,
  ItemStatus,
  NoticeLevel,
  ProviderError,
  QuotaSnapshot,
  RawEntry,
  Role,
  TokenUsage,
  TurnStatus,
} from "@/ipc/generated";

/** One row of a raw session's transcript, folded from its events. */
export type TranscriptItem =
  | { kind: "message"; key: string; role: Role; text: string; streaming: boolean }
  | { kind: "reasoning"; key: string; text: string; streaming: boolean }
  | {
      kind: "command";
      key: string;
      command: string;
      cwd: string | null;
      status: ItemStatus;
      exitCode: number | null;
      output: string;
      durationMs: number | null;
    }
  | {
      kind: "tool";
      key: string;
      name: string;
      input: string | null;
      status: ItemStatus;
      output: string | null;
    }
  | { kind: "files"; key: string; changes: FileChange[]; status: ItemStatus }
  | {
      kind: "image";
      key: string;
      status: ItemStatus;
      path: string | null;
      prompt: string | null;
    }
  | {
      kind: "approval";
      key: string;
      request: ApprovalRequest;
      resolution: { decision: ApprovalDecision; decidedBy: Decider } | null;
    }
  | { kind: "turnStarted"; key: string }
  | {
      kind: "turnCompleted";
      key: string;
      status: TurnStatus;
      durationMs: number | null;
      usage: TokenUsage | null;
    }
  | { kind: "error"; key: string; error: ProviderError }
  | { kind: "notice"; key: string; level: NoticeLevel; text: string };

/** The latest session-wide figures, as last reported. */
export type TranscriptStats = {
  model: string | null;
  cliVersion: string | null;
  usage: TokenUsage | null;
  context: { usedTokens: number; windowTokens: number | null } | null;
  quota: QuotaSnapshot | null;
  /** A turn started and has not completed yet. */
  turnActive: boolean;
};

export type FoldedTranscript = {
  items: TranscriptItem[];
  stats: TranscriptStats;
  /** Approvals routed to the user and not answered yet. */
  pending: ApprovalRequest[];
};

/**
 * Folds events into rows. Streaming text arrives as deltas keyed by `itemId`; the final
 * `message`/`reasoning` event replaces what the deltas built. Commands, tool calls, file
 * changes and approvals are updated in place as their status changes.
 */
export function foldTranscript(entries: readonly RawEntry[]): FoldedTranscript {
  const items: TranscriptItem[] = [];
  const index = new Map<string, number>();
  const stats: TranscriptStats = {
    model: null,
    cliVersion: null,
    usage: null,
    context: null,
    quota: null,
    turnActive: false,
  };

  const upsert = (item: TranscriptItem, merge?: (current: TranscriptItem) => TranscriptItem) => {
    const at = index.get(item.key);
    if (at === undefined) {
      index.set(item.key, items.length);
      items.push(item);
    } else {
      const current = items[at];
      items[at] = merge && current ? merge(current) : item;
    }
  };

  for (const { event, streamSeq } of entries) {
    switch (event.type) {
      case "sessionStarted":
        stats.model = event.model ?? stats.model;
        stats.cliVersion = event.cliVersion ?? stats.cliVersion;
        upsert({
          kind: "notice",
          key: `seq:${streamSeq}`,
          level: "info",
          text: `Session ${event.nativeId} started${event.model ? ` · ${event.model}` : ""}${event.cwd ? ` · ${event.cwd}` : ""}`,
        });
        break;
      case "turnStarted":
        stats.turnActive = true;
        upsert({ kind: "turnStarted", key: `seq:${streamSeq}` });
        break;
      case "turnCompleted":
        stats.turnActive = false;
        upsert({
          kind: "turnCompleted",
          key: `seq:${streamSeq}`,
          status: event.status,
          durationMs: event.durationMs,
          usage: event.usage,
        });
        break;
      case "messageDelta":
        upsert(
          {
            kind: "message",
            key: `message:${event.itemId}`,
            role: "assistant",
            text: event.text,
            streaming: true,
          },
          (current) =>
            current.kind === "message" && current.streaming
              ? { ...current, text: current.text + event.text }
              : current,
        );
        break;
      case "message":
        upsert({
          kind: "message",
          key: `message:${event.itemId}`,
          role: event.role,
          text: event.text,
          streaming: false,
        });
        break;
      case "reasoningDelta":
        upsert(
          { kind: "reasoning", key: `reasoning:${event.itemId}`, text: event.text, streaming: true },
          (current) =>
            current.kind === "reasoning" && current.streaming
              ? { ...current, text: current.text + event.text }
              : current,
        );
        break;
      case "reasoning":
        upsert({
          kind: "reasoning",
          key: `reasoning:${event.itemId}`,
          text: event.text,
          streaming: false,
        });
        break;
      case "command":
        upsert(
          {
            kind: "command",
            key: `command:${event.itemId}`,
            command: event.command,
            cwd: event.cwd,
            status: event.status,
            exitCode: event.exitCode,
            output: event.output ?? "",
            durationMs: event.durationMs,
          },
          (current) =>
            current.kind === "command"
              ? {
                  ...current,
                  command: event.command,
                  cwd: event.cwd ?? current.cwd,
                  status: event.status,
                  exitCode: event.exitCode,
                  // The final output replaces what streamed.
                  output: event.output ?? current.output,
                  durationMs: event.durationMs,
                }
              : current,
        );
        break;
      case "commandOutputDelta":
        upsert(
          {
            kind: "command",
            key: `command:${event.itemId}`,
            command: "",
            cwd: null,
            status: "inProgress",
            exitCode: null,
            output: event.text,
            durationMs: null,
          },
          (current) =>
            current.kind === "command" && current.status === "inProgress"
              ? { ...current, output: current.output + event.text }
              : current,
        );
        break;
      case "toolCall":
        upsert({
          kind: "tool",
          key: `tool:${event.itemId}`,
          name: event.name,
          input: event.input,
          status: event.status,
          output: event.output,
        });
        break;
      case "fileChanges":
        upsert({
          kind: "files",
          key: `files:${event.itemId}`,
          changes: event.changes,
          status: event.status,
        });
        break;
      case "image":
        upsert({
          kind: "image",
          key: `image:${event.itemId}`,
          status: event.status,
          path: event.path,
          prompt: event.prompt,
        });
        break;
      case "approvalRequested":
        upsert({
          kind: "approval",
          key: `approval:${event.request.id}`,
          request: event.request,
          resolution: null,
        });
        break;
      case "approvalResolved":
        upsert(
          {
            kind: "notice",
            key: `approval:${event.id}`,
            level: "info",
            text: `Approval ${event.id} answered`,
          },
          (current) =>
            current.kind === "approval"
              ? {
                  ...current,
                  resolution: { decision: event.decision, decidedBy: event.decidedBy },
                }
              : current,
        );
        break;
      case "usage":
        stats.usage = event.total;
        break;
      case "contextSize":
        stats.context = {
          usedTokens: event.usedTokens,
          windowTokens: event.windowTokens ?? stats.context?.windowTokens ?? null,
        };
        break;
      case "rateLimits":
        stats.quota = event.quota;
        break;
      case "error":
        upsert({ kind: "error", key: `seq:${streamSeq}`, error: event.error });
        break;
      case "notice":
        upsert({
          kind: "notice",
          key: `seq:${streamSeq}`,
          level: event.level,
          text: event.message,
        });
        break;
      case "exited":
        stats.turnActive = false;
        upsert({
          kind: "notice",
          key: `seq:${streamSeq}`,
          level: event.code === 0 ? "info" : "warning",
          text: `CLI exited${event.code === null ? "" : ` with code ${event.code}`}${event.stderrTail ? `: ${event.stderrTail}` : ""}`,
        });
        break;
    }
  }

  const pending = items.flatMap((item) =>
    item.kind === "approval" && item.resolution === null ? [item.request] : [],
  );
  return { items, stats, pending };
}
