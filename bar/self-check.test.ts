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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ITEMS } from "./items/index.ts";
import { emptyFlight, sampleOnce, type CloneSample } from "./lib/inflight.ts";
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

  test("the document really defines fourteen items", () => {
    // Fourteen since 2026-08-20. Item 14 was added after an independent verifier
    // read 13 PASS on an artifact whose every direct agent profile was
    // unstartable — the fixtures tested the fixture protocol and nothing tested
    // the vendors' real argv and config-root contracts.
    expect(readSpec()).toHaveLength(14);
    expect(ITEMS.map((i) => i.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
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

/**
 * The in-flight sampler's "base commit present" sub-check, in BOTH directions.
 *
 * This block exists because that sub-check had no test at all, and it was
 * wrong. It looked for a ref literally named `refs/heads/bar-base` — the name
 * `bar/fakes/honest.ts` fetches ITS base onto — so it reported `base=false`
 * against every real implementation while the harness's own fixture sailed
 * through. A check only the fake can satisfy is worse than no check: it grades
 * a correct product as non-conforming and it looks green the whole time.
 *
 * The rule this file opens with is why it survived. `bar/` imports nothing from
 * `src/`, so the ref name was a second copy of a product constant with nothing
 * holding the two together — and copies go stale silently unless something
 * asserts on them. This is that something.
 *
 * All three shapes are built out of real `git`, because the thing under test is
 * a `git` probe and a mocked one would be testing this test.
 */
describe("the sampler judges a clone by what it IS, not by the fixture's ref name", () => {
  const git = (cwd: string, ...args: string[]): string => {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} in ${cwd}: ${new TextDecoder().decode(proc.stderr)}`);
    }
    return new TextDecoder().decode(proc.stdout).trim();
  };

  let scratch: string;
  let runRoot: string;
  let operatorHead: string;

  /** A clone shaped exactly as a worker's is, with the base on `branch`. */
  const plantClone = (name: string, branch: string, parent: string): string => {
    const dir = join(runRoot, name);
    git(scratch, "clone", "-q", "--local", parent, dir);
    git(dir, "config", "user.email", "w@e.invalid");
    git(dir, "config", "user.name", "w");
    git(dir, "remote", "remove", "origin");
    // The base arrives by explicit fetch, exactly as it does in the product:
    // the ref lives outside `refs/heads/` so a default clone does not carry it.
    git(dir, "fetch", "--no-tags", parent, `+refs/testbase:refs/heads/${branch}`);
    git(dir, "checkout", "-q", "-b", "work", branch);
    return dir;
  };

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-inflight-")));
    runRoot = join(scratch, "runs");
    mkdirSync(runRoot, { recursive: true });

    const parent = join(scratch, "parent");
    mkdirSync(parent, { recursive: true });
    git(parent, "init", "-q", "-b", "main", ".");
    git(parent, "config", "user.email", "o@e.invalid");
    git(parent, "config", "user.name", "o");
    writeFileSync(join(parent, "a.txt"), "committed\n");
    git(parent, "add", "-A");
    git(parent, "commit", "-q", "-m", "the operator's HEAD");
    operatorHead = git(parent, "rev-parse", "HEAD");

    // Ruling 33's base commit: the operator's uncommitted work, carried. It is
    // a DIFFERENT commit from their HEAD, which is the property the sampler
    // uses when the caller knows it.
    writeFileSync(join(parent, "a.txt"), "uncommitted edit\n");
    git(parent, "add", "-A");
    git(parent, "commit", "-q", "-m", "scratch base");
    const base = git(parent, "rev-parse", "HEAD");
    git(parent, "update-ref", "refs/testbase", base);
    git(parent, "reset", "-q", "--hard", operatorHead);

    // The product's shape, whatever it calls its base branch. `brigadier-base`
    // is used here because that is what the product uses TODAY — but the test
    // below must not depend on the name, so a deliberately unrelated third name
    // is planted too.
    plantClone("product", "brigadier-base", parent);
    plantClone("fixture", "bar-base", parent);
    plantClone("some-other-name", "whatever-a-future-build-calls-it", parent);

    // The forger: real git, a real commit, and no base state behind it.
    const forger = join(runRoot, "forger");
    mkdirSync(forger, { recursive: true });
    git(forger, "init", "-q", "-b", "work", ".");
    git(forger, "config", "user.email", "f@e.invalid");
    git(forger, "config", "user.name", "f");
    writeFileSync(join(forger, "a.txt"), "invented\n");
    git(forger, "add", "-A");
    git(forger, "commit", "-q", "-m", "no base behind this");
  }, 120_000);

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const sample = (): Map<string, CloneSample> => {
    const flight = emptyFlight();
    // `processes: false` — the process table is a different claim, and reading
    // it here would cost a `ps -A` for nothing.
    sampleOnce(runRoot, flight, undefined, false, operatorHead);
    return flight.clonesSeen;
  };

  test("a clone whose base branch is NOT the fixture's name is still conforming", () => {
    const seen = sample();
    // THE REGRESSION. Every one of these was `base=false` before the fix, and
    // the product's own shape is the first of them.
    for (const name of ["product", "some-other-name"]) {
      const clone = seen.get(join(runRoot, name));
      expect(clone?.isGitRepo).toBe(true);
      expect(clone?.originRemoved).toBe(true);
      expect(clone?.hasBaseRef).toBe(true);
    }
  });

  test("the fixture's own shape is conforming too — the fix did not just move the name", () => {
    const clone = sample().get(join(runRoot, "fixture"));
    expect(clone?.hasBaseRef).toBe(true);
  });

  test("the evidence names the refs the checkout descends from, not just a verdict", () => {
    const clone = sample().get(join(runRoot, "product"));
    // Asserted on the ref names themselves. A boolean survives a refactor that
    // removes the property it stood for; a list of refs read out of the clone
    // does not.
    expect(clone?.baseRefsSeen.some((r) => r.startsWith("refs/heads/brigadier-base@"))).toBe(true);
    expect(clone?.baseRefsSeen.some((r) => r.startsWith("refs/heads/work@"))).toBe(false);
  });

  test("NEGATIVE CONTROL: real git with no base state behind it is NOT conforming", () => {
    const clone = sample().get(join(runRoot, "forger"));
    expect(clone?.isGitRepo).toBe(true);
    // It committed, so it has a HEAD. What it does not have is anything its
    // checkout descends FROM — which is the whole of the claim.
    expect(clone?.baseRefsSeen).toEqual([]);
    expect(clone?.hasBaseRef).toBe(false);
  });
});
