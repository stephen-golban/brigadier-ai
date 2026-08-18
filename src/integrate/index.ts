// SPDX-License-Identifier: Apache-2.0
/**
 * Integration: getting work out of a clone and into the operator's repository.
 *
 * Ruling 51, with ruling 54's waves and ruling 52's gate. The whole module is
 * one sentence made mechanical:
 *
 *     The parent fetches from the clone, merges without a working tree, and
 *     publishes in one transaction — so the operator's tree is where they left
 *     it, not because brigadier was careful, but because nothing it runs can
 *     move it.
 *
 *     integrateWave        — fetch → ownership → merge → publish, in plan
 *                            order, from a base commit. One transaction at the
 *                            end. A conflicted or strayed item is reported and
 *                            integration continues.
 *     runIntegrationGate   — the verify command, once more, on the MERGED
 *                            commit, in a dedicated clone under brigadier's own
 *                            root, reported in its own slot.
 *     planWaves            — the plan's dependsOn graph in wave order; a cycle
 *                            is rejected here rather than discovered at run
 *                            time.
 *     attemptable          — which of a wave's items may run given what
 *                            actually integrated. The rest are never attempted.
 *     waveBoundary         — wave N+1 starts only if wave N's gate did not
 *                            block.
 *     renderRun            — and partial integration never renders as success.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO:
 *
 *   - it never runs a git command inside a worker clone. Ruling 56's
 *     enumeration for a dedicated clone is EMPTY, and the ownership diff — the
 *     one operation that looked like it had to happen in there — computes
 *     identically in the parent once the ref is fetched. That is measured, in
 *     `test/integrate-parity.test.ts`, with both `.git` execution families
 *     planted and a canary asserted OUTSIDE the clone;
 *   - it never resolves a conflict, and never asks an agent to;
 *   - it never deletes the integration branch. The only ref brigadier makes
 *     visible is the only ref it never deletes, and `isDeletableRef` covers
 *     `refs/brigadier/` alone precisely so it can never reach this one;
 *   - it never runs `git checkout` in the operator's repository. `parent.ts`
 *     refuses it, along with every other command that would touch a working
 *     tree, an index or HEAD.
 */

export {
  discardGateClone,
  gateCloneDir,
  initialIntegrationCheck,
  INTEGRATION_CHECK,
  runIntegrationGate,
  type IntegrationGateResult,
  type IntegrationGateSpec,
} from "./gate.ts";

export {
  integrateWave,
  ItemRefOccupied,
  type IntegrationItem,
  type ItemIntegration,
  type ItemOutcome,
  type WaveIntegration,
  type WaveSpec,
} from "./integrate.ts";

export {
  BRIGADIER_IDENTITY,
  commitTree,
  mergeTree,
  mergeTreeArgv,
  MergeUnavailable,
  parseMergeTree,
  type CommitIdentity,
  type MergeAttempt,
} from "./merge.ts";

export {
  assertUsableDeclaration,
  declarationMatcher,
  isDeclared,
  judgeOwnership,
  ownershipRefusal,
  touchedPaths,
  UnusableDeclaration,
  type OwnershipVerdict,
} from "./ownership.ts";

export {
  assertLocalPathTransport,
  assertNoWorkingTreeCommand,
  parentGit,
  parentGitRaw,
  refSha,
  PARENT_COMMANDS,
  subcommandOf,
  WorkingTreeCommandRefused,
} from "./parent.ts";

export {
  headline,
  renderRun,
  runSucceeded,
  tally,
  type RunOutcome,
  type Tally,
} from "./report.ts";

export {
  applyRefTransaction,
  assertOwnedRef,
  assertPublishCommand,
  RefRefused,
  TransactionFailed,
  transactionStdin,
  type RefEntry,
} from "./transaction.ts";

export {
  GitTooOld,
  MERGE_TREE_FLOOR,
  meetsFloor,
  parseGitVersion,
  requireGitVersion,
  versionRefusal,
  type GitVersion,
} from "./version.ts";

export {
  attemptable,
  CyclicPlan,
  planWaves,
  prerequisiteCheck,
  UnusablePlan,
  waveBoundary,
  type Attemptable,
  type WaveBoundary,
  type WaveItem,
} from "./waves.ts";
