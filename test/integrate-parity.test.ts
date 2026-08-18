// SPDX-License-Identifier: Apache-2.0
/**
 * The measurement the whole fetch-then-diff ordering rests on, made here rather
 * than inherited.
 *
 * Ruling 56's invariant — *brigadier runs no git command inside a clone after
 * an agent has had access to it* — is only affordable because of one claim:
 * ruling 51's ownership check `git diff --name-only <base>..work` computes
 * IDENTICALLY in the parent once the item's ref has been fetched. If that claim
 * were false, the one operation that looks like it has to happen inside the
 * clone would have to happen there, and both of ruling 56's execution families
 * would reopen on the command brigadier runs most.
 *
 * So this file plants both families in a worker clone and asks the question on
 * BYTES:
 *
 *   - every hook name in ruling 56's measured set, plus the ones nobody lists;
 *   - `core.fsmonitor`, the family `-c core.hooksPath=<empty>` does not close;
 *   - `uploadpack.packObjectsHook`, the fetch-side surface;
 *   - a `.gitattributes` selecting `filter=evil` and `diff=evil`, with
 *     `filter.evil.smudge`, `filter.evil.clean` and `diff.evil.command` present
 *     in `.git/config` — because ruling 56 measured that attributes are a
 *     SELECTOR for an execution surface rather than one, and this is the family
 *     v1's LFS defect came from;
 *   - `diff.external`, which is the same family aimed squarely at the command
 *     this test is about.
 *
 * Each payload writes a canary OUTSIDE the clone. The assertions are on those
 * paths and never on a flag: v1's finding 41 is that a flag assertion survives
 * a refactor that removes the property, and a canary path does not.
 *
 * The positive control comes first, deliberately. "No canary appeared" proves
 * nothing at all unless the same payloads have just been seen to fire.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeOwnership, parentGit, touchedPaths } from "../src/integrate/index.ts";
import { ownershipDiffArgv } from "../src/repo/git.ts";
import { itemRef, WORK_BRANCH } from "../src/repo/refs.ts";

let scratch: string;
let canaryDir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout;
}

/** A script that writes a canary OUTSIDE the clone and exits clean. */
function payload(name: string): string {
  return `#!/bin/sh\ntouch "${join(canaryDir, name)}"\nexit 0\n`;
}

function escaped(): string[] {
  return readdirSync(canaryDir).sort();
}

function clearCanaries(): void {
  for (const name of readdirSync(canaryDir)) rmSync(join(canaryDir, name), { force: true });
}

/** Every hook name ruling 56 measured, and the ones that are on nobody's list. */
const HOOKS = [
  "pre-commit",
  "post-commit",
  "post-checkout",
  "post-index-change",
  "reference-transaction",
  "post-applypatch",
  "pre-auto-gc",
  "post-merge",
];

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-parity-")));
  canaryDir = join(scratch, "escaped");
  mkdirSync(canaryDir, { recursive: true });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("ruling 56: the ownership diff computes identically in the parent, with both execution families planted", async () => {
  const repo = join(scratch, "parent");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");
  for (const [path, content] of Object.entries({
    "a.txt": "a\n",
    "b.txt": "b\n",
    "keep.txt": "keep\n",
  })) {
    writeFileSync(join(repo, path), content);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  const base = (await git(repo, "rev-parse", "HEAD")).trim();

  // The worker's clone, and the worker's work: it declared `a.txt` and also
  // wrote `b.txt`, which is the case the ownership check exists for.
  const clone = join(scratch, "clone");
  await git(scratch, "clone", "-q", "--local", repo, clone);
  await git(clone, "config", "user.email", "worker@example.com");
  await git(clone, "config", "user.name", "Worker");
  await git(clone, "checkout", "-q", "-b", WORK_BRANCH);
  writeFileSync(join(clone, "a.txt"), "declared\n");
  writeFileSync(join(clone, "b.txt"), "NOT declared\n");
  await git(clone, "add", "-A");
  await git(clone, "commit", "-q", "-m", "agent work");
  await git(clone, "remote", "remove", "origin");

  // ------------------------------------------------------------- plant both
  for (const hook of HOOKS) {
    writeFileSync(join(clone, ".git", "hooks", hook), payload(`hook-${hook}`), { mode: 0o755 });
  }
  const script = (name: string): string => {
    const path = join(scratch, `payload-${name}.sh`);
    writeFileSync(path, payload(name), { mode: 0o755 });
    return path;
  };
  // The second family: config, not hooks. `-c core.hooksPath=<empty>` does not
  // close any of these — MEASURED in `probes/git-exec.sh` for `core.fsmonitor`.
  await git(clone, "config", "core.fsmonitor", script("config-fsmonitor"));
  await git(clone, "config", "uploadpack.packObjectsHook", script("config-uploadpack"));
  await git(clone, "config", "diff.external", script("config-diff-external"));
  await git(clone, "config", "filter.evil.smudge", script("config-filter-smudge"));
  await git(clone, "config", "filter.evil.clean", script("config-filter-clean"));
  await git(clone, "config", "diff.evil.command", script("config-diff-driver"));
  // Attributes are the SELECTOR, and inert without the config above.
  writeFileSync(join(clone, ".gitattributes"), "*.txt filter=evil diff=evil\n");

  // ------------------------------------------------- POSITIVE CONTROL FIRST
  // Without this, "no canary appeared" is indistinguishable from "the payloads
  // were never live".
  clearCanaries();
  await git(clone, "checkout", "-q", WORK_BRANCH);
  await git(clone, "commit", "-q", "--allow-empty", "-m", "the agent's own commit");
  const fired = escaped();
  expect(fired.length).toBeGreaterThan(0);
  expect(fired).toContain("hook-pre-commit");
  expect(fired).toContain("hook-post-commit");
  // Reset `work` to the agent's real work, so the empty commit above does not
  // become part of what is fetched.
  await git(clone, "reset", "-q", "--hard", "HEAD~1");

  // ----------------------------------------- the diff, computed IN the clone
  // This is the computation ruling 56 says brigadier must never perform, and it
  // is performed here — by the test, never by `src/` — to have something to
  // compare against.
  clearCanaries();
  const inClone = await git(clone, ...ownershipDiffArgv(base, WORK_BRANCH));
  const inCloneZ = await git(clone, ...ownershipDiffArgv(base, WORK_BRANCH), "-z");
  const firedInClone = escaped();

  // AND THE NEIGHBOURING COMMAND, which is the sharp half of this measurement.
  //
  // MEASURED against `git 2.50.1` on 2026-08-17: inside the clone,
  // `git diff --name-only <base>..work` fired NONE of the planted payloads —
  // `--name-only` never asks for content, so no diff driver and no filter is
  // consulted — while THE SAME COMMAND WITHOUT `--name-only` fired the
  // attribute-selected `diff.evil.command` and `filter.evil.smudge`. (Not
  // `diff.external`: an attribute-selected driver takes precedence over it, so
  // the payload that ran was the one the agent's own `.gitattributes` chose.)
  //
  // The ownership check is therefore ONE FLAG away from executing a program the
  // agent picked. That is why "compute ownership earlier, in the clone, to fail
  // faster" is closed by a ruling rather than by taste: the safety of the
  // current argv is a property of the argv, and an argv is one refactor wide.
  clearCanaries();
  await git(clone, "diff", `${base}..${WORK_BRANCH}`);
  const firedByFullDiff = escaped();
  expect(firedByFullDiff.length).toBeGreaterThan(0);
  expect(firedByFullDiff).toContain("config-diff-driver");
  expect(firedInClone).toEqual([]);

  // ------------------------------------------- the fetch, and then the parent
  clearCanaries();
  const ref = itemRef("parity", 1);
  await parentGit(repo, ["fetch", "--no-tags", clone, `${WORK_BRANCH}:${ref}`]);
  expect(escaped()).toEqual([]);

  const inParent = await git(repo, ...ownershipDiffArgv(base, ref));
  const inParentZ = await git(repo, ...ownershipDiffArgv(base, ref), "-z");
  // The same command that executed the agent's program inside the clone,
  // executed in the parent over the fetched ref. The agent's `.git/config` is
  // not this repository's `.git/config`, so there is nothing to select.
  await git(repo, "diff", `${base}..${ref}`);

  // THE CLAIM, on bytes: same paths, same order, both argv forms.
  expect(inParent).toBe(inClone);
  expect(inParentZ).toBe(inCloneZ);
  expect(inParent.split("\n").filter((line) => line.length > 0)).toEqual(["a.txt", "b.txt"]);
  expect(touchedPaths(inParentZ)).toEqual(["a.txt", "b.txt"]);

  // AND THE CANARY, outside the clone: nothing brigadier ran executed anything
  // the agent left behind. The fetch and both diffs, together.
  expect(escaped()).toEqual([]);
  expect(existsSync(join(canaryDir, "config-uploadpack"))).toBe(false);
  expect(existsSync(join(canaryDir, "config-fsmonitor"))).toBe(false);
  expect(existsSync(join(canaryDir, "config-diff-external"))).toBe(false);

  // The verdict the parent computes is the one the check needs: the item
  // declared `a.txt` and strayed into `b.txt`.
  const verdict = judgeOwnership(["a.txt"], touchedPaths(inParentZ));
  expect(verdict.within).toBe(false);
  expect(verdict.strayed).toEqual(["b.txt"]);

  // What the clone-side computation did, recorded rather than assumed. This is
  // the cost ruling 56 avoids by not being in there, and it is written to a
  // file so the number is not a claim in a comment.
  // THE PARITY CLAIM, ONCE MORE THROUGH THE PRODUCTION PATH. The assertion this
  // replaced compared a file against a literal the test itself had written two
  // lines earlier, which is a test that cannot fail — on the one measurement
  // ruling 56's whole invariant rests on. This one goes red if the parent-side
  // computation ever stops agreeing with the clone-side one, because the value
  // on the right came out of the clone and the value on the left came out of
  // `parentGit`, which is the argv `src/integrate/` actually runs.
  const viaProduction = await parentGit(repo, [...ownershipDiffArgv(base, ref), "-z"]);
  expect(touchedPaths(viaProduction)).toEqual(touchedPaths(inCloneZ));
  expect(touchedPaths(viaProduction).length).toBeGreaterThan(1);
  writeFileSync(
    join(scratch, "clone-side-firings.txt"),
    `name-only: ${firedInClone.join(", ")}\nfull diff: ${firedByFullDiff.join(", ")}\n`,
  );

  // The planted payloads are still there — nothing here sanitised the clone,
  // because ruling 56's answer is not to be in it rather than to clean it.
  expect(existsSync(join(clone, ".git", "hooks", "pre-commit"))).toBe(true);
  expect(readFileSync(join(clone, ".git", "config"), "utf8")).toContain("fsmonitor");

  // Reported plainly, per AGENTS.md: a negative result is a good result.
  // eslint-disable-next-line no-console
  console.log(
    `parity, MEASURED against git 2.50.1 on 2026-08-17: in the clone, ` +
      `\`diff --name-only\` fired [${firedInClone.join(", ") || "nothing"}] and the same ` +
      `command without --name-only fired [${firedByFullDiff.join(", ")}]; in the parent, ` +
      "after the fetch, neither fired anything and the paths were byte-identical",
  );
},
// The budget, declared rather than inherited — and this is a bug fix, not
// housekeeping. This test spawns roughly thirty `git` processes: an init, a
// local clone, the planting of eight hooks and six config payloads, the
// positive control's commit, four ownership diffs, a fetch and two full diffs.
// MEASURED on an idle machine: 3.97 s. Bun's undeclared default is 5000 ms, so
// it was passing with 21% of its budget left and timing out the moment the
// machine had anything else to do — REPRODUCED 4 times out of 4 under
// concurrent runs, where it was the ONLY failure in this file's suite.
//
// A blocking check that goes red on load rather than on behaviour is ruling
// 48's named failure mode: it teaches the reader to re-run rather than to look.
// Nothing about what this test ASSERTS changes here — the canary paths, the
// byte-equality and the negative controls are untouched. Only the wall-clock
// budget changes, and it is set where every other subprocess-heavy test in this
// repository sets it (90_000–180_000) rather than at a number this test's own
// measured duration sits close to.
120_000);
