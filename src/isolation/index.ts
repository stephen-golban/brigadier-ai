// SPDX-License-Identifier: Apache-2.0
/**
 * Isolation: one clone per unit of work, built from a base state that carries
 * the operator's uncommitted work, placed where ruling 61 puts it, and handed
 * to an agent behind a capability that is revoked as it goes.
 *
 *     buildBaseState  — capture HEAD plus uncommitted tracked AND untracked
 *                       work as a commit, publish it at
 *                       `refs/brigadier/<run-id>/base`, and witness that the
 *                       operator's repository did not move while doing it.
 *     prepareClone    — refuse before creating anything if the placement, the
 *                       path budget or the target is wrong; otherwise clone,
 *                       match `core.autocrlf`, fetch the base explicitly, check
 *                       out `work`, and drop `origin`.
 *     releaseToAgent  — hand the directory over, and revoke brigadier's ability
 *                       to run git in it.
 *     recycleClone    — ruling 49's pooled recycle, and the only way to get
 *                       that ability back. It restores `.git/hooks` and
 *                       `.git/config` as filesystem operations before git is
 *                       invoked at all, and again before every spawn after
 *                       that. Requires `ReclamationEvidence`.
 *     discardClone    — delete it. No git involved.
 *     witnessOperator — the four facts, for the operator's repository. It
 *                       refuses a worker clone like everything else here.
 *
 * WHERE RULING 56 IS ENFORCED, since this is the thing that was got wrong twice
 * already: at the single point in `internal-git.ts` where a process is spawned,
 * and nowhere else. Not by which symbols this file exports — `witnessOperator`
 * and `buildBaseState` take a bare path and are the same capability under a
 * friendlier name, so an export list was never going to be the boundary. Every
 * git invocation is either authorised by a capability token for one specific
 * clone that brigadier owns right now, or refused if its target is a worker
 * clone. `releaseToAgent` deletes the token, so the check fails CLOSED.
 *
 * And a token is not enough on its own, which is the correction `clone.ts`
 * opens with: it proves the directory is brigadier's, not that the directory is
 * clean. So the hooks sink, the empty global config and the clone's
 * `.git/config` are all rewritten from memory IMMEDIATELY BEFORE EVERY SPAWN,
 * because git re-reads its config from disk every time. Recycling additionally
 * requires `ReclamationEvidence` — proof from ruling 38's sweep that the item's
 * processes are gone — because sanitisation is instantaneous and an agent's
 * processes may still be alive.
 *
 * What that does NOT claim: none of it is a boundary against an agent that has
 * already escaped its sandbox and can write anywhere in the operator's home
 * directory. Such an agent can delete the token — and gets a refusal, because
 * the token's absence is the refusal. It cannot forge one, because it has never
 * seen the nonce. It can delete the run manifest, and `test/isolation-live.test.ts`
 * asserts what that costs. That is the honest extent of it.
 *
 * Integration — the parent fetching from the clone, `merge-tree --write-tree`,
 * `update-ref --stdin` — is ruling 51's, a different module owned by a
 * different slice, and is deliberately absent.
 */

export {
  buildBaseState,
  OperatorRepoDisturbed,
  seedVerdict,
  statusRecords,
  type BaseState,
  type BaseStateOptions,
} from "./base.ts";

export {
  assertReclaimed,
  discardClone,
  intendedRealPath,
  NotReclaimed,
  pathBudgetRefusal,
  prepareClone,
  realTempDirs,
  recycleClone,
  releaseToAgent,
  type AgentOwnedClone,
  type CloneSpec,
  type PreparedClone,
  type ReclamationEvidence,
  type RecycleSpec,
} from "./clone.ts";

export { allowedEnv, GitRefused } from "./internal-git.ts";
export { claimedByManifest, readManifest, type RunManifest } from "./manifest.ts";
export { resetDirectory, UnsafePath, writeRegularFile } from "./safe-fs.ts";

export {
  hashWorkingTree,
  witnessDrift,
  witnessOperator,
  type OperatorWitness,
  type WitnessOptions,
} from "./witness.ts";
