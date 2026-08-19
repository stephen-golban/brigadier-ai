// SPDX-License-Identifier: Apache-2.0
/**
 * What a `session/prompt` turn actually does today: the whole of admission, and
 * not one step past it.
 *
 * ADMISSION IS EVERYTHING `run` DECIDES BEFORE IT SPENDS ANYTHING, and ruling
 * 53 is explicit that the value of that boundary is checkable from the outside —
 * a refusal that first created the thing it is refusing has already done the
 * thing it exists to prevent. So nothing in this file creates a directory,
 * starts a process or writes a ref. `mkdirSync` is not called here; neither is
 * `executeRun`. The turn's closing line says so in those terms, because a
 * server that answered "done" to a prompt it had only planned would be the
 * defect this repository keeps finding.
 *
 * WHY EXECUTION IS NOT WIRED, stated here rather than left to be discovered.
 * `executeRun` assumes one run per process — it takes the process's sink, it
 * registers the process's drain through `onInFlight`, and it owns the run root
 * it creates. A server is long-lived and an editor will open several sessions,
 * so wiring it needs an answer to reentrancy that is a design change to
 * `src/queue/execute.ts` rather than a call from here. `src/serve/handler.ts`
 * enforces one turn at a time for the same reason; that guard is real and is
 * what a second concurrent prompt hits.
 *
 * THE PROMPT NAMES A PLAN FILE. brigadier has no planner: `parsePlan` reads a
 * JSON plan the operator wrote, and there is nothing in this build that turns
 * English into one. Inventing a plan from prose here would be inventing the
 * input to every cost, refusal and fan-out decision below it.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { BridgeOverride } from "../agent/drift.ts";
import { intendedRealPath, realTempDirs } from "../isolation/index.ts";
import {
  admit,
  agentsOnPath,
  describeAdmission,
  describeEstimate,
  describeRefusals,
  estimatePlan,
  parsePlan,
  PlanUnreadable,
  validatePlan,
} from "../queue/index.ts";
import { defaultRunRoot, isTempRooted } from "../repo/layout.ts";
import type { Audience } from "../report/index.ts";

/**
 * The stages, in order, and the single source both the pipeline and the ACP
 * plan read.
 *
 * One list rather than two because `TurnPlan` throws on a name it does not
 * know: a stage renamed in one place and not the other is a thrown error on the
 * first prompt instead of a progress bar that never moves.
 */
export const ADMIT_STAGES = [
  "read the plan file",
  "check the run root against every temp region (ruling 61)",
  "resolve agents on PATH and validate the plan",
  "admit: refusals, waves and fan-out",
  "estimate the cost range (ruling 66)",
] as const;

export type AdmitStage = (typeof ADMIT_STAGES)[number];

export interface StageReporter {
  start(stage: AdmitStage): void;
  finish(stage: AdmitStage): void;
  /**
   * Awaited between every pair of stages. Resolves `false` when the turn has
   * been cancelled.
   *
   * A promise rather than a predicate, and that is the mechanism rather than
   * style: this process is single-threaded, so a `session/cancel` notification
   * sitting on stdin cannot be read while a synchronous pipeline is running. The
   * `await` is the only thing that gives the read loop a turn, so a cancel that
   * arrives mid-admission is seen at the NEXT stage boundary and nowhere else.
   * A version of this that never yielded would accept the notification and act
   * on it after the turn had already answered.
   */
  keepGoing(): Promise<boolean>;
}

export interface AdmitRequest {
  /** The plan file the prompt named. Resolved against `repo` when relative. */
  planPath: string;
  repo: string;
  runRoot?: string;
  audience?: Audience;
  overrides?: readonly BridgeOverride[];
  /** Ruling 69: the same override the table describes is the one that resolves. */
  which?: (command: string) => string | null;
}

export interface AdmitOutcome {
  /** True only when the plan was admitted. A refusal is `false` and carries its remedy. */
  admitted: boolean;
  /** The turn was cancelled at a stage boundary and the remaining stages did not run. */
  cancelled: boolean;
  /** Everything the operator would have seen from `brigadier plan`, line by line. */
  lines: string[];
}

/**
 * What the turn tells the client it did NOT do.
 *
 * DEFINED here, because it is a fact about admission; APPENDED by
 * `src/serve/handler.ts`'s `#deliver`, exactly once, around every terminal
 * outcome — and deliberately NOT by any `return` below. It used to be
 * hand-appended at each of the five return sites in this file, and a blind
 * critic found the consequence on the real binary: the sixth site, the catch arm
 * in the handler, had no such line, so a plan that made `validatePlan` throw
 * produced `stopReason: "end_turn"` with no statement that nothing had run. An
 * editor renders that as a completed turn. A property that holds because five
 * sites each remembered is not a property, so the sites no longer hold it.
 *
 * The consequence for a DIRECT caller of `admitPlan`, said out loud rather than
 * left to be discovered: `lines` carries admission's own prose only. Anything
 * reporting an outcome to a human owes the reader this sentence and has to add
 * it, exactly as the turn does.
 */
export const NOTHING_WAS_STARTED =
  "nothing was started: this ACP server admits a plan and stops there. Zero processes, zero clones, zero refs — " +
  "the run root was not created and `executeRun` was not called. Execution over ACP is not wired in this build " +
  "because `executeRun` assumes one run per process; drive the run with `brigadier run --plan <path>` in a terminal.";

/**
 * Run admission, reporting each stage as it starts and finishes.
 *
 * The reporter is called around every stage including the one that fails, so a
 * refused plan leaves the client's task list showing exactly how far it got
 * rather than snapping to all-complete.
 */
export async function admitPlan(request: AdmitRequest, stages: StageReporter): Promise<AdmitOutcome> {
  const repo = absolute(request.repo, process.cwd());
  const planPath = absolute(request.planPath, repo);
  const runRoot = absolute(request.runRoot ?? defaultRunRoot(), repo);
  const audience: Audience = request.audience ?? "acp-client";

  stages.start("read the plan file");
  let spec;
  try {
    spec = parsePlan(readFileSync(planPath, "utf8"), planPath);
  } catch (error) {
    return {
      admitted: false,
      cancelled: false,
      lines: [
        error instanceof PlanUnreadable ? error.message : `could not read ${planPath}: ${String(error)}`,
      ],
    };
  }
  stages.finish("read the plan file");
  if (!(await stages.keepGoing())) return cancelledAt("read the plan file");

  // Ruling 61, before anything is created rather than at the first clone. #41
  // measured the Codex bridge building its sandbox with `/tmp` and `$TMPDIR`
  // writable BY DESIGN. Judged by realpath, never lexically.
  stages.start("check the run root against every temp region (ruling 61)");
  const intendedRoot = intendedRealPath(runRoot);
  if (isTempRooted(intendedRoot, realTempDirs())) {
    return {
      admitted: false,
      cancelled: false,
      lines: [
        `refused — the run root ${intendedRoot} is inside a temp region.`,
        "  Ruling 61: brigadier's run directories live outside every temp root, because #41 measured a",
        "  worker under a temp root writing into another clone's tracked file.",
        `  Remedy: start this server with --run-root somewhere outside it, or omit it and get ${defaultRunRoot()}.`,
      ],
    };
  }
  stages.finish("check the run root against every temp region (ruling 61)");
  if (!(await stages.keepGoing())) return cancelledAt("check the run root against every temp region (ruling 61)");

  stages.start("resolve agents on PATH and validate the plan");
  const which = request.which ?? ((command: string) => Bun.which(command));
  const agents = agentsOnPath(which, request.overrides ?? []);
  const plan = validatePlan(spec, { cwd: repo, agents });
  stages.finish("resolve agents on PATH and validate the plan");
  if (!(await stages.keepGoing())) return cancelledAt("resolve agents on PATH and validate the plan");

  stages.start("admit: refusals, waves and fan-out");
  const admission = admit({
    plan,
    agents,
    // Decision 25's `hostFirst` is about brigadier running INSIDE a host agent's
    // session and sharing that agent's RAM budget. An editor driving this server
    // over stdio is not that: the editor is a client, not an agent holding a
    // context window we are spending. So the reservation is not taken, and the
    // audience is `acp-client` for the same reason.
    hostFirst: false,
  });
  stages.finish("admit: refusals, waves and fan-out");
  if (!(await stages.keepGoing())) return cancelledAt("admit: refusals, waves and fan-out");

  if (admission.refusals.length > 0) {
    return {
      admitted: false,
      cancelled: false,
      lines: describeRefusals(admission.refusals, planPath),
    };
  }

  stages.start("estimate the cost range (ruling 66)");
  const estimate = estimatePlan(
    plan.items,
    admission.fanOut[0]?.workers ?? 1,
    admission.agents.map((agent) => agent.id),
  );
  stages.finish("estimate the cost range (ruling 66)");

  return {
    admitted: true,
    cancelled: false,
    lines: [...describeAdmission(admission, planPath, audience), ...describeEstimate(estimate)],
  };
}

/** The honest tail of a cancelled turn: how far it got, and what that did not cost. */
function cancelledAt(stage: AdmitStage): AdmitOutcome {
  return {
    admitted: false,
    cancelled: true,
    lines: [
      `cancelled after "${stage}". The remaining stages did not run, so this plan was neither admitted nor refused.`,
    ],
  };
}

function absolute(path: string, from: string): string {
  return isAbsolute(path) ? path : resolve(from, path);
}
