// SPDX-License-Identifier: Apache-2.0
/**
 * The git version floor, and the failure it prevents.
 *
 * Ruling 51's integration is `git merge-tree --write-tree`. RESEARCH, NOT
 * MEASUREMENT — said plainly because everything else in this module is
 * measured: `--write-tree`, `--name-only` and `-z` all arrived with
 * merge-tree's real-merge mode in **git v2.38.0**. At v2.37.0 the command had
 * no options at all; it took exactly three tree-ish arguments and produced a
 * trivial three-way merge report.
 *
 * That is the whole reason this is a hard requirement checked at first run
 * rather than a note in a README. An unguarded call on an older git does not
 * ERROR — it MISBEHAVES:
 *
 *   MEASURED against `git 2.50.1` on 2026-08-17: the trivial three-argument
 *   form is still accepted today, and `git merge-tree <base> <a> <b>` exits
 *   **0** while printing a human-readable "merged / our / their" report that is
 *   not a tree OID and never wrote a tree. A caller that read stdout as an OID
 *   would carry that text into `commit-tree`, and a caller that read only the
 *   exit code would call it a clean merge.
 *
 * A wrong answer at rc=0 is the failure class this project keeps finding, so
 * the floor is checked once, before the first merge, and the refusal names the
 * version and the remedy.
 */

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  /** Exactly what git said. Windows and Apple builds append their own suffixes. */
  raw: string;
}

/**
 * `git merge-tree --write-tree` and its `--name-only` / `-z` output controls.
 *
 * Pinned as a triple rather than a string so the comparison is arithmetic:
 * "2.38.0" < "2.9.0" is true as a string and false as a version, and that
 * mistake is invisible until someone runs an old git.
 */
export const MERGE_TREE_FLOOR = { major: 2, minor: 38, patch: 0 } as const;

/** `git version 2.50.1 (Apple Git-155)`, `git version 2.45.1.windows.1`, `2.38.0`. */
export function parseGitVersion(output: string): GitVersion | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    raw: output.trim(),
  };
}

export function meetsFloor(version: GitVersion): boolean {
  const { major, minor, patch } = version;
  if (major !== MERGE_TREE_FLOOR.major) return major > MERGE_TREE_FLOOR.major;
  if (minor !== MERGE_TREE_FLOOR.minor) return minor > MERGE_TREE_FLOOR.minor;
  return patch >= MERGE_TREE_FLOOR.patch;
}

export class GitTooOld extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitTooOld";
  }
}

/**
 * The refusal text, separated from the check so that it is rendered — and read
 * — on machines that will never trigger it.
 *
 * `src/isolation/clone.ts` separates ruling 61's path refusal for the same
 * reason: a refusal nobody has seen rendered names the wrong things.
 */
export function versionRefusal(version: GitVersion | null, raw: string): string | null {
  const floor = `${MERGE_TREE_FLOOR.major}.${MERGE_TREE_FLOOR.minor}.${MERGE_TREE_FLOOR.patch}`;
  if (version === null) {
    return (
      `brigadier could not read a version out of ${JSON.stringify(raw)}, and it will not ` +
      `guess. Integration needs git >= ${floor} for \`merge-tree --write-tree\`.`
    );
  }
  if (meetsFloor(version)) return null;
  return (
    `git ${version.major}.${version.minor}.${version.patch} is too old for brigadier's ` +
    `integration, which needs >= ${floor}.\n\n` +
    "This is refused rather than attempted because of HOW it fails. `merge-tree --write-tree` " +
    `arrived in git ${floor}; before it, \`git merge-tree\` took three tree-ish arguments and ` +
    "printed a trivial-merge report. So the call would not error — it would exit 0 with output " +
    "that is not a tree OID, and an unguarded brigadier would report a clean merge of a tree " +
    "it never wrote.\n\n" +
    `Remedy: upgrade git to ${floor} or newer. brigadier reports \`${version.raw}\`.`
  );
}

/**
 * The floor, checked at first run.
 *
 * Cached per process and keyed by the raw string, because the check costs a
 * process spawn and a run integrates once per wave. Keyed rather than a bare
 * boolean so that a test — or a caller passing a version it wants judged —
 * cannot be answered from another version's cache entry.
 */
const judged = new Map<string, GitVersion>();

export function requireGitVersion(raw: string): GitVersion {
  const cached = judged.get(raw);
  if (cached !== undefined) return cached;
  const version = parseGitVersion(raw);
  const refusal = versionRefusal(version, raw);
  if (refusal !== null || version === null) throw new GitTooOld(refusal ?? "unreadable git version");
  judged.set(raw, version);
  return version;
}
