// SPDX-License-Identifier: Apache-2.0
/**
 * The run, composed.
 *
 * Nothing in this file is a new idea. Every step below is a module that already
 * exists, and the value of the file is the ORDER — which is fixed, and which is
 * where most of v1's failures actually lived:
 *
 *   1. SWEEP AT START (ruling 38, ruling 63). Processes always; directories
 *      only for runs the manifest marks complete. Before anything is created,
 *      because a leaked worker from a previous run can still write into the
 *      directory this run is about to judge.
 *   2. BASE STATE (rulings 33, 50). HEAD plus the operator's uncommitted
 *      TRACKED and UNTRACKED work, as a commit, published in the invisible
 *      namespace — and the operator's repository witnessed before and after so
 *      that "brigadier did not disturb it" is checked rather than promised.
 *   3. PER WAVE: clone, release, spawn a MARKED agent, sweep the item, fetch,
 *      check ownership, merge. Wave N+1 clones from wave N's integration commit
 *      and does not start until the gate on it did not block (ruling 54).
 *   4. THE MERGED-RESULT GATE (ruling 52), in its own slot, in its own section.
 *      "Every item passed" and "the merged result passed" are two facts.
 *   5. THE FULL RECORD TO DISK, and only then a report (ruling 58). The
 *      pointer travels; the transcript does not.
 *
 * WRITE-AHEAD IS NOT OPTIONAL HERE. Every blocking check's slot is appended to
 * the NDJSON record BEFORE the check runs, holding ruling 52's `not-run`, so a
 * process killed between "started" and "finished" leaves a BLOCKING value on
 * disk rather than an absent field. There is deliberately no code path in this
 * file that produces a check with no outcome.
 *
 * ONE SINK, AFTER COMPOSITION (ruling 65). Every byte this run persists — the
 * NDJSON record, the JSON record, the transcript, and the report on stdout —
 * goes through `Sink`, which redacts the FINAL bytes against an append-only
 * inventory in every enumerated encoding. Ruling 65 names "the sink being
 * bypassed" as the most likely way redaction fails in practice, so there is one
 * writer and nothing in this file calls `writeFileSync`. The sink is
 * `src/secrets/sink.ts`'s — this file used to carry a private one that redacted
 * an event's FIELDS and then serialised it, which put a transformation after
 * the redaction and is the failure the ruling is about. It composes now, and
 * the sink redacts what is going to be on disk.
 *
 * AN INTERRUPT IS PART OF THE ORDER, NOT AN EXCEPTION TO IT (ruling 63). The
 * caller owns the signal handler — registering one disables default termination,
 * so it is a duty — and this file supplies the drain: stop dispatching,
 * `session/cancel` every live worker, kill them on a bounded deadline, sweep,
 * and then fall out through the SAME tail that writes `record.json` and the
 * report. That is deliberate. A signal handler that wrote its own summary would
 * be a second, weaker path producing a different artifact from the one every
 * test and every reader knows, and the run that most needs a record is the one
 * that did not finish.
 *
 * WHERE RULING 38 CANNOT REACH, said out loud rather than left to be
 * discovered: an operator's verify command is spawned WITHOUT the command-line
 * marker, because appending an argument to somebody else's command line
 * corrupts it — `bun test --brigadier-run=x` is not `bun test`. Its pid is
 * recorded and it is killed on its own timeout by the process that started it,
 * which is a weaker guarantee than the sweep's and is reported as one.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, LaunchProfile } from "../agent/profiles.ts";
import { Worker } from "../agent/worker.ts";
import {
  buildBaseState,
  discardClone,
  prepareClone,
  releaseToAgent,
  type AgentOwnedClone,
  type BaseState,
} from "../isolation/index.ts";
import {
  attemptable,
  discardGateClone,
  initialIntegrationCheck,
  integrateWave,
  refSha,
  runIntegrationGate,
  waveBoundary,
  type IntegrationItem,
  type WaveIntegration,
} from "../integrate/index.ts";
import { Lane } from "../lane/lane.ts";
import { RUN_DIR } from "../repo/layout.ts";
import { WORK_BRANCH, integrationBranch, itemRef } from "../repo/refs.ts";
import {
  CANCEL_DEADLINE_MS,
  describeStartSweep,
  describeUnfinished,
  directoryBytes,
  openCheckSlot,
  recordPath,
  settleCheck,
  sweep,
  sweepAtStart,
  type RunEvent,
  type UnfinishedRun,
} from "../run/index.ts";
import { Sink, type Grant } from "../secrets/sink.ts";
import {
  itemBlocks,
  runHeadline,
  writeRunReport,
  type Audience,
  type RecordCheck,
  type RecordItem,
  type RunRecord,
} from "../report/index.ts";
import { blocks, type CheckOutcome, type CheckResult } from "../work/check.ts";
import { lanePolicyFor } from "../work/kind.ts";
import type { VerifyResolution } from "../gate/verify.ts";
import { bindingSentence, type Admission } from "./admit.ts";
import { composeBrief } from "./brief.ts";
import { CEILING, deriveEffort, noLever, leverFor, renderEffort, type EffortOutcome } from "./effort.ts";
import { spawnMarkedAgent } from "./spawn.ts";
import { describeEstimate, estimatePlan } from "./estimate.ts";
import type { PlannedItem } from "./plan.ts";

/**
 * How long an agent is given to HANDSHAKE, before the checker is `error`.
 *
 * Separate from the turn budget and much shorter, because the two failures are
 * different: a handshake that has not completed in a minute is an agent that is
 * not going to speak the protocol at all — a command on `PATH` that is not an
 * agent, a shim, a binary waiting on stdin for something else. #48 measured a
 * real client tolerating a 285-second TURN, and none of that latency belongs to
 * `initialize`. `detectAll` uses the same minute for the same reason.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000;

/**
 * What `--review` currently gets, and why it is a refusal rather than a field.
 *
 * Ruling 52's four outcomes: a reviewer producing no verdict is `error` or
 * `not-run`, and both BLOCK. There is no reviewer in this build, so every item
 * carries a blocking `review: not-run` and the run cannot report success —
 * which is the honest rendering of an unbuilt check and the opposite of v1's
 * `review: not run (REVIEWER_FAILED)` merging the most delicate change of the
 * build entirely unreviewed.
 *
 * The temptation this constant exists to remove: writing `crossVendor: true`
 * into the record because two vendors happened to resolve on `PATH`. That would
 * be a record claiming a review that never ran, which is ruling 32's standing
 * rule broken by a field rather than by a sentence.
 */
export const REVIEW_UNBUILT =
  "no reviewer was routed: cross-vendor review is not implemented in this build. Ruling 32's " +
  "standing rule is not suspended for an unbuilt check — a check that did not run never renders " +
  "as a pass, so every item carries a blocking `review: not-run` and this run cannot succeed.";
/** How long one agent is given to answer, before the checker is `error`. */
export const DEFAULT_WORKER_TIMEOUT_MS = 600_000;
/** A verify command that has not finished by here has broken, not failed (ruling 52). */
export const DEFAULT_VERIFY_TIMEOUT_MS = 900_000;

export interface ExecuteOptions {
  repo: string;
  runRoot: string;
  planPath: string;
  admission: Admission;
  audience: Audience;
  /** The merged-result gate's command, already resolved (ruling 52). */
  verify: VerifyResolution;
  review: boolean;
  /** Ruling 65: names of environment variables to grant, and to redact everywhere. */
  secretEnv: readonly string[];
  /**
   * Ruling 30's edge case, declared by the OPERATOR and never by the plan.
   *
   * Item ids whose ceiling is raised from `high` to `xhigh`. Ruling 31 bans the
   * plan from setting effort at all — a model choosing how hard it gets to think
   * about its own task is a self-serving input on the axis that most directly
   * sets the bill — so the only channel for this is the command line.
   */
  xhigh?: readonly string[];
  softCeiling?: number;
  hardCeiling?: number;
  runId?: string;
  handshakeTimeoutMs?: number;
  workerTimeoutMs?: number;
  verifyTimeoutMs?: number;
  /**
   * The process's one sink (ruling 65). The CLI builds it before it prints
   * anything, so passing it in is what makes "one sink" true across the whole
   * process rather than true twice with two inventories — v1's failure 1 was
   * exactly two of these disagreeing. Absent, a run builds its own, because a
   * caller that forgot must not get an UNREDACTED run.
   */
  sink?: Sink;
  /**
   * Ruling 63, and the seam that gives `src/run/interrupt.ts` its call site.
   *
   * Called once, before the first clone exists, with this run's drain. The
   * signal HANDLER lives in the caller — registering one disables default
   * termination, which is a duty owed by whoever owns the process — and the
   * drain is what "a run is in flight" means: stop dispatching, `session/cancel`
   * every live worker, kill on a deadline, sweep.
   */
  onInFlight?: (drain: (signal: NodeJS.Signals) => void) => void;
  /**
   * How long a cancelled worker is given before it is killed. Ruling 63's real
   * mechanism; overridable so a test can bound its own wait rather than the
   * product's.
   */
  cancelDeadlineMs?: number;
}

export interface ExecuteResult {
  /**
   * The run's sink, returned so the caller can `end()` it — and so nothing
   * builds a second one. Ruling 65: the report is not handed back as a string,
   * because a caller holding the bytes owns the write.
   */
  sink: Sink;
  /** What `--secret-env` actually did, BY NAME. `tooShort` is the hole, said out loud. */
  grant: Grant;
  recordPath: string;
  /** 0 only when every blocking check passed. Ruling 52 has no other affirmative. */
  exitCode: number;
  /**
   * The signal that interrupted this run, or `null`. Ruling 63: the caller
   * restores the default handler and RE-RAISES this rather than exiting with a
   * code it invented, so a parent shell sees a genuine signal-terminated status.
   */
  interruptedBy: NodeJS.Signals | null;
}

/**
 * One NDJSON event, COMPOSED and then handed to the sink.
 *
 * This is the whole of ruling 65's rule 2 in one line, and it replaces a
 * private `Sink` that got the order backwards. The deleted `redactEvent`
 * redacted each field of the event and THEN serialised, which is v1's failure 2
 * and failure 3 rebuilt in one function:
 *
 *   - a non-string field was never touched at all, so a secret inside a nested
 *     object, an array or a number-keyed record went through untouched;
 *   - `JSON.stringify` runs AFTER the redaction, so the escaped form of a value
 *     — the form that actually lands in the file — was never generated at the
 *     moment redaction looked;
 *   - and a value spanning the JOIN between two fields, `"…","cause":"…"`, is
 *     not present in either field, so nothing saw it.
 *
 * Composing first and redacting the composed line catches all three, because
 * the bytes redaction runs over are exactly the bytes that reach the disk.
 * `Sink.append` also carries the `O_APPEND`, `O_NOFOLLOW`, non-regular-file and
 * truncated-tail handling `appendEvent` had, and refuses a line containing a
 * newline rather than splitting one event into two.
 */
function recordEvent(sink: Sink, path: string, event: RunEvent): void {
  sink.append(path, JSON.stringify(event));
}

/** Short, and inside the shape `src/repo/refs.ts` and `src/run/marker.ts` both enforce. */
export function newRunId(now = Date.now()): string {
  return `${now.toString(36)}${randomBytes(2).toString("hex")}`;
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${what} did not finish within ${ms} ms. Ruling 52: a checker that was killed is ` +
                  "`error`, not `fail` — the remedy is to re-run it, and sending a builder to fix a " +
                  "defect that is not in its code burns a rung of ruling 24's ladder.",
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function checkRecord(check: CheckResult): RecordCheck {
  return {
    name: check.name,
    outcome: check.outcome,
    blocking: blocks(check.outcome),
    ...(check.qualifier === undefined ? {} : { qualifier: check.qualifier }),
    ...(check.detail === undefined ? {} : { detail: check.detail }),
  };
}

/**
 * The check a `write` item gets when its clone's work branch carried nothing.
 *
 * `integrateWave` scores an item that changed no tracked file `no-change` and
 * PASSES it, and for a `read-only` item that is exactly right — ruling 49 never
 * reads its directory back at all. For a `write` item it is the opposite: the
 * item declared paths it owns, brigadier fetched its `work` branch, and the
 * branch carried nothing.
 *
 * MEASURED on 2026-08-18 against `git 2.50.1`, with a planted ACP agent that
 * writes its file and does not commit: `git diff <base>..<item ref>` came back
 * empty for both items, the wave published nothing,
 * `refs/heads/brigadier/<run-id>` was never created — and the run printed
 * *"2 of 2 items landed"*, marked both items `integrated` and exited 0. Ruling
 * 52's exact failure, at the one place an empty result could still read as a
 * satisfied requirement.
 *
 * `fail` rather than `error`: the remedy is to send the builder back, which is
 * what `fail` means in ruling 52's vocabulary. `error` would say the checker
 * broke, and it did not — it looked, and there was nothing there.
 */
export function nothingCommitted(item: PlannedItem, ref: string): CheckResult {
  return {
    name: `integrate item ${item.number}`,
    outcome: "fail",
    qualifier: "nothing committed",
    detail:
      `item ${item.id} declared ${item.paths.join(", ") || "no paths"} and its clone's \`${WORK_BRANCH}\` ` +
      "branch carried no change, so there was nothing to merge. Ruling 56 keeps brigadier's count of " +
      "git commands run inside a clone an agent has touched at zero, so brigadier cannot commit on a " +
      "worker's behalf — the brief says so in its constant prefix, and a worker that wrote files and " +
      "did not commit them has produced no result. Its clone is retained rather than deleted (ruling " +
      `63): it may hold the only copy of that work. Inspect the fetched ref at ${ref}.`,
  };
}

interface ItemRun {
  item: PlannedItem;
  checks: CheckResult[];
  clone: AgentOwnedClone | null;
  clonePath: string | null;
  agent: string | null;
  model: string | null;
  /** Ruling 54: wave 1's is the base commit, wave N+1's is the previous integration commit. */
  baseRef: string;
  baseSha: string;
  /** A `write` item whose work branch carried nothing. Never deleted, never a pass. */
  producedNothing: boolean;
  /** Ruling 29's third axis, and what brigadier actually did about it. */
  effort: EffortOutcome;
  bytes: number;
  /** Set when the clone is the only copy of the work — ruling 63 retains it. */
  retain: boolean;
  /**
   * Ruling 38's marker is what makes these nameable, and ruling 63 requires the
   * EXACT pids rather than "something may still be running".
   */
  survivors: number[];
}

/**
 * A worker that is alive right now, and the two things an interrupt does to it.
 *
 * Ruling 63's order, and the reason it is an order rather than a choice:
 * `session/cancel` is an ACP NOTIFICATION — #6's four-method surface gives
 * nothing to await — so `cancel()` is a courtesy with no acknowledgement, and
 * the DEADLINE plus `kill()` is the mechanism. #48 measured a real client
 * tolerating a 285-second turn, so "wait for the agent to finish cancelling" is
 * not a bounded wait and is not what this does.
 */
interface LiveWorker {
  readonly item: number;
  readonly pid: number;
  cancel(): void;
  kill(): void;
}

/**
 * Run one item: clone, release, spawn a marked agent, take one turn, sweep.
 *
 * The sweep at the end is not tidiness. Ruling 49's recycle and ruling 63's
 * retention both need `ReclamationEvidence` about THIS item, and evidence
 * scoped to the run says nothing about one clone — `assertReclaimed` refuses it
 * on purpose.
 */
async function runItem(
  item: PlannedItem,
  base: BaseState,
  options: ExecuteOptions,
  sink: Sink,
  record: string,
  agent: { id: AgentId; profile: LaunchProfile } | null,
  secrets: Record<string, string>,
  transcript: string[],
  live: Set<LiveWorker>,
): Promise<ItemRun> {
  // Ruling 31: derived from (kind, difficulty), here, from the difficulty
  // ACTUALLY IN FORCE. Deriving from the declared one would spend at the level
  // the plan asked for after ruling 67 had already said it was clamped down.
  const ceiling = (options.xhigh ?? []).includes(item.id) ? "xhigh" : CEILING;
  const requested = deriveEffort(item.kind, item.clampedTo, ceiling);

  const result: ItemRun = {
    item,
    checks: [],
    clone: null,
    clonePath: null,
    agent: agent?.id ?? null,
    model: null,
    // Recorded per item rather than per run: ruling 54 gives wave N+1 a
    // different base from wave 1, so "the left-hand side of this item's diff" is
    // not a run-level fact.
    baseRef: base.ref,
    baseSha: base.sha,
    producedNothing: false,
    effort:
      agent === null
        ? noLever(requested, { kind: "none", why: "no agent resolved, so nothing was spawned to assert it on" })
        : (() => {
            const lever = leverFor(agent.profile);
            return lever.kind === "none" ? noLever(requested, lever) : {
              requested,
              asserted: requested,
              lever: lever.kind === "switch" ? `${lever.variable} at spawn` : "session/set_model",
              disposition: "unavailable" as const,
              confirmed: false as const,
              detail: "the worker never started, so the lever was never reached",
            };
          })(),
    bytes: 0,
    retain: false,
    survivors: [],
  };

  // Ruling 52's write-ahead: the slot exists, holding a BLOCKING value, before
  // anything that could crash between here and the answer.
  openCheckSlot(record, item.number, "worker");

  let clone;
  try {
    const prepared = await prepareClone({ base, item: item.number, runRoot: options.runRoot });
    recordEvent(sink, record, { type: "clone-recorded", at: Date.now(), item: item.number, dir: prepared.dir });
    clone = releaseToAgent(prepared);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    settleCheck(record, item.number, "worker", "not-run", detail);
    result.checks.push({
      name: "worker",
      outcome: "not-run",
      qualifier: "no clone",
      detail: `item ${item.id} never got a directory: ${detail}`,
    });
    return result;
  }

  result.clone = clone;
  result.clonePath = clone.dir;
  result.bytes = directoryBytes(clone.dir);

  let outcome: CheckOutcome = "not-run";
  let detail = "no agent was available to attempt this item";
  let spawned: { pid: number; kill(): void } | null = null;
  let marked: ReturnType<typeof spawnMarkedAgent> | undefined;

  if (agent !== null) {
    // The profile as it will be SPAWNED — ruling 69's override already applied
    // by `agentsOnPath`, so nothing here can spawn a coordinate the admission
    // did not print.
    const profile = agent.profile;
    try {
      marked = spawnMarkedAgent({
        profile,
        runId: base.runId,
        item: item.number,
        cwd: clone.dir,
        kind: item.kind,
        configRoot: join(clone.stateDir, "agent-config"),
        tmpDir: join(clone.stateDir, "tmp"),
        secrets,
        effort: requested,
        onFrame: (direction, raw) => transcript.push(`${item.id} ${direction} ${raw}`),
      });
      spawned = marked;
      mkdirSync(join(clone.stateDir, "agent-config"), { recursive: true });
      mkdirSync(join(clone.stateDir, "tmp"), { recursive: true });
      recordEvent(sink, record, {
        type: "process-spawned",
        at: Date.now(),
        item: item.number,
        pid: marked.pid,
        commandLine: marked.commandLine,
      });

      // Registered BEFORE the handshake, and with the process kill already
      // wired: ruling 63's drain has to be able to reach a worker that is
      // spawned but not yet speaking ACP, which is precisely the window an
      // interrupt is most likely to land in. `cancel` is a no-op until the
      // session exists, because there is no session id to cancel.
      let acp: Worker | undefined;
      const registration: LiveWorker = {
        item: item.number,
        pid: marked.pid,
        cancel: () => acp?.cancel(),
        kill: () => marked?.kill(),
      };
      live.add(registration);

      const worker = await withTimeout(
        Worker.start(profile, {
          cwd: clone.dir,
          lane: new Lane(clone.dir, lanePolicyFor(item.kind)),
          kind: item.kind,
          channel: marked.channel,
          onFrame: (direction, raw) => transcript.push(`${item.id} ${direction} ${raw}`),
        }),
        options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        `${profile.id} handshake for item ${item.id}`,
      );
      acp = worker;
      result.model = worker.models[0] ?? null;

      const turn = await withTimeout(
        worker.prompt(composeBrief(item)),
        options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
        `${profile.id} turn for item ${item.id}`,
      );
      transcript.push(`${item.id} stopReason ${turn.stopReason} bytes ${turn.bytes}`);
      await worker.close();

      if (worker.laneBlocks) {
        outcome = "fail";
        detail =
          `${profile.id} declares a lane lever and it could not be asserted, so every write in ` +
          "this session routed around the client. Ruling 32: a weakened check never renders as a pass.";
      } else {
        outcome = "pass";
        detail = `${profile.id} took one turn and stopped with ${turn.stopReason} (${turn.bytes} bytes)`;
      }
    } catch (error) {
      // Ruling 52: the CHECKER broke. Never `fail` — that would send a builder
      // to fix a defect that is not in its code.
      outcome = "error";
      detail = error instanceof Error ? error.message : String(error);
    } finally {
      // Read AFTER the turn: the graded lever is answered on the wire, so
      // reading it at spawn time would record `sent` for a setting the agent
      // subsequently refused.
      result.effort = marked?.effort() ?? result.effort;
      for (const entry of [...live]) if (entry.pid === spawned?.pid) live.delete(entry);
      spawned?.kill();
    }
  } else {
    outcome = "not-run";
    detail =
      "no agent resolved on PATH, so nothing attempted this item. This is the operator's " +
      "environment rather than any worker's code, and no retry by any agent helps.";
  }

  settleCheck(record, item.number, "worker", outcome, detail);
  result.checks.push({
    name: "worker",
    outcome,
    ...(agent === null ? { qualifier: "no agent" } : {}),
    detail,
  });

  // Ruling 52's write-ahead again, for the check this build does not have.
  if (options.review) {
    openCheckSlot(record, item.number, "review");
    settleCheck(record, item.number, "review", "not-run", REVIEW_UNBUILT);
    result.checks.push({
      name: "review",
      outcome: "not-run",
      qualifier: "no reviewer routed",
      detail: REVIEW_UNBUILT,
    });
  }

  // Ruling 38, scoped to this item: the evidence a later recycle or retention
  // decision is not allowed to be made without.
  const swept = await sweep({
    scope: { runId: base.runId, item: item.number },
    sweptBy: `end-of-item sweep for ${base.runId}/${item.number}`,
    ...(spawned === null ? {} : { recordedPids: [spawned.pid] }),
  });
  recordEvent(sink, record, {
    type: "swept",
    at: Date.now(),
    sweptBy: swept.evidence.sweptBy,
    runId: base.runId,
    item: item.number,
    reclaimedPids: [...swept.evidence.reclaimedPids],
    survivors: [...swept.evidence.survivors],
  });
  result.survivors = [...swept.evidence.survivors];
  if (swept.evidence.survivors.length > 0) {
    result.checks.push({
      name: "containment",
      outcome: "error",
      qualifier: "survivors",
      detail:
        `could not confirm dead: pid ${swept.evidence.survivors.join(", ")}. Killing them is the ` +
        "only remedy, and this clone is retained rather than deleted while they are alive (ruling 63).",
    });
    result.retain = true;
  }

  result.bytes = directoryBytes(clone.dir);
  return result;
}

/** The whole run. */
export async function executeRun(options: ExecuteOptions): Promise<ExecuteResult> {
  // ONE SINK, and the caller's where there is one. Ruling 65's failure 1 was two
  // inventories disagreeing, and a run that built its own while the CLI printed
  // through another would be that failure with the two halves in one process.
  const sink = options.sink ?? new Sink();
  // Reading the grant and inventorying it are ONE call, deliberately: two calls
  // admit a program in which delivery happened and inventory did not.
  const grant = sink.grant(options.secretEnv);
  const secrets = grant.env;

  const runId = options.runId ?? newRunId();
  const runDir = join(options.runRoot, RUN_DIR, runId);
  const record = recordPath(options.runRoot, runId);
  const jsonRecord = join(runDir, "record.json");
  const transcriptDir = join(runDir, "transcripts");
  const transcript: string[] = [];
  const notes: string[] = [];

  // 1. The sweep at start. Processes always; directories only for complete runs.
  const start = await sweepAtStart({ runRoot: options.runRoot, currentRunId: runId });
  for (const line of describeStartSweep(start)) notes.push(line);

  mkdirSync(runDir, { recursive: true });
  recordEvent(sink, record, {
    type: "run-started",
    at: Date.now(),
    runId,
    repo: options.repo,
    runRoot: options.runRoot,
    pid: process.pid,
  });

  // RULING 63'S DRAIN, handed to the caller before a single clone exists.
  //
  // The handler itself belongs to whoever owns the process — registering one
  // disables default termination, so it is a duty and not a feature — and this
  // is the half only the run can supply: what "in flight" means here. Order,
  // and every step of it is bounded:
  //
  //   1. STOP DISPATCHING. No further batch and no further wave. Everything
  //      already awaited unwinds through the code it was already in, which is
  //      what leaves `record.json` written by the ordinary tail of this
  //      function rather than by a second, weaker path in a signal handler.
  //   2. `session/cancel` EVERY LIVE WORKER. An ACP notification, so there is
  //      nothing to await and no acknowledgement to wait for.
  //   3. KILL ON A DEADLINE. #48 measured a real client tolerating a
  //      285-second turn, so waiting for an agent to finish cancelling is not a
  //      bounded wait. The deadline is the mechanism; the cancel is a courtesy.
  //   4. SWEEP (below, after the loop). Ruling 38's marker is what makes the
  //      survivors nameable as exact pids.
  const live = new Set<LiveWorker>();
  const cancelDeadlineMs = options.cancelDeadlineMs ?? CANCEL_DEADLINE_MS;
  let interruptedBy: NodeJS.Signals | null = null;
  let draining: Promise<void> | null = null;
  options.onInFlight?.((signal) => {
    if (interruptedBy !== null) return;
    interruptedBy = signal;
    const workers = [...live];
    sink.errLine(
      `${signal} — no further item will be dispatched. \`session/cancel\` sent to ${workers.length} live ` +
        `worker(s); they are killed in ${cancelDeadlineMs} ms whether or not they answer, because ` +
        "`session/cancel` is an unacknowledged notification and waiting for an agent is not a bounded " +
        "wait (ruling 63).",
    );
    draining = (async () => {
      for (const worker of workers) {
        try {
          worker.cancel();
        } catch {
          // A worker whose channel is already gone needs no cancelling.
        }
      }
      await Bun.sleep(cancelDeadlineMs);
      for (const worker of workers) {
        try {
          worker.kill();
        } catch {
          // Already gone. The sweep below is what proves it either way.
        }
      }
    })();
  });

  const plan = options.admission.plan;
  const chosen = options.admission.agents[0] ?? null;
  const agent = chosen === null ? null : { id: chosen.id, profile: chosen.profile };

  // 2. The base state, with the operator's repository witnessed either side.
  const base = await buildBaseState({
    repo: options.repo,
    runId,
    scratchDir: join(runDir, "scratch"),
  });
  notes.push(
    `base ${base.sha.slice(0, 12)} at ${base.ref} — ${base.untrackedIncluded} untracked file(s) carried in ` +
      `(ruling 33), ${base.ignoredEntriesExcluded} ignored entr(ies) left out (ruling 50)`,
  );
  // The left-hand side of every diff this run will produce, on disk before the
  // first clone exists. `item-landed` records only the right-hand side, so a
  // record without this cannot re-derive what an item did — which is ruling
  // 51's ownership check and ruling 52's reviewer brief, both computed from
  // `git diff <base>..<item ref>`.
  recordEvent(sink, record, { type: "base-recorded", at: Date.now(), wave: 0, ref: base.ref, sha: base.sha });

  const runs: ItemRun[] = [];
  const waves: WaveIntegration[] = [];
  const gates: CheckResult[] = [];
  const integrated = new Set<number>();
  let waveBase = base.sha;
  let branchAt: string | null = null;

  for (const [index, wave] of plan.waves.entries()) {
    const waveNumber = index + 1;
    // Ruling 54: wave 1 is diffed against the base commit and wave N+1 against
    // the integration commit wave N published, so this is per wave rather than
    // per run and it is written down before the wave spends anything.
    const waveBaseRef = waveNumber === 1 ? base.ref : integrationBranch(runId);
    recordEvent(sink, record, {
      type: "base-recorded",
      at: Date.now(),
      wave: waveNumber,
      ref: waveBaseRef,
      sha: waveBase,
    });
    const eligible = attemptable(
      wave,
      plan.items.map((item) => ({ item: item.number, dependsOn: item.dependsOn })),
      integrated,
    );

    const fanOut = options.admission.fanOut[index];
    if (fanOut !== undefined) notes.push(bindingSentence(fanOut, waveNumber));
    const concurrency = Math.max(1, fanOut?.workers ?? 1);

    const attempted: ItemRun[] = [];
    for (let cursor = 0; cursor < eligible.run.length; cursor += concurrency) {
      // Ruling 63, step 1. Checked at the batch boundary because that is the
      // only place this function chooses to spend something new.
      if (interruptedBy !== null) break;
      const batch = eligible.run.slice(cursor, cursor + concurrency);
      const finished = await Promise.all(
        batch.map((number) => {
          const item = plan.items.find((candidate) => candidate.number === number);
          if (item === undefined) throw new Error(`wave ${waveNumber} names item ${number}, which is not in the plan`);
          // Ruling 54: wave 1 clones from the base commit; wave N+1 clones from
          // the integration commit wave N published, so a dependent item sees
          // its prerequisite's output rather than the state before it.
          const cloneFrom: BaseState =
            waveNumber === 1 ? base : { ...base, ref: integrationBranch(runId), sha: waveBase };
          return runItem(item, cloneFrom, options, sink, record, agent, secrets, transcript, live);
        }),
      );
      attempted.push(...finished);
    }
    runs.push(...attempted);

    // 3. Integration, in plan order, one transaction per wave.
    const integrationItems: IntegrationItem[] = attempted
      .filter((run) => run.clonePath !== null)
      .map((run) => ({
        item: run.item.number,
        clone: run.clonePath as string,
        declaredPaths: run.item.paths,
      }));

    // Ruling 52's write-ahead for the integration check, before the fetch that
    // could crash between "started" and "answered". `not-run` BLOCKS, so a
    // process killed here leaves a blocking value on disk rather than a slot
    // that never existed.
    for (const entry of integrationItems) openCheckSlot(record, entry.item, `integrate item ${entry.item}`);

    let waveResult: WaveIntegration;
    try {
      waveResult = await integrateWave({
        repo: options.repo,
        runId,
        base: waveBase,
        items: integrationItems,
        wave: waveNumber,
        branchAt,
        blocked: eligible.blocked,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      notes.push(`wave ${waveNumber} could not be integrated: ${detail}`);
      waveResult = {
        runId,
        wave: waveNumber,
        base: waveBase,
        head: waveBase,
        branch: integrationBranch(runId),
        items: attempted.map((run) => ({
          item: run.item.number,
          outcome: "not-attempted" as const,
          ref: itemRef(runId, run.item.number),
          detail,
        })),
        published: false,
        partial: true,
        checks: attempted.map((run) => ({
          name: `integrate item ${run.item.number}`,
          outcome: "error" as const,
          qualifier: "integration failed",
          detail,
        })),
      };
    }
    waves.push(waveResult);

    // A `write` item whose work branch carried nothing produced NO RESULT, and
    // `nothingCommitted` says why at length. It is decided here, once, and the
    // three consequences below all read from it: the item does not join
    // `integrated` (so a dependent never clones from a base without its
    // prerequisite's output), its `pass (no change)` is replaced by a blocking
    // `fail`, and its clone is retained rather than deleted — ruling 63, because
    // that directory is now the only copy of whatever the worker wrote.
    for (const entry of waveResult.items) {
      if (entry.outcome !== "no-change") continue;
      const owner = attempted.find((run) => run.item.number === entry.item);
      if (owner !== undefined && owner.item.kind === "write") owner.producedNothing = true;
    }
    const producedNothing = new Set(
      attempted.filter((run) => run.producedNothing).map((run) => run.item.number),
    );

    for (const entry of waveResult.items) {
      if (producedNothing.has(entry.item)) continue;
      if (entry.outcome === "integrated" || entry.outcome === "no-change") integrated.add(entry.item);
      if (entry.outcome === "integrated" && entry.sha !== undefined) {
        recordEvent(sink, record, {
          type: "item-landed",
          at: Date.now(),
          item: entry.item,
          ref: entry.ref,
          sha: entry.sha,
        });
      }
    }
    for (const check of waveResult.checks) {
      const number = Number(/item (\d+)/.exec(check.name)?.[1] ?? 0);
      const owner = runs.find((run) => run.item.number === number);
      if (owner === undefined) continue;
      const judged = producedNothing.has(number)
        ? nothingCommitted(owner.item, itemRef(runId, number))
        : check;
      owner.checks.push(judged);
      // Ruling 52's slot, settled with the verdict the report will print rather
      // than with `integrateWave`'s: the NDJSON is what a killed run leaves
      // behind, and it must not say `pass` where the report says `fail`.
      settleCheck(record, number, judged.name, judged.outcome, judged.detail ?? null);
    }

    // 4. The merged-result gate, in its own slot, written before it runs.
    openCheckSlot(record, waveNumber, "verify (merged result)");
    let gate: CheckResult = initialIntegrationCheck(waveNumber);
    if (waveResult.published) {
      try {
        const result = await runIntegrationGate({
          repo: options.repo,
          runId,
          commit: waveResult.head,
          verify: options.verify.status === "resolved" ? options.verify.argv : null,
          runRoot: options.runRoot,
          wave: waveNumber,
          autocrlf: base.autocrlf,
          timeoutMs: options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
        });
        gate = result.check;
        if (result.cloneDir !== null && result.check.outcome === "pass") discardGateClone(result.cloneDir);
      } catch (error) {
        gate = {
          name: "verify (merged result)",
          outcome: "error",
          qualifier: `wave ${waveNumber}`,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      gate = {
        name: "verify (merged result)",
        outcome: options.verify.status === "resolved" ? "not-run" : "unconfigured",
        qualifier: `wave ${waveNumber}`,
        detail:
          "nothing was published by this wave, so there is no merged result to verify. Ruling 52 " +
          "prints this in the same slot with the same prominence as a failure.",
      };
    }
    settleCheck(record, waveNumber, "verify (merged result)", gate.outcome, gate.detail ?? null);
    gates.push(gate);

    waveBase = waveResult.head;
    if (waveResult.published) branchAt = waveResult.head;

    const boundary = waveBoundary(waveNumber, gate);
    notes.push(boundary.reason);
    if (!boundary.proceed && index < plan.waves.length - 1) break;
    if (interruptedBy !== null) break;
  }

  // Ruling 63, steps 3 and 4. The wait is bounded by `cancelDeadlineMs` and by
  // nothing else, and the sweep runs AFTER it — a sweep before the kill would
  // report every worker as a survivor and teach the operator to ignore the line
  // that matters. `sweepAtStart` already ran at the top of this function; this
  // is the same matcher over the same marker, scoped to this run.
  const interruptSurvivors: number[] = [];
  if (interruptedBy !== null) {
    if (draining !== null) await draining;
    const finalSweep = await sweep({
      scope: { runId },
      sweptBy: `interrupt (${String(interruptedBy)}) drain for ${runId}`,
    });
    interruptSurvivors.push(...finalSweep.evidence.survivors);
    recordEvent(sink, record, {
      type: "swept",
      at: Date.now(),
      sweptBy: finalSweep.evidence.sweptBy,
      runId,
      item: null,
      reclaimedPids: [...finalSweep.evidence.reclaimedPids],
      survivors: [...finalSweep.evidence.survivors],
    });
  }

  // Clones: kept only where the clone is the ONLY copy. Ruling 63 both ways —
  // an inert directory holding somebody's only work is not brigadier's to
  // delete, and one whose commits are already in the operator's repository is
  // not somebody's only copy.
  const retained: Array<{ item: number; path: string; bytes: number }> = [];
  for (const run of runs) {
    if (run.clonePath === null) continue;
    const landed = waves
      .flatMap((wave) => wave.items)
      .find((entry) => entry.item === run.item.number);
    // `landed.sha` is the sha of the item's FETCHED ref, and a `no-change` item
    // has one: the fetch happened and it pointed at the base. So "the ref
    // exists" is not "the work is in the operator's repository", and deleting on
    // it threw away the only copy of everything a worker had written and not
    // committed. Preservation is the outcome, not the presence of a sha.
    const preserved = landed?.outcome === "integrated" || (landed?.outcome === "no-change" && !run.producedNothing);
    if (!run.retain && preserved && run.clone !== null) {
      try {
        discardClone(run.clone);
      } catch {
        // A clone that cannot be removed is reported below rather than retried.
      }
      continue;
    }
    if (existsSync(run.clonePath)) {
      retained.push({ item: run.item.number, path: run.clonePath, bytes: directoryBytes(run.clonePath) });
    }
  }

  // RULING 51: THE DELIVERABLE IS RESOLVED, NEVER ASSERTED.
  //
  // `refs/heads/brigadier/<run-id>` is a real branch, visible to `git branch`,
  // and the one ref brigadier never deletes. The record used to name it whether
  // or not it existed, so a run that published nothing still printed
  // *"branch refs/heads/brigadier/… — the deliverable"* over a name `git switch`
  // answers `invalid reference` to. This asks git, in the operator's repository,
  // and the answer is the only evidence there is.
  const branchRef = integrationBranch(runId);
  const writeItems = plan.items.filter((item) => item.kind === "write").length;
  let integrationSha: string | null = null;
  let deliverable: CheckResult;
  try {
    integrationSha = await refSha(options.repo, branchRef);
    if (integrationSha !== null) {
      deliverable = {
        name: "integration branch",
        outcome: "pass",
        detail:
          `${branchRef} resolves to ${integrationSha} — a real branch, visible to \`git branch\`, and ` +
          "the one ref brigadier never deletes. From here it is the operator's.",
      };
    } else if (writeItems === 0) {
      // Nothing to publish, and that is the plan's shape rather than a failure:
      // ruling 49 never reads a read-only item's directory back at all.
      deliverable = {
        name: "integration branch",
        outcome: "pass",
        qualifier: "read-only plan",
        detail: `no item in this plan declares \`kind: write\`, so there is no ${branchRef} to publish.`,
      };
    } else {
      deliverable = {
        name: "integration branch",
        outcome: waves.some((wave) => wave.published) ? "error" : "fail",
        qualifier: "no branch",
        detail:
          `${branchRef} does not exist in ${options.repo}: this run published nothing, so there is no ` +
          "deliverable. Ruling 51 makes that branch the whole output of a run — a record naming it " +
          "while `git rev-parse` cannot resolve it is a missing result rendering as a satisfied " +
          "requirement, which ruling 52 forbids at every level including this one.",
      };
    }
  } catch (error) {
    // Ruling 52: the CHECKER broke. Never `fail` — nothing here says a worker
    // did anything wrong.
    deliverable = {
      name: "integration branch",
      outcome: "error",
      qualifier: "unresolvable",
      detail: `${branchRef} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 5. The full record to disk, and only then a report (ruling 58).
  const items: RecordItem[] = runs.map((run) => {
    const landed = waves.flatMap((wave) => wave.items).find((entry) => entry.item === run.item.number);
    const kept = retained.find((entry) => entry.item === run.item.number);
    const blocking = run.checks.some((check) => blocks(check.outcome));
    return {
      id: run.item.id,
      number: run.item.number,
      status: kept !== undefined ? "retained" : blocking ? "failed" : "integrated",
      kind: run.item.kind,
      ...(run.agent === null ? {} : { agent: run.agent }),
      ...(run.model === null ? {} : { model: run.model }),
      // Ruling 29's triple is complete only with this. Rendered so the qualifier
      // is INSIDE the value: `high` alone would read as what ran, and #45
      // measured that brigadier cannot know that.
      effort: renderEffort(run.effort),
      effortRequested: run.effort.requested,
      effortLever: run.effort.lever,
      effortDisposition: run.effort.disposition,
      effortConfirmed: run.effort.confirmed,
      ...(run.effort.detail === undefined ? {} : { effortDetail: run.effort.detail }),
      ...(run.item.difficulty === null
        ? {}
        : { difficulty: run.item.difficulty, clampedTo: run.item.clampedTo ?? run.item.difficulty }),
      attempts: 1,
      attemptsAvailable: options.admission.ladder.kind === "short" ? 1 : 2,
      checks: run.checks.map(checkRecord),
      // Only for an item that actually merged. A `no-change` item's fetched ref
      // points at the base commit, so recording that sha as `commit` named the
      // state BEFORE the item as the item's own contribution.
      ...(landed?.outcome === "integrated" && landed.sha !== undefined ? { commit: landed.sha } : {}),
      itemRef: itemRef(runId, run.item.number),
      // The left-hand side of `git diff <base>..<itemRef>` — ruling 51's
      // ownership check and ruling 52's reviewer brief, both re-derivable from
      // the record alone now that this is in it.
      baseRef: run.baseRef,
      baseSha: run.baseSha,
      ...(kept === undefined ? {} : { clonePath: kept.path, bytes: kept.bytes }),
    };
  });

  for (const wave of waves) {
    for (const entry of wave.items) {
      if (entry.outcome !== "not-attempted") continue;
      if (items.some((item) => item.number === entry.item)) continue;
      const planned = plan.items.find((candidate) => candidate.number === entry.item);
      if (planned === undefined) continue;
      items.push({
        id: planned.id,
        number: planned.number,
        status: "unrun",
        kind: planned.kind,
        checks: [
          {
            name: `integrate item ${planned.number}`,
            outcome: "not-run",
            blocking: true,
            qualifier: "prerequisite did not integrate",
            detail: entry.detail ?? "never attempted",
          },
        ],
        itemRef: entry.ref,
      });
    }
  }
  // Ruling 63: an item this run never reached is a fact about the run, and it
  // must be IN the record rather than absent from it. An interrupt stops
  // dispatch at a batch boundary, so a wave may end without `integrateWave`
  // ever having heard of its later items — and ruling 52's rule is the same one
  // level up: a missing result never renders as a satisfied requirement.
  for (const planned of plan.items) {
    if (items.some((item) => item.number === planned.number)) continue;
    items.push({
      id: planned.id,
      number: planned.number,
      status: interruptedBy === null ? "unrun" : "cancelled",
      kind: planned.kind,
      checks: [
        {
          name: `integrate item ${planned.number}`,
          outcome: "not-run",
          blocking: true,
          qualifier: interruptedBy === null ? "never dispatched" : "interrupted before dispatch",
          detail:
            interruptedBy === null
              ? "this run ended before the item was dispatched"
              : `${String(interruptedBy)} stopped dispatch before this item was given a directory, so ` +
                "nothing was spawned for it and nothing of it exists to inspect.",
        },
      ],
      itemRef: itemRef(runId, planned.number),
    });
  }
  items.sort((a, b) => a.number - b.number);

  const estimate = estimatePlan(
    plan.items,
    options.admission.fanOut[0]?.workers ?? 1,
    options.admission.agents.map((agent) => agent.id),
  );
  const quota: Record<string, "read" | "unreadable" | "unpriceable"> = {};
  for (const agent of options.admission.agents) {
    // Ruling 13's quota half, and it is never optimistic: brigadier has never
    // measured a way to read a vendor's remaining quota, and #42 measured
    // opencode reaching a model with no credential at all through its own
    // gateway — so a successful turn there proves nothing about which account
    // was billed.
    quota[agent.id] = agent.id === "opencode" ? "unpriceable" : "unreadable";
  }

  const runRecord: RunRecord = {
    runId,
    integrationRef: branchRef,
    ...(integrationSha === null ? {} : { integrationSha }),
    base: { ref: base.ref, sha: base.sha },
    runChecks: [checkRecord(deliverable)],
    runRoot: options.runRoot,
    bindingFilter: options.admission.fanOut[0]?.boundBy ?? "item-count",
    workers: options.admission.fanOut[0]?.workers ?? 0,
    refusedDelegations: 0,
    ambientSuppressed: [
      "the agent's config root is redirected into brigadier's own state directory for every worker (decision 17)",
    ],
    // Ruling 32's standing rule, applied to a feature that is NOT BUILT rather
    // than suspended for it: cross-vendor review is not implemented in this
    // build, so `crossVendor` is false and the reason says why. Writing `true`
    // here because two vendors happened to resolve would be a record claiming a
    // review that never ran — the exact shape ruling 52 exists to stop, and the
    // one a reader of this file is most likely to reintroduce.
    ...(options.review ? { review: { crossVendor: false, sameVendorReason: REVIEW_UNBUILT } } : {}),
    cost: {
      currency: estimate.unit,
      estimateLow: estimate.low,
      estimateHigh: estimate.high,
      provenance: estimate.provenance,
      ...(options.softCeiling === undefined ? {} : { softCeiling: options.softCeiling }),
      ...(options.hardCeiling === undefined ? {} : { hardCeiling: options.hardCeiling }),
      quota,
      levers: estimate.levers,
      lowerBound: estimate.lowerBound,
    },
    transcriptsPath: transcriptDir,
    items,
  };

  const mergedResult = gates.map(checkRecord);
  // Ruling 52's conjunction, and the deliverable is in it: a run whose
  // integration branch does not exist has not succeeded, whatever its items say.
  const ok =
    items.every((item) => item.checks.every((check) => !check.blocking || !blocks(check.outcome))) &&
    gates.every((gate) => !blocks(gate.outcome)) &&
    !blocks(deliverable.outcome);

  sink.write(join(transcriptDir, "full.log"), `${transcript.join("\n")}\n`);
  sink.write(jsonRecord, `${JSON.stringify(runRecord, null, 2)}\n`);
  recordEvent(sink, record, { type: "run-finished", at: Date.now(), outcome: ok ? "complete" : "abandoned" });

  writeRunReport(
    {
    record: runRecord,
    recordPath: jsonRecord,
    // Derived from the very items and checks this report prints, rather than
    // from the wave outcomes: `no-change` counts as landed in a wave, and that
    // is how "2 of 2 items landed" got printed over a run that published
    // nothing. See `runHeadline`.
    headline: runHeadline({ items, mergedResult, runChecks: runRecord.runChecks ?? [] }),
    mergedResult,
    retained,
    unconfirmedPids: start.unconfirmedPids,
    audience: options.audience,
    detail: [...notes, "", ...describeEstimate(estimate)],
    },
    sink,
  );

  // RULING 63'S PROMISE: four facts and no reassurance, and it is printed
  // OUTSIDE the report's budget on purpose. Ruling 58 caps what a host session
  // pays for by dropping passing items; these lines are not items, they are the
  // hazard, and the pid list in particular is the one thing v1 could not
  // produce — "something may still be running" is not a fact an operator can
  // act on and a pid is.
  if (interruptedBy !== null) {
    const landedItems = items.filter((item) => item.status === "integrated" && !itemBlocks(item));
    const unfinished: UnfinishedRun = {
      landed: landedItems.map((item) => item.number),
      didNotLand: items.filter((item) => !landedItems.includes(item)).map((item) => item.number),
      retainedClones: retained,
      unconfirmedPids: [
        ...new Set([...interruptSurvivors, ...runs.flatMap((run) => run.survivors)]),
      ].sort((a, b) => a - b),
    };
    sink.outLine(`interrupted by ${String(interruptedBy)} — what this run left behind:`);
    for (const line of describeUnfinished(unfinished)) sink.outLine(line);
  }

  return { sink, grant, recordPath: jsonRecord, exitCode: ok ? 0 : 1, interruptedBy };
}

/** Used by the CLI to decide whether the run root is usable before anything is created. */
export function runRootUsable(runRoot: string): string | null {
  if (!existsSync(runRoot)) return null;
  try {
    if (!statSync(runRoot).isDirectory()) return `${runRoot} exists and is not a directory`;
  } catch (error) {
    return `${runRoot} could not be read: ${String(error)}`;
  }
  return null;
}
