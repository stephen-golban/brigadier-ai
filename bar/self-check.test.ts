// SPDX-License-Identifier: Apache-2.0
/**
 * The harness's checks on itself.
 *
 * One rule dominates: `bar/` imports nothing from `src/`. A harness assembled
 * from the product's own predicates shares the product's bugs and cannot detect
 * them, which is not hypothetical — `BAR.md` opens by recording that v1's worst
 * defect survived 740 tests, four gates, two adversarial review lenses and
 * twenty-two work orders, every one of them built out of the modules under test.
 *
 * Both directions are tested, per `AGENTS.md`: the rule holds over the real
 * tree, AND the scanner fires when it is handed a violation. A guard that always
 * passes looks identical to a working one.
 */

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ITEMS } from "./items/index.ts";
import {
  hasSpdxHeader,
  importSpecifiers,
  reachesIntoSrc,
  typescriptFiles,
  violations,
} from "./lib/imports.ts";
import { disagreements, readSpec } from "./lib/spec.ts";

const BAR = fileURLToPath(new URL(".", import.meta.url));

describe("bar/ imports nothing from src/", () => {
  test("no file under bar/ reaches into src/", () => {
    const found = violations(typescriptFiles(BAR));
    expect(found.map((v) => `${v.file} -> ${v.specifier}`)).toEqual([]);
  });

  test("the rule fires when it is violated — relative climb", () => {
    // Assembled rather than written out. A literal here would be a real
    // violation in a real file under `bar/`, and the scan above would flag this
    // very test — which it did, on the first run, and correctly.
    const forbidden = ["..", "..", "src", "lane", "lane.ts"].join("/");
    const found = violations(new Map([["bar/items/99.ts", `import { Lane } from "${forbidden}";`]]));
    expect(found).toHaveLength(1);
    expect(found[0]?.specifier).toBe(forbidden);
  });

  test("the rule fires when it is violated — rooted specifier", () => {
    const src = ["s", "r", "c"].join("");
    expect(reachesIntoSrc(`${src}/agent/detect.ts`)).toBe(true);
    expect(reachesIntoSrc(`@/${src}/agent/detect.ts`)).toBe(true);
    // A Windows-style separator is the same mistake wearing a different hat.
    expect(reachesIntoSrc(`..\\${src}\\agent\\detect.ts`)).toBe(true);
  });

  test("it does not fire on things that merely contain the letters", () => {
    expect(reachesIntoSrc("node:fs")).toBe(false);
    expect(reachesIntoSrc("./lib/imports.ts")).toBe(false);
    expect(reachesIntoSrc("some-srcish-package")).toBe(false);
  });

  test("the scanner sees every import form", () => {
    const source = [
      'import a from "one";',
      'import type { B } from "two";',
      'export { c } from "three";',
      'const d = await import("four");',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["one", "two", "three", "four"]);
  });
});

describe("ruling 47: every .ts file opens with the SPDX line", () => {
  test("over the real tree", () => {
    const missing = [...typescriptFiles(BAR)].filter(([, source]) => !hasSpdxHeader(source)).map(([f]) => f);
    expect(missing).toEqual([]);
  });

  test("and the check fires when the line is absent or wrong", () => {
    expect(hasSpdxHeader("// nothing\n")).toBe(false);
    expect(hasSpdxHeader("// SPDX-License-Identifier: MIT\n")).toBe(false);
    expect(hasSpdxHeader("#!/usr/bin/env bun\n// SPDX-License-Identifier: Apache-2.0\n")).toBe(true);
  });
});

describe("the register agrees with BAR.md, which is the only authority", () => {
  test("no disagreement in either direction", () => {
    // Titles, ruling lists and the count all come from the document. A constant
    // beside the register was not a guard: a critic deleted three items and
    // edited it on an adjacent line for a fully green bar.
    expect(disagreements(readSpec(), ITEMS).map((d) => d.detail)).toEqual([]);
  });

  test("the document really defines thirteen items", () => {
    expect(readSpec()).toHaveLength(13);
    expect(ITEMS.map((i) => i.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  test("no item cites a ruling BAR.md's coverage table has never heard of", () => {
    // The table stops at 72. `scripts/claims.ts` enforces this over the whole
    // tree; asserting it here means the failure names the item rather than the
    // file.
    for (const item of ITEMS) {
      for (const ruling of item.rulings) {
        expect(ruling).toBeGreaterThan(0);
        expect(ruling).toBeLessThanOrEqual(72);
      }
    }
  });

  test("requiresLive is set deliberately, not defaulted everywhere", () => {
    const offline = ITEMS.filter((i) => !i.requiresLive).map((i) => i.id);
    // Items 1, 8 and 10 need no credentials at all: detection states can be
    // planted, plan admission happens before any agent turn, and the artifact's
    // own bytes need no account. Every OTHER item still grades a credential-free
    // half — see `bar/lib/halves.ts` — so the CI leg BAR.md calls authoritative
    // is not limited to these three.
    expect(offline).toEqual([1, 8, 10]);
  });
});
