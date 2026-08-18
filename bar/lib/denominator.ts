// SPDX-License-Identifier: Apache-2.0
/**
 * Is there anything in the diff for a reviewer to FIND?
 *
 * MEASURED on this host on 2026-08-18: item 5 planted its five defect markers in
 * `seeds/reviewed.seed` with placement `uncommitted-tracked`. Ruling 33 defines
 * the base commit as HEAD plus uncommitted TRACKED plus UNTRACKED work, so every
 * marker was carried into the base commit — and was therefore absent from `git
 * diff <base>..work`, which is the exact brief ruling 52 hands the reviewer. A
 * live item 5 would have recorded `caughtDefects: []` no matter how well the
 * reviewer performed.
 *
 * That number is the whole point of the item. `BAR.md` makes item 5 the place
 * ruling 52's named assumption — a reviewer given an exact diff catches more
 * than one given the post-state — is falsified or confirmed in public, printed
 * beside v1's measured 0-of-3 baseline. A harness that structurally reports zero
 * would have published "the reviewer caught nothing" as a measured fact about
 * the product, when it was a fact about where a file lived. It is this project's
 * signature failure once more: a check reporting a result about something it
 * never examined.
 *
 * So the denominator is now MEASURED before the numerator is believed. This
 * rehearses one builder turn against a faithful copy of the operator's
 * repository — ruling 33's base commit built the same way the product builds
 * it — drives the real fixture vendor, and reads the diff out of real `git`.
 * Nothing here touches the product: if the markers are missing from this diff,
 * no reviewer could have found them and any catch rate the run publishes is a
 * fact about the harness.
 */

import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fs.ts";
import type { Directive } from "./plan.ts";
import { baseEnv, exec } from "./proc.ts";
import { isolatedPath } from "./fixtures.ts";

export interface Rehearsal {
  /** The base commit a worker would be branched from. */
  baseSha: string;
  /** `git diff <base>..work`, as the reviewer would be handed it. */
  diff: string;
  /** Markers that are NOT in that diff. Empty is the only acceptable answer. */
  missing: string[];
  /** Argv, exit codes and sizes, ready to read in a failure. */
  transcript: string;
}

async function git(repo: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await exec(["git", "-c", "user.email=bar@e.invalid", "-c", "user.name=bar", ...args], {
    cwd: repo,
    timeoutMs: 60_000,
  });
  return { ok: result.code === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

/**
 * Rehearse ONE builder turn and return the diff a reviewer would receive.
 *
 * `vendorBin` is the planted fixture's own executable, driven exactly as an
 * orchestrator drives it — argv, brief file, answer file — so the bytes measured
 * here are the bytes a real turn produces.
 */
export async function rehearseBuilderTurn(options: {
  repo: string;
  /** A scratch directory. It is created; the operator's repository is untouched. */
  scratch: string;
  vendorBin: string;
  binDir: string;
  itemId: string;
  directive: Directive;
  markers: readonly string[];
}): Promise<Rehearsal> {
  const { repo, scratch, vendorBin, binDir, itemId, directive, markers } = options;

  // A faithful copy, `.git` included, so this starts from the operator's real
  // state rather than from a reconstruction of it.
  cpSync(repo, scratch, { recursive: true });

  // Ruling 33's base commit: HEAD plus uncommitted TRACKED plus UNTRACKED, which
  // is exactly what `git add -A` followed by a commit produces. Building it the
  // same way the product does is the point — a rehearsal against a DIFFERENT
  // base would prove nothing about the diff the product hands over.
  await git(scratch, ["add", "-A"]);
  const based = await git(scratch, ["commit", "-q", "--no-verify", "-m", `bar rehearsal base (ruling 33)`]);
  const baseSha = (await git(scratch, ["rev-parse", "HEAD"])).out;
  await git(scratch, ["checkout", "-q", "-B", "work"]);

  const answerFile = join(ensureDir(join(scratch, "..", "rehearsal-control")), `${itemId}.answer`);
  const briefPath = join(scratch, "..", "rehearsal-control", `${itemId}.brief.json`);
  writeFileSync(answerFile, "ALLOW");
  writeFileSync(briefPath, JSON.stringify({ itemId, clone: scratch, role: "builder", directive }, null, 2));

  const turn = await exec([vendorBin, briefPath], {
    cwd: scratch,
    env: baseEnv({
      PATH: isolatedPath(binDir),
      BAR_ANSWER_FILE: answerFile,
      // Bounded: this rehearsal answers exactly one request and must not sit on
      // the fixture's full deadline waiting for a second one it will never send.
      BAR_ANSWER_DEADLINE_MS: "3000",
    }),
    timeoutMs: 60_000,
  });

  const diff = (await git(scratch, ["diff", `${baseSha}..work`])).out;
  const missing = markers.filter((m) => !diff.includes(m));

  return {
    baseSha,
    diff,
    missing,
    transcript:
      `rehearsed one builder turn in ${scratch}: base ${baseSha.slice(0, 12)} (${based.ok ? "committed" : `commit said: ${based.err || "nothing to commit"}`}), ` +
      `vendor exit ${turn.code}, \`git diff base..work\` is ${diff.length} bytes, ` +
      `${markers.length - missing.length} of ${markers.length} marker(s) present`,
  };
}
