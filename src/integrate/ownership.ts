// SPDX-License-Identifier: Apache-2.0
/**
 * Declared ownership becomes CHECKED ownership, at integration.
 *
 * Ruling 14 rejects a plan in which two items claim one path — but that is a
 * claim about the PLAN. Inside its own clone an agent may write anywhere, and
 * the lane, correctly, does not care: ruling 43 measured that a `.git/**`
 * exclusion can only fire on two of five vendors, so a design that relied on
 * the lane to hold ownership would be relying on something three vendors do not
 * have. The plan's claim is therefore checked where the work comes back.
 *
 * `git diff --name-only --no-renames <base>..<item>` names every path the item
 * actually touched, including the undeclared one — MEASURED against
 * `git 2.50.1` on 2026-08-17 (`probes/integration.sh`, check 5: an item that
 * declared `a.txt` and also wrote `b.txt` produced exactly `a.txt b.txt`), and
 * re-measured in `test/integrate-parity.test.ts` on both sides of the fetch.
 *
 * `--no-renames` IS PART OF THAT SENTENCE AND NOT A TUNING FLAG. Without it,
 * and with `diff.renames` at its default, `--name-only` prints only a rename's
 * DESTINATION, so an item could delete any undeclared file by moving it into a
 * path it does own and still be judged `strayed: []`. The argv and the reason
 * live on `ownershipDiffArgv` in `src/repo/git.ts`.
 *
 * AND THE ITEM THAT STRAYED IS REJECTED WHOLE. Not partially: cherry-picking
 * the obedient half of a commit produces a tree nobody wrote and nobody
 * reviewed, which is a worse artefact than either the plan or the agent
 * intended. The remedy is a re-plan or a re-run, and both are the operator's.
 *
 * WHERE IT RUNS IS RULING 56, and it is load-bearing rather than incidental:
 * the same diff computes IDENTICALLY in the parent once the item's ref has been
 * fetched, so the one operation that looked like it had to happen inside the
 * clone does not, and brigadier's enumeration of "git commands run inside a
 * clone an agent touched" stays EMPTY. That fixes the order — fetch, then
 * ownership, then merge — and `src/repo/git.ts` carries the reason on
 * `ownershipDiffArgv` itself so that a refactor computing ownership "earlier,
 * in the clone, to fail faster" has to argue with it.
 */

/**
 * A declared path, as a plan writes it.
 *
 * Three forms and no fourth:
 *
 *   `src/integrate/index.ts`   exactly that path
 *   `src/integrate/**`         that directory and everything under it
 *   `test/integrate*.test.ts`  `*` within one segment; `**` spans segments
 *
 * A bare `src/integrate` matches THAT PATH and nothing under it, deliberately.
 * An implicit directory prefix is how a declaration of `src` silently comes to
 * own the tree, and ruling 14's legality filter is computed from these same
 * strings — a matcher that is generous here makes two items that overlap look
 * disjoint at plan time.
 */
export type DeclaredPath = string;

export class UnusableDeclaration extends Error {
  constructor(pattern: string, why: string) {
    super(`unusable declared path ${JSON.stringify(pattern)}: ${why}`);
    this.name = "UnusableDeclaration";
  }
}

/**
 * Git reports paths with forward slashes on every platform, so a backslash in a
 * declaration is refused rather than normalised.
 *
 * Ruling 12 makes Windows first class, and this is what that means here: a
 * Windows operator who writes `src\integrate\**` gets a refusal naming the fix,
 * instead of a declaration that matches nothing and an item rejected for
 * straying into files it declared.
 */
export function assertUsableDeclaration(pattern: string): void {
  if (pattern.length === 0) throw new UnusableDeclaration(pattern, "it is empty");
  if (pattern.includes("\\")) {
    throw new UnusableDeclaration(
      pattern,
      "git names paths with forward slashes on every platform, including Windows. Write " +
        "`src/integrate/**`, not `src\\integrate\\**` — a backslash here would match nothing " +
        "and the item would be rejected for writing files it thought it had declared",
    );
  }
  if (pattern.startsWith("/")) {
    throw new UnusableDeclaration(pattern, "declared paths are relative to the repository root");
  }
  if (pattern.split("/").includes("..")) {
    throw new UnusableDeclaration(pattern, "a `..` segment cannot name a path inside the repository");
  }
}

const SPECIAL = /[.+^${}()|[\]\\]/g;

/** One declaration, compiled. Anchored at both ends: a declaration is not a search. */
export function declarationMatcher(pattern: string): RegExp {
  assertUsableDeclaration(pattern);
  const normalised = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let source = "";
  for (let i = 0; i < normalised.length; i++) {
    const char = normalised[i]!;
    if (char === "*") {
      if (normalised[i + 1] === "*") {
        // `dir/**` covers `dir/a` and `dir/a/b`. It does not cover `dir` itself:
        // an item that declared a directory and committed a FILE at that path
        // did something the plan did not describe.
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(SPECIAL, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function isDeclared(path: string, declared: readonly DeclaredPath[]): boolean {
  return declared.some((pattern) => declarationMatcher(pattern).test(path));
}

export interface OwnershipVerdict {
  /** Every path the item touched, in git's own order. */
  touched: readonly string[];
  /** The paths no declaration covers. Non-empty means the item is rejected WHOLE. */
  strayed: readonly string[];
  within: boolean;
}

export function judgeOwnership(
  declared: readonly DeclaredPath[],
  touched: readonly string[],
): OwnershipVerdict {
  const strayed = touched.filter((path) => !isDeclared(path, declared));
  return { touched, strayed, within: strayed.length === 0 };
}

/**
 * The refusal, as the operator reads it.
 *
 * It names every strayed path and it names the whole-item consequence, because
 * "item 3 rejected" without the second half reads as a bug in brigadier rather
 * than as a decision about the agent's work.
 */
export function ownershipRefusal(item: number, verdict: OwnershipVerdict): string {
  return (
    `item ${item} wrote outside its declared paths and is rejected WHOLE — ` +
    `${verdict.strayed.join(", ")}. None of its work is integrated, including the ` +
    "files it did declare: keeping the obedient half would produce a tree nobody wrote " +
    "and nobody reviewed. Its ref is left in place for inspection."
  );
}

/**
 * `git diff --name-only -z` output, split.
 *
 * `-z` is added at the call site rather than baked into `ownershipDiffArgv`,
 * and the parity test asserts the bare form and the `-z` form name the same
 * paths in the same order. The reason it is used at all is quoting: without
 * `-z`, git renders a path containing a quote, a newline or a non-ASCII byte in
 * C-quoted form, and an ownership check that compares a quoted rendering
 * against a declaration is a check that can be defeated by a filename.
 */
export function touchedPaths(nulSeparated: string): string[] {
  return nulSeparated.split("\0").filter((path) => path.length > 0);
}
