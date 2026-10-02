import type { OvernightRun, TaskId } from "@/ipc/generated";

/** Facts not yet projected by steps 3–5. Keep their translation and IPC wiring here. */
export type OvernightDetails = {
  /** Run-scoped counts, never the whole conversation's counts. */
  waiting: number;
  decided: number;
  phaseProgress: Readonly<
    Record<
      string,
      {
        fixRound?: 1 | 2;
        quota?: { provider: string; resetsAtMs: number };
        workerTaskIds?: readonly TaskId[];
        criteria?: Readonly<Record<string, "verified" | "partial" | "blocked">>;
      }
    >
  >;
  /** Needed when a relative deadline has been resolved at Start. */
  reportReadyAtMs?: number;
  /** Exactly the report's three outcome lines, from recorded report facts. */
  outcome?: readonly [string, string, string];
  reportMessageId?: string;
  verifiedSha?: string;
  /** Use the conductor's remaining work, including intentionally skipped/deferred phases. */
  remainingPhaseIds: readonly string[];
  power?: { onBattery: boolean; lidWillPause: boolean; offerLidSetup: boolean };
};

export type OvernightCardModel = {
  run: OvernightRun;
  details: OvernightDetails;
};

/** A command sees the revision/generation of the card the user actually acted on. */
export type OvernightCommand = {
  conversationId: string;
  runId: string;
  commandId: string;
  revision: number;
  generation: number;
};

export type OvernightActions = {
  start: (command: OvernightCommand) => Promise<unknown>;
  stop: (command: OvernightCommand) => Promise<unknown>;
  /** Creates a proposal on the same branch; it must never start work. */
  continue: (command: OvernightCommand, words: string) => Promise<unknown>;
  /** Run merge of the verified SHA, independent of the session's workspace. */
  merge: (command: OvernightCommand, verifiedSha: string) => Promise<unknown>;
  openReport: (conversationId: string, messageId: string) => void;
  setUpLidClosed: () => Promise<unknown>;
};

const NO_CARDS: readonly OvernightCardModel[] = [];

/**
 * Deliberately disconnected until the conductor/report/run-merge IPC is integrated.
 * Integration is confined to this module: subscribe to board.overnight, select the latest
 * segment per plan, project the facts above, and provide the actions below using request().
 * Do not expose proposals or Start before the real path is ready.
 */
export function useOvernightCards(
  _conversationId: string,
): readonly OvernightCardModel[] {
  return NO_CARDS;
}

export const overnightActions: OvernightActions | null = null;

export function overnightCommand(run: OvernightRun): OvernightCommand {
  return {
    conversationId: run.conversationId,
    runId: run.id,
    commandId: crypto.randomUUID(),
    revision: run.revision,
    generation: run.generation,
  };
}

export function deadlineLabel(model: OvernightCardModel): string {
  const { run, details } = model;
  const deadline = run.directives.deadline;
  if (deadline.type === "untilDone") return "until done";
  if (deadline.type === "at") return `until ${deadline.time.localTime}`;
  if (details.reportReadyAtMs !== undefined) {
    return `until ${new Date(details.reportReadyAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  }
  // A duration on an unstarted proposal has no fixed wall-clock deadline yet.
  return `for ${deadline.minutes % 60 === 0 ? `${deadline.minutes / 60} hours` : `${deadline.minutes} minutes`}`;
}

export function restrictionLines(run: OvernightRun): string[] {
  const { only, stopAfter, skip, maxWorkers } = run.directives;
  return [
    ...(only ? [`Only phases ${only.from}–${only.to}`] : []),
    ...(stopAfter
      ? [
          stopAfter.type === "phase"
            ? `Stop after phase ${stopAfter.number}`
            : "Stop after this phase",
        ]
      : []),
    ...(skip.length
      ? [`Skip ${skip.length === 1 ? "phase" : "phases"} ${skip.join(", ")}`]
      : []),
    ...(maxWorkers !== null
      ? [
          `At most ${maxWorkers} ${maxWorkers === 1 ? "worker" : "workers"} at once`,
        ]
      : []),
  ];
}
