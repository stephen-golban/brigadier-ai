// SPDX-License-Identifier: Apache-2.0
/**
 * The queue: everything between "here is a plan" and "here is what happened".
 *
 * The split inside this directory is the split between the two things a run
 * has to be honest about, and they have different costs:
 *
 *     plan.ts / admit.ts / estimate.ts   decided BEFORE anything is spent, and
 *                                        therefore free to be wrong out loud —
 *                                        a refusal here creates no process and
 *                                        no clone (rulings 13, 52, 53, 54).
 *     brief.ts / spawn.ts / execute.ts    spent. Every one of these leaves
 *                                        something on disk or in the process
 *                                        table, and every one of them is
 *                                        reclaimable by ruling 38's sweep
 *                                        because it carries ruling 38's marker.
 *
 * Nothing here re-decides anything the modules it composes already settled. If
 * a rule appears both here and in `src/isolation/`, `src/integrate/`,
 * `src/run/` or `src/work/`, this file is wrong.
 */

export {
  LEGALITY_UNBOUNDED,
  admit,
  agentsOnPath,
  bindingSentence,
  collapsedItems,
  describeAdmission,
  describeItem,
  describeRefusals,
  ladderFor,
  rungsAvailable,
  type Admission,
  type AdmitInput,
  type ResolvedAgent,
} from "./admit.ts";

export { BRIEF_PREFIX, briefFor, composeBrief } from "./brief.ts";

export {
  CEILING,
  CLAUDE_THINKING_OFF,
  CLAUDE_THINKING_ON,
  EFFORT_ORDER,
  atMost,
  chooseEffortModel,
  deriveEffort,
  effortOf,
  leverFor,
  noLever,
  renderEffort,
  switchState,
  type EffortDisposition,
  type EffortLever,
  type EffortOutcome,
  type EffortRequest,
} from "./effort.ts";

export {
  MEASURED_ITEM_BYTES,
  NO_SAVINGS_CLAIM,
  activeLevers,
  ceilingRefusal,
  describeEstimate,
  estimatePlan,
  itemCeilingReserve,
  naiveItemTokens,
  narrowGapLines,
  tokensFromBytes,
  type CeilingVerdict,
  type Estimate,
} from "./estimate.ts";

export {
  REFUSAL_LEDGER,
  RUN_ROOT_ENV,
  readRefusals,
  recordRefusal,
  refusalLedgerPath,
  type RefusalAppender,
  type RefusalRecording,
  type RefusalTally,
  type RefusedDelegation,
} from "./refusal.ts";

export {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REVIEW_TIMEOUT_MS,
  NO_REVIEWER,
  DEFAULT_VERIFY_TIMEOUT_MS,
  DEFAULT_WORKER_TIMEOUT_MS,
  ambientSuppression,
  executeRun,
  newRunId,
  runRootUsable,
  type ExecuteOptions,
  type ExecuteResult,
} from "./execute.ts";

export {
  DEFAULT_DIFFICULTY_CEILING,
  DIFFICULTY_ORDER,
  PlanUnreadable,
  clampDifficulty,
  parsePlan,
  requirementRefusal,
  validatePlan,
  type AgentOnLadder,
  type Difficulty,
  type PlanItemSpec,
  type PlanRefusal,
  type PlanSpec,
  type PlannedItem,
  type ValidatedPlan,
  type ValidationInput,
} from "./plan.ts";

export {
  EFFORT_REQUEST_ID,
  MARKER_FLAG,
  gradedEffortChannel,
  spawnMarkedAgent,
  type MarkedSpawn,
  type MarkedSpawnOptions,
} from "./spawn.ts";
