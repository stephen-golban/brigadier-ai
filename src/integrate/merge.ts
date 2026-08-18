// SPDX-License-Identifier: Apache-2.0
/**
 * The merge itself: a real recursive merge with NO checkout and NO index.
 *
 * Ruling 51. MEASURED against `git 2.50.1` on 2026-08-17 (`probes/integration.sh`
 * checks 3a–3e, re-measured in `test/integrate.test.ts`):
 *
 *   - two items on disjoint paths merged at **rc=0**, and the tree
 *     `--write-tree` wrote carried BOTH items' bytes, read back with
 *     `git cat-file` — a real recursive merge, not a fast-forward and not a
 *     tree-level union;
 *   - a genuine conflict on one path returned **non-zero** and, with
 *     `--name-only`, NAMED that path instead of inventing a resolution;
 *   - the operator's working tree, `.git/index` and HEAD were untouched
 *     throughout, because none of these commands has any use for them.
 *
 * TWO MEASURED FACTS THAT CHANGE THE CODE, both about how failure arrives:
 *
 *   1. rc alone cannot tell a conflict from an error. MEASURED against
 *      `git 2.50.1` on 2026-08-17: a genuine conflict exited **1**, and so did
 *      `merge-tree` given a ref that does not exist
 *      (`merge-tree: <ref> - not something we can merge`). The two are told
 *      apart STRUCTURALLY — a conflict still writes a tree and prints its OID
 *      as the first record, an error prints nothing on stdout — and this module
 *      refuses to guess when stdout does not begin with an OID.
 *
 *   2. the trivial three-argument mode still exists and still exits 0. That is
 *      `version.ts`'s floor, and the reason it is a refusal rather than a note.
 *
 * The `-z` output form is used for the same reason `ownership.ts` uses it: the
 * conflicted-path list is filenames, and a filename can contain anything.
 * MEASURED against `git 2.50.1` on 2026-08-17, `--write-tree --name-only -z`
 * emits `<tree> NUL <path> NUL … NUL` — an empty record closes the conflicted
 * section — followed by informational messages that this module does not parse
 * and does not need to.
 */

import { parentGit, parentGitRaw } from "./parent.ts";

const OID = /^[0-9a-f]{40,64}$/;

/**
 * `--write-tree` for the mode, `--name-only` for the conflict report, `-z` for
 * the framing.
 *
 * Deliberately NOT `--merge-base=<base>`: the two-argument form is what
 * `probes/integration.sh` measured, and git computing the merge base itself is
 * the same answer for every shape this loop produces — every item branches from
 * the wave's base commit, and the accumulating integration commit descends from
 * it. Passing a base we computed ourselves would swap a measured behaviour for
 * an unmeasured one to save nothing.
 */
export function mergeTreeArgv(ours: string, theirs: string): string[] {
  return ["merge-tree", "--write-tree", "--name-only", "-z", ours, theirs];
}

export type MergeAttempt =
  | { kind: "merged"; tree: string }
  /** A real conflict. brigadier does not resolve it and does not ask an agent to. */
  | { kind: "conflicted"; tree: string; paths: string[] };

export class MergeUnavailable extends Error {
  constructor(message: string) {
    super(`ruling 51: merge-tree could not answer — ${message}`);
    this.name = "MergeUnavailable";
  }
}

/**
 * Parse `merge-tree --write-tree --name-only -z`.
 *
 * Returns `null` where the output is not a merge answer at all, which the
 * caller turns into `MergeUnavailable`. Kept as a pure function so the parse
 * can be driven from bytes captured off real git without a repository, and so
 * that "rc=1 with an empty stdout is not a conflict" is a testable sentence.
 */
export function parseMergeTree(code: number, stdout: string): MergeAttempt | null {
  const records = stdout.split("\0");
  const tree = records[0] ?? "";
  if (!OID.test(tree)) return null;
  if (code === 0) return { kind: "merged", tree };
  const paths: string[] = [];
  for (let i = 1; i < records.length; i++) {
    const record = records[i]!;
    if (record.length === 0) break;
    paths.push(record);
  }
  // A non-zero exit whose conflict section is empty is not something to
  // interpret generously: it is a shape this code has never seen.
  return paths.length === 0 ? null : { kind: "conflicted", tree, paths };
}

export async function mergeTree(
  repo: string,
  ours: string,
  theirs: string,
): Promise<MergeAttempt> {
  const result = await parentGitRaw(repo, mergeTreeArgv(ours, theirs));
  const attempt = parseMergeTree(result.code, result.stdout);
  if (attempt === null) {
    throw new MergeUnavailable(
      `merging ${theirs} into ${ours} exited ${result.code} with ` +
        `${JSON.stringify(result.stdout.slice(0, 200))} on stdout and ` +
        `${JSON.stringify(result.stderr.trim().slice(0, 200))} on stderr. A conflict prints a ` +
        "tree OID first; this did not, so it is an error and not a conflict.",
    );
  }
  return attempt;
}

/**
 * Who a brigadier merge commit is by.
 *
 * MEASURED against `git 2.50.1` on 2026-08-17: `commit-tree` succeeded with no
 * `user.name` or `user.email` configured at any level, falling back to a
 * username-and-hostname identity git guessed. So this is not about making the
 * command work — it is about the commit not silently claiming to be by the
 * operator, or by whatever git guessed on that machine, when brigadier is the
 * one that performed the merge. The agents' own commits keep their own authors:
 * they are parents of this commit, not squashed into it.
 */
export interface CommitIdentity {
  name: string;
  email: string;
}

export const BRIGADIER_IDENTITY: CommitIdentity = {
  name: "brigadier",
  email: "brigadier@localhost",
};

export interface CommitTreeSpec {
  tree: string;
  /** In order. Two of them, so `git log` keeps the agent's own commits reachable. */
  parents: readonly string[];
  message: string;
  identity?: CommitIdentity | undefined;
}

export async function commitTree(repo: string, spec: CommitTreeSpec): Promise<string> {
  const identity = spec.identity ?? BRIGADIER_IDENTITY;
  const args = ["commit-tree", spec.tree];
  for (const parent of spec.parents) args.push("-p", parent);
  args.push("-m", spec.message);
  const sha = await parentGit(repo, args, {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  });
  if (!OID.test(sha)) throw new MergeUnavailable(`commit-tree returned ${JSON.stringify(sha)}`);
  return sha;
}
