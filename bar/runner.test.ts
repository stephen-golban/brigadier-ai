// SPDX-License-Identifier: Apache-2.0
/**
 * The runner's own negative controls.
 *
 * Four properties, each of which would be invisible if it broke:
 *
 *   a thrown item is a FAILING item, with the stack as its observation;
 *   `SKIPPED` blocks exactly as `FAIL` does, in the tally and in the exit code;
 *   a missing item makes the run INCOMPLETE rather than green;
 *   `--binary` fails loudly when it is absent, a directory, or not executable.
 *
 * Ruling 48's standing rule is the second one, and it is the one most likely to
 * be quietly relaxed: a bar with a skip that does not block is a bar that ships
 * a tag on unmeasured promises.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "./lib/fs.ts";
import { blocks, checkBinary, exitCodeFor, parseArgs, runBar, summaryTable, tally } from "./run.ts";
import type { BarItem, BarRecord } from "./types.ts";

const created: string[] = [];
function scratch(name: string): string {
  const dir = join(tmpdir(), `bar-runner-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) removeDir(dir);
});

function stubItem(id: number, run: BarItem["run"]): BarItem {
  return { id, title: `item ${id}`, rulings: [48], requiresLive: false, run };
}

const silent = (): void => {};

function options(workroot: string) {
  return { binary: process.execPath, live: false, json: true, workroot, log: silent };
}

describe("a thrown item is a FAILING item", () => {
  test("the throw becomes FAIL, and the message survives", async () => {
    const workroot = scratch("throw");
    const records = await runBar(
      [
        stubItem(1, async () => {
          throw new Error("the agent hung up");
        }),
      ],
      options(workroot),
    );
    expect(records[0]?.outcome).toBe("FAIL");
    expect(records[0]?.reason).toContain("the agent hung up");
    expect(records[0]?.observed).toContain("the item threw before it could report");
  });

  test("a throw is never turned into a SKIPPED", async () => {
    const workroot = scratch("throw2");
    const records = await runBar(
      [
        stubItem(1, () => {
          throw new Error("boom");
        }),
      ],
      options(workroot),
    );
    expect(records[0]?.outcome).not.toBe("SKIPPED");
  });
});

describe("SKIPPED blocks exactly as FAIL does (ruling 48)", () => {
  const record = (id: number, outcome: BarRecord["outcome"]): BarRecord => ({
    id,
    title: `item ${id}`,
    rulings: [48],
    outcome,
    did: "d",
    observed: "o",
    ms: 0,
  });

  test("blocks() treats them identically", () => {
    expect(blocks(record(1, "SKIPPED"))).toBe(true);
    expect(blocks(record(1, "FAIL"))).toBe(true);
    expect(blocks(record(1, "PASS"))).toBe(false);
  });

  test("a single SKIPPED among twelve passes still exits non-zero", () => {
    const records = [
      ...Array.from({ length: 12 }, (_, i) => record(i + 1, "PASS")),
      record(13, "SKIPPED"),
    ];
    expect(tally(records)).toEqual({ pass: 12, fail: 0, skipped: 1, blocking: 1 });
    expect(exitCodeFor(records, 13)).toBe(1);
  });

  test("thirteen passes exit zero", () => {
    const records = Array.from({ length: 13 }, (_, i) => record(i + 1, "PASS"));
    expect(exitCodeFor(records, 13)).toBe(0);
  });

  test("a deleted item makes the run INCOMPLETE rather than green", () => {
    const records = Array.from({ length: 12 }, (_, i) => record(i + 1, "PASS"));
    expect(exitCodeFor(records, 13)).toBe(2);
  });

  test("--only marks every deselected item blocking", async () => {
    const workroot = scratch("only");
    const records = await runBar(
      [stubItem(1, async () => ({ outcome: "PASS", did: "d", observed: "o" })), stubItem(2, async () => ({ outcome: "PASS", did: "d", observed: "o" }))],
      { ...options(workroot), only: [1] },
    );
    expect(records.map((r) => r.outcome)).toEqual(["PASS", "SKIPPED"]);
    expect(records[1]?.reason).toContain("not selected by --only");
    expect(records.some(blocks)).toBe(true);
  });
});

describe("the summary table", () => {
  test("prints one line per item, with its rulings", () => {
    const records: BarRecord[] = [
      { id: 1, title: "Detection is honest", rulings: [6, 41], outcome: "PASS", did: "d", observed: "o", ms: 1 },
      { id: 2, title: "The lane holds", rulings: [43], outcome: "FAIL", did: "d", observed: "o", ms: 2 },
    ];
    const lines = summaryTable(records).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("PASS");
    expect(lines[0]).toContain("rulings 6,41");
    expect(lines[1]).toContain("FAIL");
  });
});

describe("--binary fails loudly and usefully", () => {
  test("absent is an error, not a default", () => {
    const parsed = parseArgs(["--live"]);
    expect("error" in parsed && parsed.error).toContain("--binary <path> is required");
  });

  test("a flag where the path should be is caught", () => {
    const parsed = parseArgs(["--binary", "--json"]);
    expect("error" in parsed).toBe(true);
  });

  test("a non-existent path names the resolved path", () => {
    const result = checkBinary(join(tmpdir(), "definitely-not-here-9f3a"));
    expect(typeof result === "object" && result.error).toContain("does not exist");
  });

  test("a directory is rejected", () => {
    const dir = scratch("dir");
    const result = checkBinary(dir);
    expect(typeof result === "object" && result.error).toContain("is a directory");
  });

  test("a non-executable file is rejected on POSIX", () => {
    if (process.platform === "win32") {
      // Windows has no execute bit; the check that exists there is `exists`,
      // which is covered above. Nothing is skipped: this branch asserts the
      // platform's actual behaviour rather than stepping over it.
      expect(typeof checkBinary(process.execPath)).toBe("string");
      return;
    }
    const dir = scratch("mode");
    const file = join(dir, "not-executable");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o644);
    const result = checkBinary(file);
    expect(typeof result === "object" && result.error).toContain("is not executable");
  });

  test("--only parses, and rejects nonsense", () => {
    const parsed = parseArgs(["--binary", "x", "--only", "1,10"]);
    expect("only" in parsed && parsed.only).toEqual([1, 10]);
    expect("error" in parseArgs(["--binary", "x", "--only", "one"])).toBe(true);
  });
});
