// SPDX-License-Identifier: Apache-2.0
/**
 * The ref namespace brigadier writes into the operator's repository, and the
 * rule for deleting from it.
 *
 * Ruling 50. This exists because ruling 15 does not cover it and cannot be made
 * to: ruling 15's three ownership proofs are about PATHS — inside brigadier's
 * root by `realpath`, recorded in a manifest, carrying a marker file — and a
 * ref lives inside the *operator's* `.git`, which is outside brigadier's root
 * by construction. Reading ruling 15 as authorising a ref delete would be the
 * exact class of error this map keeps catching, so refs get a fourth rule of
 * the same shape rather than a generous reading of the existing three.
 *
 * The rule, in full:
 *
 *   A ref is deletable only if it is under `refs/brigadier/<run-id>/`, its
 *   `<run-id>` appears in a run manifest written BEFORE the ref existed, and
 *   the delete is the compare-and-swap form `git update-ref -d <ref> <sha>`.
 *
 * MEASURED (`probes/base-state.sh`, git 2.50.1, macOS 26.5.2, 2026-08-17): a
 * ref outside `refs/heads/` is invisible to `git branch` and is NOT carried by
 * a default `git clone`, so the namespace does not leak into the operator's
 * branch list or into a worker's clone. The worker gets the base commit through
 * an explicit fetch instead.
 */

/**
 * Everything brigadier writes lives under here. Deliberately not
 * `refs/heads/brigadier/*`: that would appear in the operator's `git branch`,
 * in their tab completion, and in a default clone's refspec.
 */
export const REF_NAMESPACE = "refs/brigadier";

/** A run id is opaque to this module but must not be able to escape the namespace. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function baseRef(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`unusable run id: ${JSON.stringify(runId)}`);
  return `${REF_NAMESPACE}/${runId}/base`;
}

/**
 * The first two of ruling 50's three conditions. The third — that the manifest
 * was written before the ref existed — is the manifest's to enforce, and the
 * `knownRunIds` argument is where it arrives.
 *
 * Deliberately string-exact rather than a prefix test on `refs/brigadier`
 * alone: `refs/brigadier-of-someone-else/x` shares that prefix and is not ours.
 */
export function isDeletableRef(ref: string, knownRunIds: readonly string[]): boolean {
  const prefix = `${REF_NAMESPACE}/`;
  if (!ref.startsWith(prefix)) return false;
  const rest = ref.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return false;
  const runId = rest.slice(0, slash);
  if (!RUN_ID.test(runId)) return false;
  return knownRunIds.includes(runId);
}

/**
 * The argv for deleting one of our refs.
 *
 * The `expectedSha` argument is not optional and there is no overload without
 * it. `git update-ref -d <ref>` deletes whatever the ref currently points at;
 * the three-argument form refuses if it has moved. A ref that moved under us
 * means something we do not understand is happening in the operator's
 * repository, and the correct response is to report rather than to win.
 */
export function deleteRefArgv(ref: string, expectedSha: string, knownRunIds: readonly string[]): string[] {
  if (!isDeletableRef(ref, knownRunIds)) {
    throw new Error(`refusing to delete a ref brigadier does not own: ${ref}`);
  }
  if (!/^[0-9a-f]{7,64}$/.test(expectedSha)) {
    throw new Error(`refusing a ref delete without a full expected sha: ${expectedSha}`);
  }
  return ["update-ref", "-d", ref, expectedSha];
}
