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
 *   3. PER WAVE: clone, release, spawn a MARKED agent, RUN THE ITEM'S OWN
 *      VERIFY COMMAND (ruling 52), sweep the item, review, fetch, check
 *      ownership, merge. Wave N+1 clones from wave N's integration commit and
 *      does not start until the gate on it did not block (ruling 54).
 *   4. THE MERGED-RESULT GATE (ruling 52), in its own slot, in its own section.
 *      "Every item passed" and "the merged result passed" are two facts, and
 *      the per-item verify in step 3 does not replace this one.
 *   5. THE FULL RECORD TO DISK, and only then a report (ruling 58). The
 *      pointer travels; the transcript does not.
 *
 * WHAT REACHES THE INTEGRATION BRANCH IS DECIDED BY RULING 52 AND NOTHING ELSE.
 * `mayIntegrate` is the only gate: `pass` proceeds, `unconfigured` does not
 * block, and every other outcome keeps the item OUT OF THE TREE. This used to
 * be the review check alone, so a worker that ended in `error` and a verify
 * command that exited non-zero produced a report saying the right word over
 * bytes that were on the branch anyway — v1's failure with a different noun in
 * it. A check added to `ItemRun.checks` inherits the rule without anybody
 * remembering to widen a filter.
 *
 * COST IS MEASURED WHILE THE RUN HAPPENS, NOT PREDICTED (ruling 66). `Spend`
 * counts bytes as they cross the channel — never `usage_update`, which was
 * measured to plateau for five turns while history was rewritten and therefore
 * MASKS compaction. Two ceilings act on that number and they are two different
 * mechanisms: SOFT stops new dispatch at a batch or wave boundary, HARD cancels
 * work already running the moment the bytes cross it.
 *
 * A REFUSED DELEGATION COUNTS ITSELF (ruling 59). The refusing invocation is a
 * different process — a descendant of a worker — and it appends its own line to
 * this run's ledger, which it can find because ruling 59 made the worker marker
 * an identity rather than a boolean. This file reads the ledger back at the end
 * and the report carries ONE RUN-LEVEL line, because ruling 58's cap collapses
 * passing items and a per-item note would be the first thing dropped.
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
import { Worker, isCredentialRefusal } from "../agent/worker.ts";
import {
  buildBaseState,
  discardClone,
  prepareClone,
  releaseToAgent,
  type AgentOwnedClone,
  type BaseState,
} from "../isolation/index.ts";
import {
  assertLocalPathTransport,
  attemptable,
  discardGateClone,
  initialIntegrationCheck,
  integrateWave,
  parentGit,
  refSha,
  runIntegrationGate,
  waveBoundary,
  type IntegrationItem,
  type WaveIntegration,
} from "../integrate/index.ts";
import { Lane } from "../lane/lane.ts";
import { manifestPath, readManifest } from "../isolation/manifest.ts";
import { RUN_DIR } from "../repo/layout.ts";
import { REF_NAMESPACE, WORK_BRANCH, integrationBranch, itemRef } from "../repo/refs.ts";
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
import { dispatchWidth } from "../work/fanout.ts";
import { lanePolicyFor } from "../work/kind.ts";
import { ladderTaken, renderLadder, rungsOffered } from "../work/ladder.ts";
import type { VerifyResolution } from "../gate/verify.ts";
import { runVerify, unconfiguredVerify } from "../gate/run.ts";
import { readRefusals, refusalLedgerPath } from "./refusal.ts";
import { bindingSentence, type Admission } from "./admit.ts";
import { composeBrief } from "./brief.ts";
import { CEILING, deriveEffort, noLever, leverFor, renderEffort, type EffortOutcome } from "./effort.ts";
import {
  REVIEWER_RERUNS,
  catchRateLine,
  caughtIn,
  unverifiedFindings,
  chooseReviewer,
  composeReviewBrief,
  notReviewable,
  parseVerdict,
  reviewApplies,
  reviewQualifier,
  type ReviewerChoice,
} from "./review.ts";
import { spawnMarkedAgent } from "./spawn.ts";
import { ceilingRefusal, describeEstimate, estimatePlan, tokensFromBytes } from "./estimate.ts";
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
 * What `--review` gets when nothing on this machine can review.
 *
 * Ruling 52's four outcomes: a reviewer producing no verdict is `error` or
 * `not-run`, and both BLOCK. `not-run` is the right one here — nothing started,
 * it is the operator's environment rather than any checker's crash, and no
 * retry by anything helps.
 *
 * The temptation this constant exists to remove: writing `crossVendor: true`
 * into the record because two vendors happened to resolve on `PATH`. That would
 * be a record claiming a review that never ran, which is ruling 32's standing
 * rule broken by a field rather than by a sentence.
 */
export const NO_REVIEWER =
  "no agent resolved on PATH, so no reviewer was routed. Ruling 32's standing rule is not " +
  "suspended for a check that could not run — a check that did not run never renders as a pass, " +
  "so this item carries a blocking `review: not-run` and this run cannot succeed.";

/** How long a reviewer is given to answer before ruling 52 calls it `error`. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 600_000;
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
  /**
   * How many defects an INDEPENDENT VERIFIER planted in this run's diffs.
   *
   * The denominator of the published catch rate, and it comes from outside on
   * purpose: `BAR.md` gives the planting to the verifier because a builder's
   * planted defect tests only what the builder already thought of. brigadier
   * counts what its reviewers named AND that appears in the diff they were
   * handed; it never invents the denominator, and with no `--planted` it prints
   * a count rather than a rate.
   */
  planted?: number;
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
  /**
   * Ruling 58: tokens the CALLER already put on this process's stdout.
   *
   * The ceiling is on the channel rather than on the report, because every byte
   * on that stdout lands in the same context window and is charged once. The
   * caller printed the admission block before calling this, so it is the only
   * thing that knows the number, and it hands it over rather than this file
   * recomputing something that might diverge from what was actually written.
   */
  prologueTokens?: number;
  runId?: string;
  handshakeTimeoutMs?: number;
  workerTimeoutMs?: number;
  verifyTimeoutMs?: number;
  reviewTimeoutMs?: number;
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

/**
 * Ruling 52, as the rule that decides what reaches the integration branch.
 *
 * THIS IS THE FIX FOR THE DEFECT, and it is one line because the defect was
 * one line. The filter used to read `run.review?.blocks !== true` — the REVIEW
 * check, alone, kept an item out of the merge, and every other blocking outcome
 * was a word in a report. A worker that ended in `error`, a containment check
 * with surviving pids, and — once ruling 52's per-item verify actually runs —
 * a verify command that exited non-zero all produced a blocking check AND a
 * merged item. The report said the right word and the bytes were on the branch,
 * which is precisely the shape of v1's failure: `review: not run
 * (REVIEWER_FAILED)` beside a merged change.
 *
 * So the rule is the ruling, stated once and consulted everywhere: `pass`
 * proceeds, `unconfigured` does not block, and EVERY other outcome keeps the
 * item out of the tree. A new check added to `ItemRun.checks` inherits that
 * without anybody remembering to widen a filter — which is the property the old
 * shape did not have.
 */
function mayIntegrate(run: ItemRun): boolean {
  return !run.checks.some((check) => blocks(check.outcome));
}

/** The checks that are keeping this item out, named rather than counted. */
function blockingNames(run: ItemRun): string[] {
  return run.checks.filter((check) => blocks(check.outcome)).map((check) => `${check.name}: ${check.outcome}`);
}

/**
 * What this run has spent, counted on the wire, and the two ceilings that act
 * on it.
 *
 * RULING 66'S ORDER: **the ceiling is the primary control and the estimate is
 * not.** #44 measured 427,723 against 28,245 bytes on two identical Codex runs
 * — 15× on identical input — and published tooling puts real cost at 3–5×
 * naive estimates, so no prediction is load-bearing enough to be the thing that
 * stops a run. A number that is measured as the run happens is.
 *
 * TWO CEILINGS, TWO MECHANISMS, and the report distinguishes them:
 *
 *   SOFT   stop DISPATCHING. Items already in flight run to completion, which
 *          is why it is checked at the batch and wave boundaries — the only
 *          places this file chooses to spend something new.
 *   HARD   cancel work ALREADY RUNNING. `session/cancel` to every live worker
 *          and a kill behind it, which is ruling 63's drain reused rather than
 *          reimplemented: `session/cancel` is an unacknowledged notification,
 *          so the kill is the mechanism and the cancel is the courtesy.
 *
 * THE SOURCE OF THE NUMBER IS THE WIRE, NEVER `usage_update`. The drive
 * measured `used` PLATEAUING FOR FIVE TURNS while the agent rewrote its
 * history: the field MASKS compaction, so reading it would report a run's most
 * expensive turns as its cheapest and would hold a ceiling open at exactly the
 * moment it should close. Bytes that crossed the channel cannot plateau while
 * work is happening. Both directions are counted, because the brief is billed
 * as input and #14's 46 KB measurement is agent→client alone — counting only
 * the answer would undercount every turn by the size of its question.
 *
 * AND NOTHING HERE IS A SAVINGS CLAIM (ruling 70). This counts what was spent.
 */
class Spend {
  #bytes = 0;
  #soft: number | undefined;
  #hard: number | undefined;
  #onHard: () => void;
  softHit = false;
  hardHit = false;
  /** Whichever fired first, in the operator's words. `null` when neither did. */
  firstFired: string | null = null;

  constructor(soft: number | undefined, hard: number | undefined, onHard: () => void) {
    this.#soft = soft;
    this.#hard = hard;
    this.#onHard = onHard;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** Bytes read as tokens by the SAME arithmetic as the estimate, so they compare. */
  get tokens(): number {
    return tokensFromBytes(this.#bytes);
  }

  add(bytes: number): void {
    this.#bytes += bytes;
    const spent = this.tokens;
    if (this.#soft !== undefined && !this.softHit && spent >= this.#soft) {
      this.softHit = true;
      this.firstFired ??= `soft ceiling (${this.#soft.toLocaleString("en-US")} tokens)`;
    }
    if (this.#hard !== undefined && !this.hardHit && spent >= this.#hard) {
      this.hardHit = true;
      this.firstFired ??= `hard ceiling (${this.#hard.toLocaleString("en-US")} tokens)`;
      this.#onHard();
    }
  }

  /** True once no further item may be DISPATCHED. Either ceiling implies it. */
  get stopDispatching(): boolean {
    return this.softHit || this.hardHit;
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
  /**
   * The vendor the router CHOSE for this item. What was planned, and nothing
   * more — a name here is not evidence that anything ran.
   */
  agent: string | null;
  /**
   * The vendor whose process actually SPAWNED, set from the spawn itself.
   *
   * Ruling 32's pass/fail property is *the reviewer's vendor differs from the
   * builder's*, so an identity taken from the plan rather than from the process
   * can render a same-vendor review as cross-vendor or the reverse — a wrong
   * answer to the one question the field exists to answer. `agent` above is what
   * was intended; this is what happened, and it is `null` until `Bun.spawn`
   * returned a pid. The record and the report carry both, because "routed to
   * qwen and never started" and "qwen ran" are different facts and only one of
   * them is a vendor having been used.
   */
  spawnedAgent: string | null;
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
  /** Rulings 32 and 52. Absent until the review phase settles the item's slot. */
  review: ItemReview | null;
  /**
   * Ruling 66: this item was IN FLIGHT when the hard ceiling fired and was
   * cancelled, rather than having failed at anything.
   *
   * A separate field from the checks because the two say different things: the
   * checks say the worker ended in `error` (it was killed, which is true), and
   * this says whose decision that was. `RecordItem.status` has `cancelled` for
   * exactly this, and reporting it as `failed` would send an operator to look
   * for a defect in work brigadier stopped on purpose.
   */
  cancelledByCeiling: boolean;
  /** Ruling 38's one hole: a verify command spawned WITHOUT the command-line marker. */
  unmarkedPids: number[];
  /**
   * The agent whose CREDENTIAL was refused, or `null`.
   *
   * Separate from the check's `error` for the same reason `cancelledByCeiling`
   * is: the check says this worker did not finish, and this says the reason is
   * the operator's account rather than anything in the item. `OWNER-QUESTIONS.md`
   * #14.
   */
  credentialRefusal: string | null;
}

/** What the review phase learned about one item. */
interface ItemReview {
  outcome: CheckOutcome;
  /** The vendor the router chose to review with. A choice, not an event. */
  reviewer: string | null;
  /**
   * The vendor whose reviewer process actually spawned, from the spawn itself.
   *
   * Same rule as `ItemRun.spawnedAgent` and for the same ruling: a reviewer
   * identity read off the plan says a review happened when a spawn failed, and
   * ruling 32's whole property is a comparison between two identities.
   */
  spawnedReviewer: string | null;
  crossVendor: boolean;
  sameVendorReason?: string;
  /** Charged to brigadier, never to the item's ladder (ruling 52). */
  reviewerAttempts: number;
  /** Identities present in the diff the reviewer was handed. Never a count. */
  caught: string[];
  /** True when this item must NOT reach the integration branch. */
  blocks: boolean;
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
  spend: Spend,
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
    spawnedAgent: null,
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
    review: null,
    cancelledByCeiling: false,
    unmarkedPids: [],
    credentialRefusal: null,
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
      // BEFORE the spawn, and that ordering is the whole point.
      //
      // MEASURED against `@agentclientprotocol/codex-acp` 1.6.2 and codex-cli
      // 0.147.0 on 2026-08-20, with a negative control:
      //   CODEX_HOME=<existing empty dir>  -> bridge stays up (SIGTERM at 20 s)
      //   CODEX_HOME=<non-existent dir>    -> bridge exits immediately
      // These two `mkdirSync` calls used to run AFTER `spawnMarkedAgent`
      // returned, so every worker was handed a config root and a TMPDIR that
      // did not exist yet and the vendor lost the race. The reviewer path at
      // `runReview` already had this right; the builder path did not.
      mkdirSync(join(clone.stateDir, "agent-config"), { recursive: true });
      mkdirSync(join(clone.stateDir, "tmp"), { recursive: true });
      marked = spawnMarkedAgent({
        profile,
        runId: base.runId,
        // Ruling 59: the worker marker says WHICH run, and this says where that
        // run's directory is, so a refused delegation inside this worker's tool
        // shell has a ledger to append itself to.
        runRoot: options.runRoot,
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
      // IDENTITY FROM THE SPAWN, not from the plan. `Bun.spawn` has returned a
      // pid by here and `marked.commandLine` is the argv a `ps` scan will see,
      // so this is the first moment at which a vendor can be said to have run.
      result.spawnedAgent = profile.id;
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
          onFrame: (direction, raw) => {
            transcript.push(`${item.id} ${direction} ${raw}`);
            // Ruling 66's primary control, fed from the one number that cannot
            // plateau while work is happening. Counted HERE rather than from
            // `turn.bytes` so a hard ceiling can act mid-turn: a ceiling that
            // could only be evaluated after the turn it should have stopped is
            // a report, not a control.
            spend.add(raw.length);
          },
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
      // A refused ACCOUNT is a fact about the machine, not about this item, and
      // the next item will meet it too. Recorded here, where the vendor's own
      // words are still in hand; acted on at the batch boundary, which is the
      // only place this run chooses to spend something new.
      if (isCredentialRefusal(detail)) result.credentialRefusal = profile.id;
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

  // RULING 52'S PER-ITEM VERIFY, WHICH IS THE CHECK THAT WAS RESOLVED AND NEVER
  // RUN.
  //
  // `validatePlan` resolved this command on `PATH` before a single worker
  // existed and refused the whole plan if the executable was not there — and
  // then nothing ever executed it. Only the wave-level `--verify` ran, against
  // the merged result, which is a different check answering a different
  // question: ruling 52 wants BOTH, because two items that each pass and whose
  // merge breaks the build is the classic failure and so is one item that
  // merged without its own tests ever running. v1's shape, exactly: an injected
  // `ENOENT` on the test command produced *approved, `tests_pass` skipped,
  // `(approved by codex)`* after a full build was burned.
  //
  // Write-ahead first, as everywhere else: the slot holds a blocking `not-run`
  // before the command starts, so a kill between here and the answer leaves a
  // blocking value on disk rather than an absent field.
  //
  // `unconfigured` DOES NOT BLOCK and prints in the same slot at the same size.
  // That is ruling 52's own instruction and it is the value most likely to
  // become v1's bug wearing a different noun, which is why it is rendered by
  // `unconfiguredVerify` with a detail that says what was not checked.
  openCheckSlot(record, item.number, "verify");
  let verify: CheckResult;
  if (item.verify.status === "unconfigured") {
    verify = unconfiguredVerify("verify", `item ${item.number}`);
  } else if (blocks(outcome)) {
    // The worker did not finish, so the tree in this clone is not the result of
    // the work being checked. `not-run` BLOCKS, so nothing here lets the item
    // through — and running a test suite over the base state to watch it pass
    // would produce the single most misleading `pass` this file could emit.
    verify = {
      name: "verify",
      outcome: "not-run",
      qualifier: `item ${item.number}: worker ${outcome}`,
      detail:
        `\`${item.verify.argv.join(" ")}\` was not run: the worker ended in \`${outcome}\`, so this ` +
        "clone does not hold the work the command would have been checking. Ruling 52 keeps the " +
        "two apart — the remedy here is the worker's outcome above, not this command — and " +
        "`not-run` blocks, so the item does not reach the integration branch either way.",
    };
  } else {
    verify = await runVerify({
      resolution: item.verify,
      cwd: clone.dir,
      name: "verify",
      qualifier: `item ${item.number}`,
      timeoutMs: options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      // Ruling 38's one deliberate hole, recorded rather than hidden: this
      // process carries no command-line marker, because appending an argument
      // to somebody else's command line corrupts it — `bun test
      // --brigadier-run=x` is not `bun test`. The sweep cannot match it, so its
      // pid is kept and it is killed on its own timeout by the process that
      // started it, which is a weaker guarantee and is reported as one.
      onPid: (pid) => {
        result.unmarkedPids.push(pid);
        recordEvent(sink, record, {
          type: "process-spawned",
          at: Date.now(),
          item: item.number,
          pid,
          commandLine: `${item.verify.argv.join(" ")} (UNMARKED: ruling 38 cannot reach an operator's own command line)`,
        });
      },
    });
  }
  settleCheck(record, item.number, "verify", verify.outcome, verify.detail ?? null);
  result.checks.push(verify);

  // Ruling 52's write-ahead, and it is OPENED here and SETTLED in the review
  // phase below — deliberately not both in one place. The whole value of a
  // write-ahead is the window between them: a process killed after the worker
  // finished and before the reviewer answered leaves a BLOCKING `not-run` on
  // disk rather than a slot that never existed. v1's `review: not run
  // (REVIEWER_FAILED)` merged the most delicate change of the build, and this
  // is the shape that makes that outcome unreachable.
  if (options.review) openCheckSlot(record, item.number, "review");

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

/**
 * Review one item's diff, and settle its write-ahead slot.
 *
 * THE ORDER IS THE POINT, and it is fixed by three rulings at once:
 *
 *   FETCH FIRST, INTO BRIGADIER'S OWN NAMESPACE. Ruling 56 keeps brigadier's
 *   count of git commands run inside a clone an agent has touched at ZERO, so
 *   the diff cannot be taken in the clone. `git fetch <clone-path> work:<review
 *   ref>` runs in the OPERATOR's repository — the same direction and the same
 *   local-path transport `src/integrate/integrate.ts` measured — and the diff
 *   computes identically once the ref is here. The ref lives under
 *   `refs/brigadier/<run-id>/`, so ruling 50's delete rule already covers it and
 *   nothing new has to be cleaned up by hand.
 *
 *   REVIEW BEFORE INTEGRATION, NOT AFTER. A review that blocks has to be able to
 *   keep the item OUT of the integration branch, and a check run after the merge
 *   can only complain about it. v1 merged its most delicate change on
 *   `review: not run (REVIEWER_FAILED)`; asserting on the report's wording would
 *   not have caught that, and asserting on the tree does.
 *
 *   `error`, NEVER `fail`, WHEN THE REVIEWER PRODUCES NO VERDICT. Ruling 52:
 *   `fail` dispatches the BUILDER to fix a defect that is not in its code and
 *   spends a rung of ruling 24's ladder doing it. The remedy for a broken
 *   checker is to re-run the CHECKER, which is `REVIEWER_RERUNS`, and those
 *   re-runs are counted in `reviewerAttempts` rather than in `attempts` so the
 *   rule is observable in the record rather than asserted in a comment.
 */
async function reviewItem(
  run: ItemRun,
  choice: ReviewerChoice,
  options: ExecuteOptions,
  sink: Sink,
  record: string,
  runId: string,
  runDir: string,
  secrets: Record<string, string>,
  transcript: string[],
  live: Set<LiveWorker>,
  spend: Spend,
): Promise<ItemReview> {
  const number = run.item.number;
  const base: Omit<ItemReview, "outcome" | "blocks"> = {
    reviewer: choice.agent?.id ?? null,
    spawnedReviewer: null,
    crossVendor: choice.crossVendor,
    ...(choice.sameVendorReason === undefined ? {} : { sameVendorReason: choice.sameVendorReason }),
    reviewerAttempts: 0,
    caught: [],
  };
  const settle = (outcome: CheckOutcome, qualifier: string, detail: string, extra: Partial<ItemReview> = {}): ItemReview => {
    settleCheck(record, number, "review", outcome, detail);
    run.checks.push({ name: "review", outcome, qualifier, detail });
    return { ...base, ...extra, outcome, blocks: blocks(outcome) };
  };

  if (choice.agent === null) {
    return settle("not-run", "no reviewer", NO_REVIEWER);
  }
  if (run.clonePath === null) {
    return settle(
      "not-run",
      "no diff",
      `item ${run.item.id} never got a directory, so there is no \`${WORK_BRANCH}\` branch to diff and ` +
        "nothing for a reviewer to read. No retry by any reviewer helps.",
    );
  }

  // Ruling 52's exact framing, and it is free: the base commit is a fixed
  // reference the record already carries per item, so this diff is re-derivable
  // from the record alone with `git diff <baseSha>..<itemRef>`.
  const reviewRef = `${REF_NAMESPACE}/${runId}/review/${number}`;
  let diff: string;
  try {
    assertLocalPathTransport(run.clonePath);
    await parentGit(options.repo, ["fetch", "--no-tags", run.clonePath, `${WORK_BRANCH}:${reviewRef}`]);
    diff = await parentGit(options.repo, ["diff", "--no-renames", `${run.baseSha}..${reviewRef}`]);
  } catch (error) {
    // The CHECKER broke before a reviewer was even reached. Ruling 52: `error`.
    return settle(
      "error",
      "no diff",
      `the reviewer's brief could not be built: ${error instanceof Error ? error.message : String(error)}. ` +
        `Ruling 52 hands a reviewer \`git diff ${run.baseSha}..${reviewRef}\`, computed in the operator's ` +
        "repository because ruling 56 keeps brigadier's git commands inside an agent's clone at zero.",
    );
  }

  if (diff.trim().length === 0) {
    return settle(
      "not-run",
      "nothing to review",
      `item ${run.item.id} committed no change to its \`${WORK_BRANCH}\` branch, so the diff ruling 52 ` +
        "hands a reviewer is empty. Nothing was reviewed, and an empty review never renders as a pass.",
    );
  }

  const brief = composeReviewBrief({
    id: run.item.id,
    kind: run.item.kind,
    paths: run.item.paths,
    prompt: run.item.prompt,
    baseRef: run.baseRef,
    baseSha: run.baseSha,
    itemRef: reviewRef,
    diff,
  });

  const profile = choice.agent.profile;
  const effort = deriveEffort("read-only", run.item.clampedTo, CEILING);
  const failures: string[] = [];
  let attempts = 0;

  for (let attempt = 1; attempt <= 1 + REVIEWER_RERUNS; attempt++) {
    attempts = attempt;
    // A fresh directory per attempt: a reviewer's second run must not inherit
    // the first's agent state, and ruling 49's `read-only` lane is a flat deny,
    // so nothing legitimate is lost by the directory being empty.
    const dir = join(runDir, "review", `${number}-${attempt}`);
    mkdirSync(join(dir, "agent-config"), { recursive: true });
    mkdirSync(join(dir, "tmp"), { recursive: true });
    let spawned: { pid: number; kill(): void } | null = null;
    try {
      const marked = spawnMarkedAgent({
        profile,
        runId,
        runRoot: options.runRoot,
        item: number,
        cwd: dir,
        // Ruling 49: a reviewer writes nothing and its directory is never read
        // back, which is exactly what `read-only` means — and on Codex it is the
        // mode that blocks writes at the OS level (#41).
        kind: "read-only",
        configRoot: join(dir, "agent-config"),
        tmpDir: join(dir, "tmp"),
        secrets,
        effort,
        onFrame: (direction, raw) => transcript.push(`${run.item.id} review ${direction} ${raw}`),
      });
      spawned = marked;
      // The reviewer's identity, from the reviewer's own spawn. Ruling 32's
      // property is a comparison between this and the builder's, and a name
      // taken from the routing choice would answer it about a process that may
      // never have existed.
      base.spawnedReviewer = profile.id;
      recordEvent(sink, record, {
        type: "process-spawned",
        at: Date.now(),
        item: number,
        pid: marked.pid,
        commandLine: marked.commandLine,
      });
      let acp: Worker | undefined;
      const registration: LiveWorker = {
        item: number,
        pid: marked.pid,
        cancel: () => acp?.cancel(),
        kill: () => marked.kill(),
      };
      live.add(registration);

      const worker = await withTimeout(
        Worker.start(profile, {
          cwd: dir,
          lane: new Lane(dir, lanePolicyFor("read-only")),
          kind: "read-only",
          channel: marked.channel,
          onFrame: (direction, raw) => {
            transcript.push(`${run.item.id} review ${direction} ${raw}`);
            // A reviewer's turn is spent too. Ruling 52 charges a BROKEN
            // reviewer's re-run to brigadier rather than to the item's ladder,
            // and that is a rule about ATTEMPTS; the tokens are still real and
            // a cost ceiling that ignored them would report a run as cheaper
            // than it was.
            spend.add(raw.length);
          },
        }),
        options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        `${profile.id} reviewer handshake for item ${run.item.id}`,
      );
      acp = worker;
      const turn = await withTimeout(
        worker.prompt(brief),
        options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
        `${profile.id} reviewer turn for item ${run.item.id}`,
      );
      await worker.close();

      const verdict = parseVerdict(turn.text);
      if (verdict === null) {
        // #14 measured that `end_turn` does NOT mean the task was done, so the
        // stop reason is not consulted here. A reviewer that stopped without a
        // verdict produced no verdict, however politely it stopped.
        failures.push(
          `attempt ${attempt}: ${profile.id} stopped with ${turn.stopReason} and no parseable VERDICT line`,
        );
        continue;
      }
      const caught = caughtIn(diff, verdict.found);
      // Both sides of ruling 32's comparison come from spawns: `profile.id` is
      // the reviewer this loop just started, and `spawnedAgent` is the builder
      // whose process really ran. A qualifier built from the routing choice
      // would name a builder that may never have started.
      const qualifier = reviewQualifier(choice, profile.id, run.spawnedAgent);
      return settle(
        verdict.verdict === "approved" ? "pass" : "fail",
        qualifier,
        verdict.verdict === "approved"
          ? `${profile.id} read ${diff.length} bytes of diff and approved it.` +
            (choice.crossVendor
              ? ""
              : ` ${choice.sameVendorReason ?? ""}`)
          : `${profile.id} rejected this diff and named ${caught.length} defect(s) present in it: ` +
            `${caught.join(", ") || "none that appear in the diff it was handed"}. ` +
            unverifiedFindings(caught, verdict.found) +
            "Ruling 52: the remedy " +
            "is the BUILDER's, which is what `fail` means and why it is not `error`.",
        { reviewerAttempts: attempts, caught },
      );
    } catch (error) {
      failures.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      for (const entry of [...live]) if (entry.pid === spawned?.pid) live.delete(entry);
      spawned?.kill();
      const swept = await sweep({
        scope: { runId, item: number },
        sweptBy: `end-of-review sweep for ${runId}/${number} attempt ${attempt}`,
        ...(spawned === null ? {} : { recordedPids: [spawned.pid] }),
      });
      recordEvent(sink, record, {
        type: "swept",
        at: Date.now(),
        sweptBy: swept.evidence.sweptBy,
        runId,
        item: number,
        reclaimedPids: [...swept.evidence.reclaimedPids],
        survivors: [...swept.evidence.survivors],
      });
    }
  }

  return settle(
    "error",
    reviewQualifier(choice, profile.id, run.spawnedAgent),
    `the reviewer produced no verdict in ${attempts} attempt(s): ${failures.join("; ")}. Ruling 52 calls ` +
      "this `error` and not `fail`: the CHECKER broke, so the remedy is to re-run the reviewer, and " +
      "sending the builder to fix a defect that is not in its code would burn a rung of ruling 24's " +
      `ladder. The ${attempts - 1} re-run(s) above are charged to brigadier and left this item's ` +
      "`attempts` untouched. `error` BLOCKS: this item is not merged.",
    { reviewerAttempts: attempts },
  );
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
  /**
   * The agent whose credential was refused, once, for the whole run.
   *
   * Run-scoped rather than wave-scoped: a dead credential does not come back
   * between waves, and a per-wave reset would relearn it once per wave.
   */
  let credentialRefusedBy: string | null = null;
  let interruptedBy: NodeJS.Signals | null = null;
  let draining: Promise<void> | null = null;

  // RULING 66'S TWO CEILINGS, sharing ruling 63's drain rather than inventing a
  // second one. The hard ceiling and a signal do the same thing to a live
  // worker — `session/cancel`, which is an unacknowledged notification, and
  // then a kill, which is the actual mechanism — and two implementations of
  // that would be two chances to get the order wrong.
  //
  // The kill is IMMEDIATE here, with no `cancelDeadlineMs` wait. That is the
  // difference in kind between the two ceilings: soft lets in-flight work
  // finish, hard stops it. A courtesy deadline on the hard ceiling would let
  // every live worker spend for another `cancelDeadlineMs` past the number the
  // operator set as the limit, which is the one thing a hard ceiling is for.
  const spend = new Spend(options.softCeiling, options.hardCeiling, () => {
    const workers = [...live];
    sink.errLine(
      `HARD CEILING — ${(options.hardCeiling ?? 0).toLocaleString("en-US")} tokens reached. ` +
        `\`session/cancel\` sent to ${workers.length} live worker(s) and each is killed immediately: ` +
        "ruling 66's hard ceiling cancels work already running, and `session/cancel` is an " +
        "unacknowledged notification, so the kill is the mechanism and the cancel is the courtesy.",
    );
    for (const worker of workers) {
      try {
        worker.cancel();
      } catch {
        // A worker whose channel is already gone needs no cancelling.
      }
      try {
        worker.kill();
      } catch {
        // Already gone. The sweep below is what proves it either way.
      }
    }
  });
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
  // Ruling 32, decided ONCE from `PATH` rather than per item: whether this
  // machine can offer a reviewer of a different vendor is a fact about the
  // machine, and `admit` already printed it before anything was spent. Deciding
  // it per item would let one run report both answers.
  const reviewer = options.admission.reviewer ?? chooseReviewer(options.admission.agents, agent?.id ?? null);

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
    // The SAME function the admission's printed count came out of, so the
    // number a reader is shown is the number that runs. This was its own
    // `Math.max(1, …)` here, and `planFanOut` returned the unfloored 0, so a
    // host-first machine under about 9 GiB printed *0 worker(s) in wave 1 — RAM
    // capped it* and then dispatched one. Nothing compared the two.
    const concurrency = dispatchWidth(fanOut);

    const attempted: ItemRun[] = [];
    for (let cursor = 0; cursor < eligible.run.length; cursor += concurrency) {
      // Ruling 63, step 1. Checked at the batch boundary because that is the
      // only place this function chooses to spend something new.
      if (interruptedBy !== null) break;
      // Ruling 66's SOFT ceiling, at the same boundary and for the same reason:
      // it stops NEW items from being dispatched and lets everything already in
      // flight run to completion. The hard ceiling does not wait for this — it
      // acts the moment the bytes cross it, inside `Spend.add`, because
      // cancelling work already running is the whole difference between the two.
      if (spend.stopDispatching) break;
      // A REFUSED ACCOUNT, proven once, at the same boundary and for the same
      // reason as the soft ceiling above: the next item would meet it too.
      //
      // MEASURED 2026-08-21 by the second independent verifier, run
      // `mt2x09vpa2fd`: five items, all five routed to Claude, all five dead at
      // `session/prompt` with `-32000 Authentication required`, reported as five
      // independent item failures rather than as one fact about the machine.
      // That is finding 87's shape — a cost discovered after it is spent —
      // pointing at admission rather than at routing.
      //
      // THE ACCEPTED COST, stated rather than discovered: a TRANSIENT
      // authentication error now stops a run that might have recovered on the
      // next item. The alternative is spending every remaining item to relearn
      // the same answer, and ruling 53 already chose between those two in this
      // direction — an unmeasured requirement is not permission to proceed. The
      // remaining items are `unrun`, never `failed`, so nothing here sends
      // anyone to look for a defect in work that never started.
      if (credentialRefusedBy !== null) break;
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
          return runItem(item, cloneFrom, options, sink, record, agent, secrets, transcript, live, spend);
        }),
      );
      // Ruling 66: an item that was in flight when the HARD ceiling fired was
      // cancelled, not defeated. Recorded here, where "was it running when the
      // ceiling fired" is still knowable, because after the batch resolves
      // every item looks alike.
      if (spend.hardHit) for (const run of finished) run.cancelledByCeiling = true;
      credentialRefusedBy ??= finished.find((run) => run.credentialRefusal !== null)?.credentialRefusal ?? null;
      attempted.push(...finished);
    }
    runs.push(...attempted);

    // 3. REVIEW, between the worker and the merge (rulings 32, 52).
    //
    // Here rather than after integration, because a review that BLOCKS has to
    // keep the item out of the integration branch — a check that runs after the
    // merge can only complain about it. That is the whole of v1's failure: the
    // most delicate change of the build merged on `review: not run
    // (REVIEWER_FAILED)`, and the report said the right word about it.
    if (options.review) {
      for (const run of attempted) {
        if (!reviewApplies(run.item.kind)) {
          const check = notReviewable(run.item.kind);
          settleCheck(record, run.item.number, "review", check.outcome, check.detail ?? null);
          run.checks.push(check);
          continue;
        }
        if (interruptedBy !== null) {
          // Ruling 63 stopped dispatch. The slot is already open holding a
          // blocking `not-run`; settling it with the reason is what keeps an
          // interrupted run's record complete rather than absent.
          settleCheck(record, run.item.number, "review", "not-run", `${String(interruptedBy)} stopped dispatch before this item was reviewed`);
          run.checks.push({
            name: "review",
            outcome: "not-run",
            qualifier: "interrupted",
            detail: `${String(interruptedBy)} stopped dispatch before a reviewer was spawned for this item.`,
          });
          run.review = {
            outcome: "not-run",
            reviewer: null,
            // Nothing spawned, so nothing reviewed. The field says so rather
            // than naming the vendor that would have been asked.
            spawnedReviewer: null,
            crossVendor: reviewer.crossVendor,
            ...(reviewer.sameVendorReason === undefined ? {} : { sameVendorReason: reviewer.sameVendorReason }),
            reviewerAttempts: 0,
            caught: [],
            blocks: true,
          };
          continue;
        }
        run.review = await reviewItem(
          run,
          reviewer,
          options,
          sink,
          record,
          runId,
          runDir,
          secrets,
          transcript,
          live,
          spend,
        );
      }
    }

    // 4. Integration, in plan order, one transaction per wave. An item whose
    // review blocked is NOT in this list, and that is the assertion ruling 52
    // actually wants: not that the report said `error`, but that the work is
    // absent from the tree.
    // RULING 52 DECIDES WHAT REACHES THE TREE, AND IT IS EVERY CHECK RATHER
    // THAN ONE OF THEM. `mayIntegrate` is the whole rule: `pass` proceeds,
    // `unconfigured` does not block, and anything else keeps the item out. The
    // filter here used to name the review check alone, so a worker that ended
    // in `error`, a clone with surviving pids, and a verify command that exited
    // non-zero each produced a report that said the right word over bytes that
    // were on the branch anyway.
    const integrationItems: IntegrationItem[] = attempted
      .filter((run) => run.clonePath !== null && mayIntegrate(run))
      .map((run) => ({
        item: run.item.number,
        clone: run.clonePath as string,
        declaredPaths: run.item.paths,
      }));

    for (const run of attempted) {
      if (run.clonePath === null || mayIntegrate(run)) continue;
      const name = `integrate item ${run.item.number}`;
      openCheckSlot(record, run.item.number, name);
      const detail =
        `item ${run.item.id} was never offered to the merge: ${blockingNames(run).join(", ")}. Ruling 52 ` +
        "has exactly one affirmative outcome and three blocking ones, and a blocking outcome keeps " +
        "the work OUT OF THE TREE rather than merely describing it — v1 merged its most delicate " +
        "change while its report said `review: not run (REVIEWER_FAILED)`. Its clone is retained " +
        "rather than deleted (ruling 63) and its work is reachable at its fetched ref for inspection.";
      settleCheck(record, run.item.number, name, "not-run", detail);
      run.checks.push({ name, outcome: "not-run", qualifier: "blocked before the merge", detail });
    }

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

    // 5. The merged-result gate, in its own slot, written before it runs.
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
    // Ruling 66: a wave is the largest thing this file dispatches, so a ceiling
    // that has fired stops the next one as surely as it stopped the next batch.
    if (spend.stopDispatching) break;
  }

  // Ruling 38's one hole, stated rather than left to be discovered. An
  // operator's verify command is spawned WITHOUT the command-line marker,
  // because appending an argument to somebody else's command line corrupts it,
  // so the sweep cannot match these pids — they were killed on their own
  // timeout by the process that started them, which is a weaker guarantee than
  // the sweep's and is reported as one.
  const unmarked = runs.flatMap((run) => run.unmarkedPids);
  if (unmarked.length > 0) {
    notes.push(
      `${unmarked.length} verify command(s) ran without ruling 38's command-line marker (pid ` +
        `${unmarked.join(", ")}), because \`<command> --brigadier-run=…\` is not \`<command>\`. The sweep ` +
        "cannot match them; each was killed on its own timeout by the process that started it.",
    );
  }

  if (credentialRefusedBy !== null) {
    notes.push(
      `${credentialRefusedBy} refused the credential, not the work: its first \`session/prompt\` answered ` +
        "with an authentication failure after `session/new` had already succeeded, so detection's second " +
        "step proved less than the word `usable` claims. No further BATCH was dispatched — the next item " +
        "would have met the same answer — and those items are `unrun` rather than `failed`. Items already " +
        "IN FLIGHT were not stopped, exactly as the soft ceiling does not stop them, so a wide run can " +
        "still show several items failing this way. The remedy is to authenticate " +
        `${credentialRefusedBy} and run again; nothing in the plan is implicated.`,
    );
  }

  if (spend.firstFired !== null) {
    notes.push(
      `${spend.firstFired} was reached: ${spend.tokens.toLocaleString("en-US")} tokens spent, read from ` +
        `${spend.bytes.toLocaleString("en-US")} bytes that actually crossed the channel in both directions. ` +
        (spend.hardHit
          ? "The HARD ceiling cancelled work already running; items in flight are `cancelled` and later items were never dispatched."
          : "The SOFT ceiling stopped new items being dispatched and let in-flight items finish."),
    );
  }

  // Ruling 63, steps 3 and 4. The wait is bounded by `cancelDeadlineMs` and by
  // nothing else, and the sweep runs AFTER it — a sweep before the kill would
  // report every worker as a survivor and teach the operator to ignore the line
  // that matters. `sweepAtStart` already ran at the top of this function; this
  // is the same matcher over the same marker, scoped to this run.
  const interruptSurvivors: number[] = [];
  if (interruptedBy !== null) {
    if (draining !== null) await draining;
    // RULING 15'S MANIFEST, HANDED TO THE SWEEP AS ITS THIRD LINK.
    //
    // The marker link and the ppid link are BOTH cut by one ordinary idiom, and
    // it was confirmed in the wild rather than reasoned about: an escapee still
    // alive 31 minutes after its run was SIGKILLed, ppid 1. An agent-spawned
    // descendant is UNMARKED, so ruling 38's command-line token does not match
    // it, and it reparents to pid 1 within milliseconds, so the ppid graph does
    // not reach it either. Neither link survives and the process has no
    // containment at all.
    //
    // The third link is ruling 15's provenance applied to a PROCESS rather than
    // a path: a working directory inside a directory this run's manifest
    // recorded BEFORE it existed. That is not cuttable by the descendant,
    // because it is not a property the descendant carries — it is where it is
    // standing. `sweep` exempts a person's own shell (`pgid == pid` with a
    // controlling terminal) so the rule cannot become "kill everything", and
    // brigadier prints the paths of the clones it retains, so an operator
    // reading one is a case the product invites.
    //
    // MEASURED on macOS 26.5.2 (Darwin 25.5.0): `ps -E` and `ps eww` print NO
    // environment for a same-uid child, so the environment is not available as
    // an identification channel — the working directory is what replaced it.
    //
    // `src/run/start.ts` already passes this at START. Ruling 38 requires the
    // sweep at both ends precisely because either can be cut off, so start
    // coverage is the BACKSTOP for a drain that never ran, not an excuse for a
    // drain that runs and does not look. Without it, ruling 63's fourth fact —
    // the exact pids that would not confirm dead — reads complete while being
    // silently short by the whole class of escapee ruling 38 promoted the sweep
    // to catch.
    const manifest = readManifest(manifestPath(options.runRoot, RUN_DIR, runId));
    const workspaces = (manifest?.clones ?? []).map((clone) => ({ item: clone.item, dir: clone.dir }));
    const finalSweep = await sweep({
      scope: { runId },
      sweptBy: `interrupt (${String(interruptedBy)}) drain for ${runId}`,
      workspaces,
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

  // 6. The full record to disk, and only then a report (ruling 58).
  const items: RecordItem[] = runs.map((run) => {
    const landed = waves.flatMap((wave) => wave.items).find((entry) => entry.item === run.item.number);
    const kept = retained.find((entry) => entry.item === run.item.number);
    const blocking = run.checks.some((check) => blocks(check.outcome));
    return {
      id: run.item.id,
      number: run.item.number,
      // Ruling 66: `cancelled` outranks `retained` and `failed`, because it is
      // the only one of the three that says WHOSE decision it was. An item
      // brigadier killed to stay under a ceiling did not fail at anything, and
      // reporting it as `failed` sends an operator to look for a defect in work
      // that was stopped on purpose. Its clone is still reported below.
      status: run.cancelledByCeiling
        ? "cancelled"
        : kept !== undefined
          ? "retained"
          : blocking
            ? "failed"
            : "integrated",
      kind: run.item.kind,
      // WHAT SPAWNED, and separately what was ROUTED. Ruling 29's triple is
      // about a vendor that ran; `routedAgent` is the choice, and an item that
      // was routed and never started carries the second without the first
      // rather than borrowing the plan's answer for both.
      ...(run.spawnedAgent === null ? {} : { agent: run.spawnedAgent }),
      ...(run.agent === null ? {} : { routedAgent: run.agent }),
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
      // Ruling 55, all four outcomes through one renderer. `attempts` is the
      // BUILDER's ladder and nothing a reviewer does may raise it (ruling 52):
      // a broken reviewer's re-run is charged to brigadier and lands in
      // `reviewerAttempts` instead.
      attempts: 1,
      attemptsAvailable: rungsOffered(options.admission.ladder),
      ladder: renderLadder(ladderTaken(options.admission.ladder, 1)),
      // Ruling 32's two identities, BOTH from spawns. This pair is the pass/fail
      // property — the reviewer's vendor differs from the builder's — so a name
      // here that came from the routing table could render a same-vendor review
      // as cross-vendor, or the reverse, without anything having gone wrong that
      // a reader could see.
      ...(run.spawnedAgent === null ? {} : { builderAgent: run.spawnedAgent }),
      ...(run.review === null || run.review.spawnedReviewer === null
        ? {}
        : { reviewerAgent: run.review.spawnedReviewer }),
      ...(run.review === null ? {} : { reviewVerdict: run.review.outcome, reviewerAttempts: run.review.reviewerAttempts }),
      ...(run.review === null || run.review.caught.length === 0 ? {} : { caughtDefects: run.review.caught }),
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
          qualifier:
            interruptedBy !== null
              ? "interrupted before dispatch"
              : spend.firstFired !== null
                ? "ceiling stopped dispatch"
                : "never dispatched",
          detail:
            interruptedBy !== null
              ? `${String(interruptedBy)} stopped dispatch before this item was given a directory, so ` +
                "nothing was spawned for it and nothing of it exists to inspect."
              : spend.firstFired !== null
                ? // Ruling 66: WHICH ceiling, by name. "The run stopped early" is
                  // not a fact an operator can act on and a named ceiling with a
                  // number beside it is.
                  `the ${spend.firstFired} stopped dispatch before this item was given a directory. ` +
                  `${spend.tokens.toLocaleString("en-US")} tokens had been spent, read from bytes that ` +
                  "actually crossed the channel. Nothing was spawned for this item and nothing of it " +
                  "exists to inspect. Remedy: raise the ceiling, or split the plan."
                : "this run ended before the item was dispatched",
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
  // The same verdict the CLI computed before it started this run, recomputed
  // from the same three inputs rather than passed down as prose: the sentence in
  // the record has to be the one ruling 66's arithmetic produces, and a string
  // handed through an option is a string a caller could compose differently.
  const ceilingGap = ceilingRefusal(
    options.softCeiling,
    options.hardCeiling,
    options.admission.fanOut[0]?.workers ?? 1,
  );
  // RULING 59, COUNTED RATHER THAN ASSUMED ZERO.
  //
  // This field was the literal `0` on every run brigadier had ever produced,
  // and bar item 9 measured a REAL refusal happening: the marker reached a real
  // vendor's tool shell, `brigadier run --plan whatever` was invoked inside a
  // worker, and the binary exited 3 without orchestrating anything — ruling
  // 57's one unmeasured assumption, measured and holding. The guard fired and
  // nothing counted it, which is indistinguishable from a guard that never
  // fires. The refusing process appends its own line to this run's ledger,
  // because ruling 59 made the worker marker an IDENTITY rather than a boolean
  // precisely so it could find the record to write to; this reads it back.
  const refusals = readRefusals(refusalLedgerPath(options.runRoot, runId));
  if (refusals.damagedLines > 0) {
    notes.push(
      `${refusals.damagedLines} line(s) of the refusal ledger did not parse and are NOT in the count ` +
        `above, so ${refusals.count} is a lower bound on refused delegations.`,
    );
  }

  const quota: Record<string, "read" | "unreadable" | "unpriceable"> = {};
  for (const agent of options.admission.agents) {
    // Ruling 13's quota half, and it is never optimistic: brigadier has never
    // measured a way to read a vendor's remaining quota, and #42 measured
    // opencode reaching a model with no credential at all through its own
    // gateway — so a successful turn there proves nothing about which account
    // was billed.
    //
    // AND NOTHING HERE IS CACHED, which is the second measured trap: `resetsAt`
    // DRIFTS WITH WALL CLOCK, so a cache keyed on it goes stale silently and
    // serves a quota reading for a window that has already closed. The answer
    // is recomputed per run rather than remembered, and there is deliberately
    // no key here for a later reader to add one to.
    quota[agent.id] = agent.id === "opencode" ? "unpriceable" : "unreadable";
  }

  // Identities, deduped across items, and never a count on its own: a count can
  // be printed by anything, and a list of markers generated after the binary was
  // built can only be produced by something that read the diff.
  const caughtAll = [...new Set(runs.flatMap((run) => run.review?.caught ?? []))];
  // Ruling 52's budget rule, made countable: everything past the first attempt
  // is a re-run of a BROKEN reviewer and is charged to brigadier.
  const reviewerReruns = runs.reduce((total, run) => total + Math.max(0, (run.review?.reviewerAttempts ?? 0) - 1), 0);
  // `crossVendor: true` is asserted only where a reviewer of a different vendor
  // REALLY RAN. A plan of nothing but `read-only` items has no diff to review at
  // all (ruling 49), and recording the machine's CAPABILITY as though it were an
  // event is exactly the field-shaped version of the rule ruling 32 states in
  // prose — so the run-level answer says which of the three happened.
  //
  // AND IT IS COUNTED FROM SPAWNS. `run.review.reviewer` is the vendor the
  // router chose; `spawnedReviewer` is the one whose process started. A run
  // where the reviewer was routed and never spawned satisfied the first and
  // recorded a review that did not happen.
  const spawnedBuilders = [...new Set(runs.map((run) => run.spawnedAgent).filter((id): id is string => id !== null))];
  const spawnedReviewers = [
    ...new Set(runs.map((run) => run.review?.spawnedReviewer ?? null).filter((id): id is string => id !== null)),
  ];
  const reviewedAny = spawnedReviewers.length > 0;
  // TWO facts, and this used to derive both from one. No reviewer spawns in two
  // unrelated situations: the plan carried no `write` item at all, so ruling 49
  // left nothing to review; or `write` items were planned and NONE produced a
  // diff to hand over. `reviewedAny` cannot tell those apart. `writeItems` can,
  // and it is already counted above for the deliverable.
  //
  // MEASURED 2026-08-21 by the second independent verifier, run `mt2x09vpa2fd`:
  // five items, every one `kind: write`, all five workers dead at their first
  // `session/prompt`, and the report told the operator *"no item in this plan is
  // a `write` item"*. The plan's shape was being read off the reviewer's fate.
  // The operator's conclusion from that sentence is that the plan was read-only
  // and no review was owed, which is ruling 58's cap hiding a failure's KIND.
  // `OWNER-QUESTIONS.md` #15.
  const nothingReviewable =
    "no item in this plan is a `write` item, so ruling 49 left no diff for a reviewer to be handed " +
    "and ruling 32's cross-vendor rule had nothing to apply to. Nothing was reviewed and nothing " +
    "here claims otherwise.";
  const nothingReachedAReviewer =
    `${writeItems} \`write\` item(s) were planned and none reached a reviewer, because none produced ` +
    "a diff to hand over. This is NOT a read-only plan, and ruling 32's cross-vendor rule was never " +
    "tested here.";
  // Where write items existed and none was reviewed, that fact outranks a
  // same-vendor reason: `sameVendorReason` explains how a review WOULD have been
  // routed, and printing it alone describes a review that never happened.
  const noReviewerReason =
    writeItems === 0 ? (reviewer.sameVendorReason ?? nothingReviewable) : nothingReachedAReviewer;
  // A cross-vendor promise the SPAWNS did not keep is stated rather than left
  // to print as "no reason was recorded". The router decides from `PATH`; what
  // actually started is the only thing that settles ruling 32, and when the two
  // disagree the disagreement is the reason.
  const routedCrossVendorBroken =
    reviewer.crossVendor &&
    reviewedAny &&
    spawnedReviewers.some((id) => spawnedBuilders.includes(id));
  const reviewReason = routedCrossVendorBroken
    ? `the reviewer was ROUTED cross-vendor and the processes that actually spawned were not: ` +
      `builders ${spawnedBuilders.join(", ")}, reviewers ${spawnedReviewers.join(", ")}. Ruling 32's ` +
      "property is a comparison between what ran, so this review is recorded as the weaker one it was."
    : reviewedAny
      ? reviewer.sameVendorReason
      : noReviewerReason;

  const runRecord: RunRecord = {
    runId,
    integrationRef: branchRef,
    ...(integrationSha === null ? {} : { integrationSha }),
    base: { ref: base.ref, sha: base.sha },
    runChecks: [checkRecord(deliverable)],
    runRoot: options.runRoot,
    bindingFilter: options.admission.fanOut[0]?.boundBy ?? "item-count",
    workers: options.admission.fanOut[0]?.workers ?? 0,
    refusedDelegations: refusals.count,
    // DECISION 17, PER VENDOR RATHER THAN AS A BLANKET CLAIM.
    //
    // This read *"the agent's config root is redirected … for every worker"* on
    // every run, unconditionally. It is not true for every worker: the redirect
    // is `LaunchProfile.configRootEnv`, and MEASURED against this tree on
    // 2026-08-18 two of the shipped profiles — copilot and gemini — declare no
    // such variable, so nothing about their config root is changed and a
    // user-global instruction file under `$HOME` is still theirs to read. A run
    // on one of those vendors was claiming a suppression it had not performed,
    // which is the same shape as a check reporting success for something that
    // did not happen — the defect this codebase exists to remove, one field over.
    ambientSuppressed: ambientSuppression(options.admission.agents),
    // Ruling 32's standing rule as a FIELD rather than a sentence. `crossVendor`
    // is true only when a reviewer of a different vendor actually ran; writing
    // `true` because two vendors happened to resolve on `PATH` would be a record
    // claiming a review that never ran, which is the shape ruling 52 exists to
    // stop and the one a reader of this file is most likely to reintroduce.
    ...(options.review
      ? {
          review: {
            // The PROPERTY, computed rather than copied from the routing
            // choice: every reviewer that spawned is of a vendor no builder
            // that spawned used. Two processes, two identities, one comparison
            // — which is what ruling 32 actually asks and what a field carried
            // down from `admit` could not answer.
            crossVendor:
              reviewedAny &&
              spawnedBuilders.length > 0 &&
              spawnedReviewers.every((id) => !spawnedBuilders.includes(id)),
            ...(reviewReason === undefined ? {} : { sameVendorReason: reviewReason }),
            ...(spawnedReviewers.length === 0 ? {} : { reviewerAgent: spawnedReviewers.join(", ") }),
            ...(spawnedBuilders.length === 0 ? {} : { builderAgent: spawnedBuilders.join(", ") }),
            caught: caughtAll.length,
            ...(options.planted === undefined ? {} : { planted: options.planted }),
            caughtDefects: caughtAll,
            catchRate: catchRateLine(caughtAll.length, options.planted),
            reviewerReruns,
          },
        }
      : {}),
    cost: {
      currency: estimate.unit,
      estimateLow: estimate.low,
      estimateHigh: estimate.high,
      provenance: estimate.provenance,
      // WHAT THE RUN ACTUALLY SPENT, and the three things that makes it and the
      // one it does not:
      //
      //   it is MEASURED — bytes that crossed the channel, in both directions,
      //   counted as they crossed;
      //   it is NOT `usage_update` — the drive measured `used` plateauing for
      //   five turns while history was rewritten, so that field MASKS
      //   compaction and reports a run's most expensive turns as its cheapest;
      //   it is converted to tokens by the SAME arithmetic as the estimate, so
      //   `actual` and `estimateHigh` are comparable rather than two units
      //   wearing one name.
      //
      // What it is not: a vendor's own accounting. #46 measured three of six
      // agents emitting no usage at all, and `lowerBound` below carries the
      // consequence when opencode is in the vendor set.
      actual: spend.tokens,
      ...(options.softCeiling === undefined ? {} : { softCeiling: options.softCeiling }),
      ...(options.hardCeiling === undefined ? {} : { hardCeiling: options.hardCeiling }),
      // Ruling 66's structural rule, carried instead of shouted once. The CLI
      // prints this before anything is spent; a record that dropped it would
      // describe a soft ceiling the reader has no way to know was weakened.
      ...(ceilingGap === null || ceilingGap.refuse ? {} : { gapWarning: ceilingGap.lines.join(" ") }),
      // Ruling 66: the report DISTINGUISHES them, so the record carries them
      // apart. Written unconditionally rather than only when true — an absent
      // boolean reads as "not measured", and these were.
      softCeilingHit: spend.softHit,
      hardCeilingHit: spend.hardHit,
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
    budgetSpent: options.prologueTokens ?? 0,
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

/**
 * Decision 17's suppression, said per vendor because that is how it works.
 *
 * `buildEnvironment` sets `profile.configRootEnv` to the item's own state
 * directory, and a profile that declares no such variable gets no redirect at
 * all — there is no universal lever, only a per-vendor one. So the record names
 * both halves: the vendors it was applied to, and the vendors it could not be
 * applied to and why.
 *
 * The second half is the one that matters. A run that suppressed nothing while
 * recording that it had is indistinguishable, to every reader and every bar
 * item, from a run that suppressed everything.
 */
export function ambientSuppression(agents: readonly { id: string; profile: { configRootEnv?: string } }[]): string[] {
  const lines: string[] = [];
  const redirected = agents.filter((agent) => agent.profile.configRootEnv !== undefined);
  const bare = agents.filter((agent) => agent.profile.configRootEnv === undefined);
  if (redirected.length > 0) {
    lines.push(
      `the config root is redirected into brigadier's own state directory for ` +
        `${redirected.map((agent) => `${agent.id} (${agent.profile.configRootEnv})`).join(", ")} (decision 17)`,
    );
  }
  if (bare.length > 0) {
    lines.push(
      `NO config-root redirect exists for ${bare.map((agent) => agent.id).join(", ")}: their launch profile ` +
        "declares no variable for it, so decision 17's lever could not be pulled and a user-global " +
        "instruction file under $HOME is still readable by them. Stated rather than assumed away — a " +
        "suppression that did not happen must not be recorded as one.",
    );
  }
  // The worker marker is universal and is the one that does hold everywhere.
  lines.push("brigadier's own plugin is inert inside every worker: the worker marker is set on all of them (ruling 57)");
  return lines;
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
