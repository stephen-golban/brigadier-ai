// SPDX-License-Identifier: Apache-2.0
/**
 * The run: what brigadier records while it works, and what it reclaims
 * afterwards — and, ruling 38, what it reclaims BEFORE it starts.
 *
 *     runMarkerArg        — the token that goes in every spawned process's
 *                           COMMAND LINE. Ruling 38's matching surface, and
 *                           ruling 57's second marker: the environment variable
 *                           `BRIGADIER_WORKER` does a different job and neither
 *                           substitutes for the other.
 *     appendEvent         — the run record. NDJSON, appended, never rewritten,
 *                           so a file truncated by a kill is still evidence.
 *     openCheckSlot       — ruling 52's write-ahead: the slot exists, holding a
 *                           BLOCKING value, before the check runs.
 *     sweep               — ruling 38's reclamation sweep. Matches on the
 *                           command line, terminates, confirms with signal 0,
 *                           and produces the `ReclamationEvidence` that
 *                           `recycleClone` cannot be called without.
 *     sweepAtStart        — the same sweep at the moment it matters most, plus
 *                           ruling 63's seam: processes always, directories only
 *                           for runs that are complete — and scoped to runs THIS
 *                           root has a record of, because a marker is identity
 *                           and not authority.
 *     inspectClone        — ruling 63's retention clause is a claim about
 *                           CONTENT ("it may hold the only copy of someone's
 *                           work"), so the question is put to git rather than to
 *                           a record. A clone git positively reports as empty is
 *                           reclaimed; every unknown is retained and says so.
 *     dischargeRun        — the only thing that makes a retained directory
 *                           deletable. Permission, not an instruction.
 *     proveDeletableDirectory / reclaimRef
 *                         — ruling 15's three proofs and ruling 50's fourth.
 *
 * THE ONE CLAIM THIS MODULE REFUSES TO MAKE. `ReclamationEvidence.survivors`
 * being empty is not proof that the sweep found every process, and nothing here
 * pretends otherwise: `SweepCoverage.completeness` is the constant
 * `"not-proven"`, `SweepCoverage.limits` names each thing a process-table scan
 * cannot see, and `describeSweep` prints both on a clean sweep as well as a
 * dirty one. `assertReclaimed` in `src/isolation/` was left exactly as strict as
 * it was; the honest response to a check that cannot verify completeness is to
 * state the gap, not to widen the check.
 */

export {
  CANCEL_DEADLINE_MS,
  abandon,
  describeUnfinished,
  initialState,
  onSignal,
  type InterruptPhase,
  type InterruptState,
  type UnfinishedRun,
} from "./interrupt.ts";

export {
  CHANGED_PATHS_SHOWN,
  describeWork,
  inspectClone,
  resolveHead,
  resolveRef,
  type CloneWork,
  type InspectOptions,
  type WorkState,
} from "./kept.ts";

export { markerMatches, parseRunMarker, runMarkerArg, type MarkerScope, type RunMarker } from "./marker.ts";

export {
  POSIX_CWD_SCAN,
  POSIX_SCAN,
  POSIX_TTY_SCAN,
  READER_TIMEOUT_MS,
  SCAN_LIMITS,
  WINDOWS_SCAN,
  ancestorsOf,
  descendantsOf,
  isAlive,
  noWorkspaceReading,
  parseCwdRows,
  parseProcessRows,
  parseTerminalRows,
  readWorkspaceOccupants,
  scanProcessTable,
  signalPid,
  type ProcessRow,
  type ProcessTable,
  type SignalResult,
  type WorkspaceReading,
} from "./processes.ts";

export {
  RECORD_NAME,
  appendEvent,
  checkSlots,
  claimedLandings,
  dischargedItems,
  finishedIntent,
  itemsMentioned,
  openCheckSlot,
  readRunRecord,
  recordPath,
  runFacts,
  settleCheck,
  spawnedProcesses,
  type CheckSlot,
  type RecordReading,
  type RunEvent,
  type RunEventType,
} from "./record.ts";

export {
  directoryBytes,
  listOwnedRefs,
  proveDeletableDirectory,
  reclaimDirectory,
  reclaimRef,
  type DeleteVerdict,
  type DirectoryProof,
  type DirectoryReclamation,
  type GitRunner,
  type OwnedRef,
  type RefReclamation,
} from "./reclaim.ts";

export {
  KILL_GRACE_MS,
  TERM_GRACE_MS,
  describeSweep,
  sweep,
  type Disposition,
  type MatchedProcess,
  type SweepCoverage,
  type SweepOptions,
  type SweepOutcome,
  type Workspace,
} from "./sweep.ts";

export {
  describeRetention,
  describeStartSweep,
  dischargeItem,
  dischargeRun,
  judgeRun,
  runInFlight,
  runsUnder,
  sweepAtStart,
  unfinishedFrom,
  type Completion,
  type InFlightRun,
  type RetainedDirectory,
  type RunOnDisk,
  type RunVerdict,
  type StartSweepOptions,
  type StartSweepReport,
} from "./start.ts";
