// SPDX-License-Identifier: Apache-2.0
/**
 * WHERE A `brigadier run` SPENDS ITS TIME, per platform, in pieces.
 *
 * **What this exists to settle.** `OWNER-QUESTIONS.md` #12: a whole
 * `brigadier run` is 35-160x slower on `windows-latest` than on either POSIX
 * leg. MEASURED 2026-08-20 across runs 32403947990 and its siblings, same tests
 * and same commit: 314-896 ms on ubuntu-latest and macos-latest against
 * 31,014-51,116 ms on windows-latest. Those are real durations rather than
 * timeout artefacts, because the bodies are `Bun.spawnSync`, which cannot be
 * interrupted. Ruling 12 makes Windows first class, so that is a user-visible
 * property of the product on a supported platform, and nothing in `BAR.md`
 * measures it.
 *
 * Four candidates were named and none was separated: process creation on
 * Windows being dearer, every planted vendor being reached through `cmd.exe` as
 * a `.cmd` shim, `git` on Windows, or something in the product's own worker
 * path. This times the first three separately so the fourth is what is left.
 *
 * **WHAT THIS FILE MUST NOT DO, learned the hard way this week.**
 * `test/git-payload-shape.test.ts` drove a clean four-cell matrix, refuted all
 * three of its candidates honestly, and could not have found the cause —
 * because one line in its SETUP normalised the causal variable to its working
 * value in every cell. So:
 *
 *   - the shim cells run the SAME target program as the direct cells, and the
 *     only difference between them is the shim;
 *   - nothing here is pre-warmed for one cell and cold for another — each
 *     sample gets its own fresh directory, in every cell, on every platform;
 *   - no path is rewritten, normalised or forward-slashed anywhere.
 *
 * **It records and does not judge.** Whether a cell is slow is a fact about the
 * platform, and asserting a threshold would be this file claiming to know the
 * answer it was written to find. The only blocking assertion is that every cell
 * produced a reading, because a cell that did not run is not a cell that was
 * fast — the same rule ruling 48 applies to a `SKIPPED` bar item.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { plantLauncher } from "../bar/lib/fake-agent.ts";

/** Samples per cell. Small: this runs on every push, on three platforms. */
const SAMPLES = 5;

let scratch: string;
let target: string;
let shimDir: string;
let seedRepo: string;

const readings = new Map<string, number[]>();

function record(cell: string, ms: number): void {
  const list = readings.get(cell) ?? [];
  list.push(ms);
  readings.set(cell, list);
}

/** The middle sample. A mean would let one Defender scan speak for the cell. */
function median(list: readonly number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function timed(run: () => void): number {
  const started = Bun.nanoseconds();
  run();
  return (Bun.nanoseconds() - started) / 1e6;
}

function git(cwd: string, ...args: string[]): void {
  Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

/** A fresh directory per sample, in every cell, so no cell is warm where another is cold. */
function freshDir(prefix: string, index: number): string {
  const dir = join(scratch, `${prefix}-${index}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  // Ruling 61 refuses a run root inside a temp region; this is not a run root,
  // but keeping the scratch tree under $HOME matches every other fixture here
  // and avoids measuring a temp filesystem nothing else in this repository uses.
  scratch = mkdtempSync(join(homedir(), ".brigadier-spawn-cost-"));

  // The target is deliberately the cheapest thing this toolchain can start, and
  // it is IDENTICAL in the direct cell and the shim cell. Whatever bun's own
  // start-up costs on this platform, it costs the same in both, so the
  // difference between those two cells is the shim and nothing else.
  target = join(scratch, "target.ts");
  writeFileSync(target, "process.exit(0)\n");

  shimDir = join(scratch, "bin");
  plantLauncher(shimDir, "target", [process.execPath, target]);

  seedRepo = join(scratch, "seed");
  mkdirSync(seedRepo, { recursive: true });
  git(seedRepo, "init", "-q", "-b", "main", ".");
  writeFileSync(join(seedRepo, "a.txt"), "a\n");
  git(seedRepo, "add", "-A");
  git(seedRepo, "-c", "user.email=s@e.invalid", "-c", "user.name=s", "commit", "-q", "-m", "seed");
}, 120_000);

afterAll(() => {
  // Printed unconditionally, on a pass as well as a failure. A number that stops
  // being printed is a number nobody will ever revisit.
  const rows = [...readings]
    .map(([cell, list]) => `    ${cell.padEnd(28)} median ${median(list).toFixed(1).padStart(9)} ms  (n=${list.length})`)
    .join("\n");
  process.stderr.write(`\n  SPAWN-COST MATRIX on ${process.platform}:\n${rows}\n\n`);
  rmSync(scratch, { recursive: true, force: true });
});

describe("where a run's wall clock goes, in pieces (OWNER-QUESTIONS.md #12)", () => {
  test("spawn the target DIRECTLY", () => {
    for (let index = 0; index < SAMPLES; index += 1) {
      const cwd = freshDir("direct", index);
      record(
        "spawn direct",
        timed(() => {
          Bun.spawnSync([process.execPath, target], { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
        }),
      );
    }
    expect(readings.get("spawn direct")?.length).toBe(SAMPLES);
  }, 180_000);

  test("spawn the SAME target through a planted launcher shim", () => {
    // On Windows `plantLauncher` writes a `.cmd`, which bun reaches through
    // `cmd.exe`; on POSIX it writes a `#!/bin/sh` script. Every planted vendor
    // the suite drives arrives this way, so if the shim is the cost then a
    // large part of #12 is the fixtures rather than the product — and that is a
    // very different finding from the product being slow.
    const shim = join(shimDir, process.platform === "win32" ? "target.cmd" : "target");
    for (let index = 0; index < SAMPLES; index += 1) {
      const cwd = freshDir("shim", index);
      record(
        "spawn through shim",
        timed(() => {
          Bun.spawnSync([shim], { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
        }),
      );
    }
    expect(readings.get("spawn through shim")?.length).toBe(SAMPLES);
  }, 180_000);

  test("`git init` plus one commit, in a fresh repository", () => {
    for (let index = 0; index < SAMPLES; index += 1) {
      const dir = freshDir("init", index);
      record(
        "git init + commit",
        timed(() => {
          git(dir, "init", "-q", "-b", "main", ".");
          writeFileSync(join(dir, "a.txt"), "a\n");
          git(dir, "add", "-A");
          git(dir, "-c", "user.email=s@e.invalid", "-c", "user.name=s", "commit", "-q", "-m", "x");
        }),
      );
    }
    expect(readings.get("git init + commit")?.length).toBe(SAMPLES);
  }, 180_000);

  test("`git clone --local`, which is what a worker's clone costs", () => {
    for (let index = 0; index < SAMPLES; index += 1) {
      const dir = freshDir("clone", index);
      record(
        "git clone --local",
        timed(() => {
          Bun.spawnSync(["git", "clone", "--local", "-q", seedRepo, join(dir, "c")], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          });
        }),
      );
    }
    expect(readings.get("git clone --local")?.length).toBe(SAMPLES);
  }, 180_000);

  test("every cell produced a reading, which is the only thing asserted here", () => {
    // A cell that did not run is not a cell that was fast. Ruling 48's rule for
    // a SKIPPED bar item, at the scale of one experiment.
    const cells = ["spawn direct", "spawn through shim", "git init + commit", "git clone --local"];
    for (const cell of cells) {
      const list = readings.get(cell) ?? [];
      expect(list.length).toBe(SAMPLES);
      expect(median(list)).toBeGreaterThan(0);
    }
  });
});
