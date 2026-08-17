// SPDX-License-Identifier: Apache-2.0
/**
 * How brigadier invokes git around a directory an agent can write to.
 *
 * Ruling 56, and the invariant is not the one #30 proposed. The ticket asked to
 * neuter hooks on every git command brigadier runs, and to enumerate those
 * commands so each could be covered. Measuring it changed the shape of the
 * answer twice.
 *
 * FIRST: a hook that fires on the AGENT'S OWN `git commit` is not an
 * escalation. It runs with the agent's privileges, which the agent already has.
 * The escalation exists only when *brigadier* runs the command — so the
 * invariant is about brigadier's behaviour, not the clone's contents, and the
 * fix is not to sanitise a directory the agent owns. It is not to be in it:
 *
 *     brigadier runs no git command inside a clone after an agent has had
 *     access to it.
 *
 * Under that invariant the enumeration the ticket asked for is EMPTY for a
 * dedicated clone, and a list of zero is easier to keep true than a list of
 * twenty. What makes it possible is measured: ruling 51's ownership check
 * `git diff --name-only <base>..work` computes IDENTICALLY in the parent once
 * the item's ref has been fetched, so the one operation that looked like it had
 * to happen in the clone does not.
 *
 * SECOND: there are two execution families and `core.hooksPath` closes one.
 * MEASURED (probes/git-exec.sh, git 2.50.1, macOS 26.5.2, 2026-08-17 — 26
 * checks, 26 passed, 6 negative controls, each asserting on a canary file
 * written OUTSIDE the clone rather than on the presence of a flag):
 *
 *   - `pre-commit` escaped on `git commit`; `post-checkout` on `git checkout`;
 *     and `reference-transaction` on `git update-ref`, which is ruling 51's
 *     exact integration command and is on nobody's mental list of hooks.
 *   - `--no-verify` does NOT cover `post-checkout`.
 *   - Replacing `.git/hooks` with an unwritable file is INEFFECTIVE: the commit
 *     still succeeds, and an agent that deletes it and recreates the directory
 *     gets its hook run again.
 *   - `-c core.hooksPath=<empty>` does NOT close `core.fsmonitor`, which
 *     executes on an ordinary `git status`. That is a second family, and
 *     defending it with `-c <key>=` overrides is a blocklist against a config
 *     surface git keeps growing.
 *   - A `.gitattributes` naming `filter=evil` is INERT until
 *     `filter.evil.smudge` exists in `.git/config`. Attributes are a selector
 *     for an execution surface, not one — so defending `.git/config` defends
 *     the family v1's LFS defect came from.
 */

import { join } from "node:path";

/**
 * Defence in depth on every brigadier git invocation.
 *
 * The invariant above makes this redundant for a dedicated clone. It is kept
 * anyway, and annotated, because redundant defences rot quietly and this one
 * will look removable to someone reading the code without ruling 56. It costs
 * two argv entries and it covers a hook planted by a race.
 */
export function hooklessArgs(emptyHooksDir: string): string[] {
  return ["-c", `core.hooksPath=${emptyHooksDir}`];
}

/**
 * The ordering ruling 51 and ruling 56 jointly fix: FETCH, then check
 * ownership, then merge.
 *
 * A future refactor that computes ownership "earlier, in the clone, to fail
 * faster" would reopen both execution families. That is why the reason is here
 * and not in a commit message.
 */
export function ownershipDiffArgv(baseRef: string, itemRef: string): string[] {
  // Run in the PARENT, never with `-C <clone>`. Measured to give the same
  // paths in the same order as the clone-side diff.
  return ["diff", "--name-only", `${baseRef}..${itemRef}`];
}

/**
 * The one place brigadier must re-enter a directory an agent could write to:
 * ruling 49's pooled `read-only` recycle (`fetch`, `checkout <ref>`,
 * `clean -fdx`).
 *
 * MEASURED both ways. Without this restore, recycling executed BOTH families —
 * the planted `post-checkout` fired on the checkout and the planted
 * `core.fsmonitor` fired on the status. With it, neither did.
 *
 * Both steps are plain filesystem operations performed BEFORE git is invoked at
 * all, so there is no git command whose behaviour the planted content can
 * influence. Order matters: restore, then run.
 */
export interface PooledRestore {
  /** Delete and recreate, empty. An agent may have planted any hook name. */
  hooksDir: string;
  /** Overwrite from the copy brigadier wrote when the directory was created. */
  configPath: string;
  knownGoodConfigPath: string;
}

export function pooledRestore(cloneDir: string, knownGoodConfigPath: string): PooledRestore {
  return {
    hooksDir: join(cloneDir, ".git", "hooks"),
    configPath: join(cloneDir, ".git", "config"),
    knownGoodConfigPath,
  };
}

/**
 * Ruling 51's fetch is `git -C <parent> fetch <clone-path> …`, and
 * `uploadpack.packObjectsHook` set inside the clone was measured NOT to fire.
 *
 * That is a NAMED CONDITION rather than a blank cheque: a local-path fetch does
 * not spawn `upload-pack`, so it holds because of the transport. If this ever
 * becomes a `file://` URL or anything else that does spawn it, the surface
 * returns. This constant exists so a change has something to trip over.
 */
export const FETCH_TRANSPORT_MUST_STAY = "local-path" as const;
