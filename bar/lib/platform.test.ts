// SPDX-License-Identifier: Apache-2.0
/**
 * The ruling of 2026-08-20, kept enforced rather than kept in a comment.
 *
 * `bar/lib/platform.ts` carries the decision and its accepted cost. This file is
 * what stops it drifting back: it proves `notRunHere` really fails, and it scans
 * every test file in the repository for the shape it replaced. A ruling that is
 * only prose is a ruling that lasts until the next person in a hurry.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { notRunHere } from "./platform.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");

/** Every `*.test.ts` under `bar/` and `test/`, found by walking rather than by a glob. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".test.ts")) found.push(path);
    }
  };
  for (const root of ["bar", "test"]) walk(join(REPO, root));
  return found;
}

describe("a platform-gated test fails rather than passing vacuously", () => {
  test("`notRunHere` throws, and the message names what did not run and why", () => {
    let thrown: unknown;
    try {
      notRunHere("the thing this test drives", "the mechanism it needs does not exist here.");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("NOT-RUN on ");
    expect(message).toContain("the thing this test drives");
    expect(message).toContain("the mechanism it needs does not exist here.");
    // The citation, so a reader of a CI log alone can find the ruling.
    expect(message).toContain("Ruling 62 (c)");
    expect(message).toContain("bar/lib/platform.ts");
  });

  test("NO test file carries a bare platform early return in a test body", () => {
    // THE SCAN, not a memory of the eleven. `bun run claims` is a full-tree scan
    // for exactly this reason — v1 lost four documents in one day to staleness
    // and every instance passed all four gates, because the stale file was one
    // nobody had touched. Eleven of these accumulated the same way.
    //
    // `return;` with nothing after it is the shape that renders as `(pass)`. A
    // helper returning a platform-appropriate VALUE — `test/run-start.test.ts`
    // and `test/sweep-escape.test.ts` each have one — is a different thing and
    // is deliberately not matched.
    const bare = /if \(process\.platform ===\s*"(?:win32|darwin|linux)"\)\s*return;/;
    const offenders = testFiles()
      .map((path) => path.slice(REPO.length + 1))
      // This file itself, because its negative control below has to CONTAIN the
      // shape in order to prove the regex matches it. Excluded by exact path and
      // by nothing else: a pattern-based exclusion would grow to cover whatever
      // the next offender happened to look like.
      .filter((relative) => relative.replace(/\\/g, "/") !== "bar/lib/platform.test.ts")
      .filter((relative) => bare.test(readFileSync(join(REPO, relative), "utf8")));
    expect(
      offenders,
      "a test body that returns early on a platform reports `(pass)` in a fraction of a millisecond, " +
        "and `scripts/test-gate.ts` counts skip, todo, fail and error — so it can see none of it. " +
        "Use `notRunHere(what, why)` from `bar/lib/platform.ts`, which fails and says what did not run.",
    ).toEqual([]);
  });

  test("NEGATIVE CONTROL: the scan really matches the shape it is looking for", () => {
    // Without this the row above passes on a regex that matches nothing, which
    // is the same defect one level up from the one it exists to catch.
    const bare = /if \(process\.platform ===\s*"(?:win32|darwin|linux)"\)\s*return;/;
    expect(bare.test('  if (process.platform === "win32") return;')).toBe(true);
    expect(bare.test('  if (process.platform === "win32") return ["bun", script];')).toBe(false);
    expect(bare.test('  if (process.platform === "win32") return null;')).toBe(false);
  });
});
