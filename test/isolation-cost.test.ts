// SPDX-License-Identifier: Apache-2.0
/**
 * What isolation costs, MEASURED on the machine running the suite instead of
 * quoted in a comment.
 *
 * This file exists because the first version of this module quoted numbers in
 * source comments and two of them were wrong: a `prepareClone` figure three to
 * four times the real one, and a witness-with-tree-hash quoted as CHEAPER than
 * the tree hash alone — which is impossible, and was the artefact of comparing
 * two runs in two processes with a warm page cache between them. A number in a
 * comment cannot be re-measured by the reader. A number this suite prints on
 * every run can.
 *
 * Everything below is measured in ONE process, in the order printed, on the
 * same fixture. The assertions are deliberately generous: a tight timing
 * assertion on a shared CI runner is a flake, and a flaky gate gets ignored.
 * The medians are what the claims rest on; the printed lines are the evidence.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBaseState,
  discardClone,
  hashWorkingTree,
  prepareClone,
  recycleClone,
  releaseToAgent,
  witnessOperator,
  type AgentOwnedClone,
  type BaseState,
  type ReclamationEvidence,
} from "../src/isolation/index.ts";

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
  return stdout.trim();
}

const TRACKED_DIRS = 20;
const TRACKED_PER_DIR = 25;
const IGNORED_FILES = 1000;
const BLOB = "x".repeat(4096);


/**
 * The sweep's evidence, stubbed.
 *
 * `recycleClone` requires proof from ruling 38's reclamation sweep that this
 * item's processes are gone. That module is a different slice and does not
 * exist yet, so these tests construct the evidence themselves — honestly: no
 * worker process is ever spawned here, so there is nothing to reclaim and
 * nothing to lie about. `test/isolation-live.test.ts` is where the evidence is
 * false on purpose, and where the refusals are checked.
 */
function sweptClean(clone: AgentOwnedClone): ReclamationEvidence {
  return {
    runId: clone.runId,
    item: clone.item,
    sweptAt: Date.now(),
    reclaimedPids: [],
    survivors: [],
    sweptBy: "test stub: no worker process was spawned for this item",
  };
}

let scratch: string;
let runRootHome: string;
let repo: string;

async function ms(work: () => Promise<unknown>): Promise<number> {
  const start = Bun.nanoseconds();
  await work();
  return (Bun.nanoseconds() - start) / 1e6;
}

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

const round = (value: number): number => Math.round(value * 10) / 10;

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-cost-")));
  const home = join(homedir(), ".brigadier-test");
  mkdirSync(home, { recursive: true });
  runRootHome = realpathSync(mkdtempSync(join(home, "cost-")));

  repo = join(scratch, "parent");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  for (let d = 0; d < TRACKED_DIRS; d++) {
    mkdirSync(join(repo, `pkg${d}`), { recursive: true });
    for (let f = 0; f < TRACKED_PER_DIR; f++) {
      writeFileSync(join(repo, `pkg${d}`, `file${f}.ts`), `// ${d}/${f}\n${BLOB}\n`);
    }
  }
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  for (let f = 0; f < IGNORED_FILES; f++) {
    writeFileSync(join(repo, "node_modules", "dep", `m${f}.js`), BLOB);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  // The operator's uncommitted work, so the base state has something to carry.
  writeFileSync(join(repo, "pkg0", "file0.ts"), "// the operator's edit\n");
  writeFileSync(join(repo, "untracked.ts"), "// new\n");
}, 120_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(runRootHome, { recursive: true, force: true });
});

describe("cost", () => {
  test("base state, clone and recycle, measured in one process", async () => {
    const tracked = TRACKED_DIRS * TRACKED_PER_DIR;
    const bases: BaseState[] = [];
    const buildMs: number[] = [];
    for (let i = 0; i < 3; i++) {
      let base: BaseState | undefined;
      buildMs.push(
        await ms(async () => {
          base = await buildBaseState({
            repo,
            runId: `cost${i}`,
            scratchDir: join(runRootHome, `state${i}`),
          });
        }),
      );
      bases.push(base!);
    }

    const prepareMs: number[] = [];
    const recycleMs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const root = join(runRootHome, `root${i}`);
      mkdirSync(root, { recursive: true });
      let prepared: Awaited<ReturnType<typeof prepareClone>> | undefined;
      prepareMs.push(
        await ms(async () => {
          prepared = await prepareClone({ base: bases[0]!, item: 1, runRoot: root });
        }),
      );
      const agent = releaseToAgent(prepared!);
      // The junk a real item leaves behind, so `clean -fdx` has work to do.
      writeFileSync(join(agent.dir, "scratch-note.txt"), "junk\n");
      recycleMs.push(await ms(() => recycleClone(agent, { base: bases[1]!, reclaimed: sweptClean(agent) })));
      discardClone(agent);
    }

    const summary =
      `MEASURED on this machine, ${await git(repo, "--version")}, bun ${Bun.version}: ` +
      `${tracked} tracked files, ${IGNORED_FILES} gitignored, 4 KB each\n` +
      `  buildBaseState  median ${round(median(buildMs))} ms  ${buildMs.map(round).join(" / ")}\n` +
      `  prepareClone    median ${round(median(prepareMs))} ms  ${prepareMs.map(round).join(" / ")}\n` +
      `  recycleClone    median ${round(median(recycleMs))} ms  ${recycleMs.map(round).join(" / ")}`;
    console.log(summary);

    // Ruling 19's direction, with a margin wide enough not to flake. The
    // ruling's own absolute numbers (1–3 s against 6.06 s) are for a repository
    // this is not, and are not re-asserted here.
    expect(median(recycleMs)).toBeLessThan(median(prepareMs) * 2);
    expect(median(buildMs)).toBeGreaterThan(0);
  }, 180_000);

  test("the witness, with and without the working-tree hash", async () => {
    // Same process, same fixture, in this order — which is the part the earlier
    // quoted numbers got wrong.
    const hashCold = await ms(async () => hashWorkingTree(repo));
    const hashWarm = await ms(async () => hashWorkingTree(repo));
    const cheap = await ms(() => witnessOperator(repo));
    const full = await ms(() => witnessOperator(repo, { hashWorkingTree: true }));

    console.log(
      `MEASURED on this machine, bun ${Bun.version}: working tree of ` +
        `${TRACKED_DIRS * TRACKED_PER_DIR + IGNORED_FILES + 2} files\n` +
        `  hashWorkingTree      ${round(hashCold)} ms first / ${round(hashWarm)} ms second\n` +
        `  witnessOperator      ${round(cheap)} ms without the hash\n` +
        `  witnessOperator+hash ${round(full)} ms with it`,
    );

    // The only claim made from these: the hash is what the option costs. It
    // cannot be free and it cannot be negative, and a witness including it
    // cannot be cheaper than the same witness without it — which is exactly the
    // impossibility the earlier comment asserted.
    expect(full).toBeGreaterThan(cheap * 0.5);
    expect(hashWarm).toBeGreaterThan(0);
  }, 120_000);
});
