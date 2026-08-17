// SPDX-License-Identifier: Apache-2.0
/**
 * The item-module contract.
 *
 * `BAR.md` (ruling 48) defines thirteen items and says how they are run: a
 * harness SEPARATE from `bun test`, pointed at a downloaded release artifact by
 * someone who has never built this repository. That last clause is the whole
 * design constraint of this directory, and it is worth stating as a rule rather
 * than a preference:
 *
 *   **Nothing under `bar/` imports anything from `src/`.**
 *
 * A harness that imports the product's own predicates shares the product's bugs
 * and cannot detect them. v1's worst defect — a global git-config check that
 * made the product refuse to run for every git-lfs user — survived 740 tests,
 * four gates and two adversarial review lenses, because every one of them was
 * built out of the same modules as the thing under test. So the binary is driven
 * as a black box, over argv/stdin/stdout/exit-code and the filesystem, and
 * `bar/self-check.test.ts` enforces that mechanically.
 *
 * Two other properties of this file are load-bearing rather than stylistic:
 *
 *   `did` and `observed` are REQUIRED on every result, including a passing one.
 *   `BAR.md`'s first rule is "checkable by someone who does not trust the
 *   author", and a bare `PASS` is not checkable by anyone.
 *
 *   `SKIPPED` is an outcome, not an escape hatch. Ruling 48: "a SKIPPED item
 *   blocks a tag exactly as a FAIL does", because a check that did not run is
 *   not a check that passed. The runner treats the two identically in the
 *   summary and in the exit code, and there are exactly THREE legal causes:
 *
 *     1. the item's live half needs real vendor agents and `--live` was absent;
 *     2. a platform-gated check on the wrong platform;
 *     3. the operator deselected the item with `--only`.
 *
 *   The third is the runner's, never an item's — an item has no way to produce
 *   it — and it is written down because the first draft's doctrine listed two
 *   causes while the runner emitted three. A rule that is false about its own
 *   enforcement is worse than no rule. What remains forbidden is the one that
 *   matters: "the feature does not exist" is a `FAIL`, always.
 */

export type Outcome = "PASS" | "FAIL" | "SKIPPED";

/**
 * How an item's two halves came out.
 *
 * Ten of thirteen items need vendor credentials for part of what they prove,
 * and five of those were computing a credential-free assertion and then throwing
 * it away into a `SKIPPED`: against a binary whose `competence` printed NOTHING
 * AT ALL, item 5 reported "requires real vendor agents". That is exactly the
 * disguise this harness claims to prevent, and it meant the CI leg `BAR.md`
 * calls authoritative could grade at most 3 of 13 items forever.
 *
 * So the halves are graded separately and reported separately. A failing
 * credential-free half can never be masked by an absent credential, because the
 * combination rule looks at it first.
 */
export interface Halves {
  credentialFree: Outcome;
  live: Outcome;
}

export interface BarResult {
  outcome: Outcome;
  /** What the item did — the command it ran, the state it set up. */
  did: string;
  /** What it actually saw — the bytes, the exit code, the file listing. */
  observed: string;
  /** Why SKIPPED, or which assertion failed. */
  reason?: string;
  halves?: Halves;
}

export interface RunOptions {
  cwd?: string;
  /**
   * The COMPLETE environment for the child, not an overlay. Controlling `PATH`
   * exactly is how several items plant their ground truth, so a merge here would
   * quietly defeat them.
   */
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  ms: number;
}

export interface BarContext {
  /** Absolute path to the compiled binary under test. */
  binary: string;
  /** `--live` was passed: real vendor agents may be driven. */
  live: boolean;
  /** A fresh scratch directory for this item, removed afterwards. */
  workdir: string;
  run(args: string[], opts?: RunOptions): Promise<RunResult>;
  /** Streamed to the operator as the item runs. */
  log(line: string): void;
}

export interface BarItem {
  /** 1..13, matching `BAR.md`'s headings. */
  id: number;
  /** `BAR.md`'s own heading text. */
  title: string;
  /** The rulings this item proves, from `BAR.md`'s italic line. */
  rulings: number[];
  /**
   * True when the item cannot run without real vendor agents.
   *
   * Deliberately NOT a licence for the runner to skip the item wholesale. An
   * item declaring this still drives the binary far enough to prove the feature
   * it needs EXISTS, and only reports `SKIPPED` once the missing ingredient is
   * genuinely the credentials. "The subcommand does not exist" is a `FAIL`, and
   * dressing it as `SKIPPED` would make an unbuilt product look merely
   * unmeasured.
   */
  requiresLive: boolean;
  run(ctx: BarContext): Promise<BarResult>;
}

/** One row of the machine-readable `--json` output. */
export interface BarRecord {
  id: number;
  title: string;
  rulings: number[];
  outcome: Outcome;
  did: string;
  observed: string;
  reason?: string;
  halves?: Halves;
  ms: number;
}
