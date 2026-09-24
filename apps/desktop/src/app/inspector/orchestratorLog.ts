import type {
  ContextInjection,
  InjectionKind,
  OrchestratorLogEntry,
} from "@/ipc/generated";

/**
 * Injections grouped for the context chart. Messages and reports are what the orchestrator's
 * context should grow by; instructions (and a rebirth's reseed) are its briefing; anything
 * else is worth noticing, so it gets its own band.
 */
export type InjectionGroup = "instructions" | "messages" | "reports" | "other";

/** Stack order, bottom to top. Colors are validated for dark mode against the background
 * (CVD ΔE ≥ 14 between every pair); "other" is a recessive neutral, labeled in the legend. */
export const GROUPS: readonly {
  id: InjectionGroup;
  label: string;
  fill: string;
  swatch: string;
}[] = [
  { id: "instructions", label: "Instructions", fill: "fill-chart-4", swatch: "bg-chart-4" },
  { id: "messages", label: "Your messages", fill: "fill-chart-2", swatch: "bg-chart-2" },
  { id: "reports", label: "Worker reports", fill: "fill-chart-1", swatch: "bg-chart-1" },
  {
    id: "other",
    label: "Other",
    fill: "fill-muted-foreground/50",
    swatch: "bg-muted-foreground/50",
  },
];

export const KIND_LABELS: Record<InjectionKind, string> = {
  instructions: "instructions",
  userMessage: "user message",
  report: "report",
  workerQuestion: "worker question",
  decision: "decision",
  taskFailed: "task failed",
  toolResult: "tool result",
  artifact: "artifact",
  reseed: "reseed",
};

export function groupOf(kind: InjectionKind): InjectionGroup {
  switch (kind) {
    case "instructions":
    case "reseed":
      return "instructions";
    case "userMessage":
      return "messages";
    case "report":
      return "reports";
    default:
      return "other";
  }
}

export type GroupTotals = Record<InjectionGroup, number>;

export type InjectionRow = {
  streamSeq: number;
  atMs: number;
  injection: ContextInjection;
};

/** The CLI's reported context size, placed after the injections that preceded it. */
export type ContextPoint = {
  /** Injections logged before this report. */
  after: number;
  usedTokens: number;
  windowTokens: number | null;
  atMs: number;
};

export type DerivedLog = {
  injections: InjectionRow[];
  /** Cumulative estimated tokens per group after each injection (same order as `injections`). */
  cumulative: GroupTotals[];
  totals: GroupTotals;
  counts: GroupTotals;
  context: ContextPoint[];
  latestContext: ContextPoint | null;
};

function zero(): GroupTotals {
  return { instructions: 0, messages: 0, reports: 0, other: 0 };
}

export function deriveLog(entries: readonly OrchestratorLogEntry[]): DerivedLog {
  const injections: InjectionRow[] = [];
  const cumulative: GroupTotals[] = [];
  const context: ContextPoint[] = [];
  let running = zero();
  const counts = zero();
  let windowTokens: number | null = null;
  for (const { streamSeq, atMs, entry } of entries) {
    if (entry.type === "injection") {
      const group = groupOf(entry.injection.kind);
      running = { ...running, [group]: running[group] + entry.injection.tokensEstimate };
      counts[group] += 1;
      injections.push({ streamSeq, atMs, injection: entry.injection });
      cumulative.push(running);
    } else if (entry.event.type === "contextSize") {
      windowTokens = entry.event.windowTokens ?? windowTokens;
      context.push({
        after: injections.length,
        usedTokens: entry.event.usedTokens,
        windowTokens,
        atMs,
      });
    }
  }
  return {
    injections,
    cumulative,
    totals: running,
    counts,
    context,
    latestContext: context.at(-1) ?? null,
  };
}

export function sumOf(totals: GroupTotals): number {
  return totals.instructions + totals.messages + totals.reports + totals.other;
}

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTokens(tokens: number): string {
  return compact.format(tokens);
}
