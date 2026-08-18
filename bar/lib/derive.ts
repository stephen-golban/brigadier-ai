// SPDX-License-Identifier: Apache-2.0
/**
 * Values the plan does not contain.
 *
 * The defect this file exists to close: the previous harness put the token the
 * merged tree had to carry **into the plan it handed the binary** — in
 * `directive.token`, and again in the prompt. A forger that did no work at all
 * scored 12 of 13 by echoing the answer key back through `git hash-object` and
 * `commit-tree`. The whole spine reduced to `cat` plus about forty lines of
 * plumbing.
 *
 * So the value an item demands back out of the object store is now DERIVED from
 * a nonce that lives only in the cloned repository's content — present in the
 * base commit, and therefore in every clone, and never in the plan, the prompt
 * or the environment. A worker reads it and transforms it. A forger that never
 * clones has to reconstruct the base commit to find it, which means implementing
 * ruling 33's rule (HEAD plus uncommitted TRACKED plus UNTRACKED) and ruling
 * 50's exclusion (nothing gitignored) — at which point it has built the thing.
 *
 * This does not make the box unforgeable, and nothing can. A sufficiently
 * determined fake eventually IS an implementation, and that is the point: the
 * standard is that the cheapest forgery must implement the promise.
 */

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";

/**
 * The transformation a worker must perform.
 *
 * A hash rather than a copy, so the required output is not a substring of
 * anything the harness handed over and cannot be produced by moving bytes
 * around. Truncated because a check nobody can read in a report is a check
 * nobody will re-derive.
 */
export function derive(nonce: string, salt: string): string {
  return createHash("sha256").update(`${nonce.trim()}:${salt}`).digest("hex").slice(0, 24);
}

/** A nonce, generated after the artifact under test was built. */
export function nonce(label = "n"): string {
  return `${label}-${randomBytes(12).toString("hex")}`;
}

export interface Seed {
  /** Path inside the repository where the nonce is planted. */
  path: string;
  value: string;
  /**
   * How the nonce reaches the clone. Ruling 33 repairing ruling 7: a worker sees
   * the owner's uncommitted TRACKED and UNTRACKED work, so both shapes are
   * planted and both must arrive. Ruling 50: a gitignored one must NOT.
   */
  placement: "committed" | "uncommitted-tracked" | "untracked" | "gitignored";
}

/** What the worker must write, given a seed and the item that owns it. */
export function expectedFor(seed: Seed, salt: string): string {
  return derive(seed.value, salt);
}
