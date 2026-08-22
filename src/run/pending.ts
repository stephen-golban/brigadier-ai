// SPDX-License-Identifier: Apache-2.0
/**
 * A run that stopped to ask something, and everything needed to continue it.
 *
 * Ruling 75's D13: *"brigadier exits with the question and enough state to
 * continue; the model raises it in conversation; `brigadier resume <run-id>
 * --answer …` picks it up."* **No ruling is overturned by this.** It works on all
 * six vendors, where MCP elicitation is measured on Claude Code alone, and it
 * matches the owner's own sentence — *"if brigadier has a question the model
 * raises it"* — more closely than a dialog box does.
 *
 * **WHY A FILE AND NOT A PROCESS.** Ruling 25's measured constraint stands and
 * got worse: brigadier's stdout lands in a model's context rather than on a
 * terminal, and ruling 75 measured `/dev/tty` unreachable from inside a CLI tool
 * call — `ENXIO`, against a pty control that delivered. There is no channel on
 * which brigadier can wait for an answer. So it does not wait: it drains, writes
 * this, and exits, and the answer arrives as a new invocation.
 *
 * **WHAT THIS COSTS, from ruling 75's own accepted cost #1:** a run that asks
 * three questions is four processes, four detections or cache reads, and four
 * admissions. **A resumed run is not one run**, and ruling 63 already requires
 * the report to say so rather than presenting it as one.
 *
 * WHAT IS DELIBERATELY NOT IN HERE: the answer. This file is written by the
 * process that asked and read by the process that answers, and an answer field
 * would mean a third state where the file has been read but not acted on. The
 * answer arrives on the resuming command line and is never persisted.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Ruling 63's namespace, one file per run, beside the plan it belongs to. */
export function pendingPath(runRoot: string, runId: string): string {
  return join(runRoot, "r", runId, "pending.json");
}

/**
 * What kind of question this is.
 *
 * A closed set, because the RESUMING process has to know what to do with the
 * answer and a free-text question is not resumable — it is a message. D3's two
 * are the only ones brigadier can ask today: *"planning and research are not
 * forced… brigadier decides, and asks the user anyway before spending on
 * either."*
 */
export type QuestionKind =
  /** May brigadier spend a metered turn researching this goal first? */
  | "research-consent"
  /** May brigadier spend a metered turn planning this goal at all? */
  | "plan-consent";

export interface PendingRun {
  readonly version: 1;
  readonly runId: string;
  /** Milliseconds since the epoch, for D15's backstop and for nothing else. */
  readonly askedAt: number;
  readonly kind: QuestionKind;
  /** One line, in brigadier's own voice (D24). This is what the model relays. */
  readonly question: string;
  /** The operator's sentence, carried so the resuming process need not be told again. */
  readonly goal: string;
  /** Absolute path to the operator's repository. */
  readonly repo: string;
  /**
   * `HEAD` when the question was asked, and the working tree's dirty paths.
   *
   * D15: *"a pending run is invalidated by divergence, not by a clock."* These
   * are the two halves of the operator's side of that comparison.
   *
   * An EMPTY `head` means there was none to capture — a repository with no
   * commits, or a machine where git could not be run. See `readPending`.
   */
  readonly head: string;
  readonly dirty: readonly string[];
  /**
   * The paths a plan claims, when there is a plan yet.
   *
   * EMPTY IS MEANINGFUL and is not "no scope": it means nothing has been
   * computed against the repository yet, so nothing about the repository can
   * have gone stale. A question asked before planning survives a commit; a
   * question asked after it does not, if the commit touched what the plan owns.
   */
  readonly paths: readonly string[];
  /** The vendors this run had routed to, with the version detection saw (ruling 69). */
  readonly agents: readonly { readonly id: string; readonly version: string }[];
}

/** A pending file that cannot be resumed, and what is wrong with it. */
export class PendingUnusable extends Error {
  constructor(
    readonly path: string,
    why: string,
  ) {
    super(`the pending run at ${path} cannot be resumed: ${why}`);
    this.name = "PendingUnusable";
  }
}

export function encodePending(pending: PendingRun): string {
  return `${JSON.stringify(pending, null, 2)}\n`;
}

/**
 * Read one back, refusing anything this binary cannot act on.
 *
 * Refuses rather than repairing, for ruling 52's reason one layer up: a pending
 * file with a missing field is a run whose state is partly unknown, and
 * continuing on a default would spend metered turns against a base nobody
 * captured.
 */
export function readPending(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): PendingRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path));
  } catch (error) {
    throw new PendingUnusable(path, `it is not valid JSON — ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PendingUnusable(path, "the top level must be a JSON object");
  }
  const record = parsed as Partial<PendingRun>;
  if (record.version !== 1) {
    throw new PendingUnusable(path, `\`version\` is ${JSON.stringify(record.version)}; this brigadier reads version 1`);
  }
  for (const field of ["runId", "question", "goal", "repo", "kind"] as const) {
    if (typeof record[field] !== "string" || record[field] === "") {
      throw new PendingUnusable(path, `\`${field}\` is missing`);
    }
  }
  // `head` is required to be PRESENT and allowed to be EMPTY, and the two are
  // different facts. A repository with no commits yet has no HEAD, and so does
  // a machine where git could not be run at all — in both cases the HEAD half of
  // D15's comparison contributes nothing, and the other three halves (the
  // claimed paths, the routed vendors, the backstop) still do. Requiring it to
  // be non-empty made a run that stopped to ask un-resumable forever, which is
  // worse than a comparison that abstains.
  if (typeof record.head !== "string") {
    throw new PendingUnusable(path, "`head` is missing");
  }
  if (typeof record.askedAt !== "number" || !Number.isFinite(record.askedAt)) {
    throw new PendingUnusable(path, "`askedAt` is missing, and D15's backstop cannot be applied without it");
  }
  if (!Array.isArray(record.dirty) || !Array.isArray(record.paths) || !Array.isArray(record.agents)) {
    throw new PendingUnusable(path, "`dirty`, `paths` and `agents` must all be arrays");
  }
  return record as PendingRun;
}

/** Is there a question waiting on this run? */
export function pendingExists(runRoot: string, runId: string, exists = existsSync): boolean {
  return exists(pendingPath(runRoot, runId));
}
