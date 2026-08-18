// SPDX-License-Identifier: Apache-2.0
/**
 * The drift test for the one thing the harness has to know about the product's
 * disk shape.
 *
 * Every one of this session's nine instrument defects has been a check that
 * reported something about a place it was not looking, and this file is the
 * standing control for the ninth. Both directions are asserted, per
 * `AGENTS.md`: the rule holds over the real product source, AND the enumeration
 * comes back EMPTY on the shape the defect assumed — because "returns nothing"
 * was the failure that read as a destroyed clone and as an early kill.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT_SOURCE, cloneDirsUnder, itemDirOf, productRunDir } from "./layout.ts";

const scratch: string[] = [];
function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "bar-layout-"));
  scratch.push(made);
  return made;
}
afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

/** A directory that is a git checkout as far as any of this is concerned. */
function plantClone(path: string): string {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/work\n");
  return path;
}

describe("the clone shape is read out of the product, never copied into the harness", () => {
  test("RUN_DIR comes from src/repo/layout.ts and is the short name ruling 61 fixed", () => {
    // `r`, not `runs`: the spread between the shortest and longest candidate
    // root is 23 characters, 13% of #5's entire measured MAX_PATH budget.
    expect(productRunDir()).toBe("r");
  });

  test("a renamed or deleted constant is a FINDING, not a default", () => {
    // The failure mode this whole module exists to prevent is looking in a
    // place nothing is. Falling back to a literal would restore it silently.
    expect(() => productRunDir("// the product no longer declares it\n")).toThrow(/RUN_DIR/);
  });

  test("itemDir still composes run root, RUN_DIR, run id and a BARE item number", () => {
    // Read as text, so a reshape of the product's own composition fails here
    // rather than in an item that then blames the product.
    const source = readFileSync(LAYOUT_SOURCE, "utf8");
    expect(source).toMatch(
      /export function itemDir\([^)]*\)[^{]*\{\s*return join\(runRoot,\s*RUN_DIR,\s*runId,\s*String\(item\)\);/,
    );
    expect(itemDirOf("/root", "a1b2c3", 12)).toBe("/root/r/a1b2c3/12");
  });
});

describe("cloneDirsUnder finds what the product creates, and only that", () => {
  test("a clone at the product's real path is found, with its run id and item NUMBER", () => {
    const root = dir();
    plantClone(itemDirOf(root, "a1b2c3", 1));
    plantClone(itemDirOf(root, "a1b2c3", 2));
    expect(cloneDirsUnder(root).map((c) => `${c.runId}/${c.item}`)).toEqual(["a1b2c3/1", "a1b2c3/2"]);
  });

  test("NEGATIVE CONTROL: the shape the defect assumed finds NOTHING", () => {
    // `<run-root>/<dir>/clones/<n>`, which is what item 7 enumerated for nine
    // rounds. Empty is exactly what it returned, and empty rendered as
    // "NONE — the only copy of that work was destroyed".
    const root = dir();
    plantClone(join(root, "run-0001", "clones", "1"));
    expect(cloneDirsUnder(root)).toEqual([]);
  });

  test("state directories and the manifest are not clones", () => {
    const root = dir();
    plantClone(itemDirOf(root, "a1b2c3", 1));
    // `src/isolation/clone.ts` puts per-item state at `<run>/state/<n>` and
    // `src/isolation/manifest.ts` puts the manifest beside it. Neither is a
    // bare item number, and neither may be counted as somebody's only copy.
    plantClone(join(root, productRunDir(), "a1b2c3", "state", "1"));
    writeFileSync(join(root, productRunDir(), "a1b2c3", "manifest.json"), "{}\n");
    expect(cloneDirsUnder(root).map((c) => c.item)).toEqual([1]);
  });

  test("a directory caught mid-clone, with no .git yet, is not counted", () => {
    const root = dir();
    mkdirSync(itemDirOf(root, "a1b2c3", 1), { recursive: true });
    expect(cloneDirsUnder(root)).toEqual([]);
  });

  test("a run root that does not exist is empty rather than an exception", () => {
    expect(cloneDirsUnder(join(dir(), "never-created"))).toEqual([]);
  });
});
