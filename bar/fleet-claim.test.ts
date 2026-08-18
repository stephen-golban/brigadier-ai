// SPDX-License-Identifier: Apache-2.0
/**
 * Which items drive the operator's REAL fleet, checked against the code.
 *
 * `bar/lib/fleet.ts` said "items 2 and 5 drive the operator's REAL, credentialed
 * fleet" for as long as it has existed, and item 2's code has always planted
 * fixtures. Nothing caught it: a comment is text, and ruling 62(g) exists
 * because every one of v1's four documents lost to invisible staleness in a
 * single day passed all four gates. The mitigation that actually worked there
 * was a full-tree grep for the CLAIM, not a review of changed files — so that is
 * what this is.
 *
 * It is load-bearing rather than tidy. `fleet.ts` is the document a reader
 * consults to learn which results are credentialed and which came from a stub
 * that denies what it was told to deny. A wrong answer there makes a fixture
 * result read as a vendor result.
 *
 * Both directions, per `AGENTS.md`: the claim holds over the real tree, AND the
 * scan fires when handed an item that plants fixtures while claiming otherwise.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { typescriptFiles } from "./lib/imports.ts";

const BAR = fileURLToPath(new URL(".", import.meta.url));

/** Item files that call `detectRealFleet`, by item number. */
export function itemsDrivingRealFleet(files: ReadonlyMap<string, string>): number[] {
  const found: number[] = [];
  for (const [path, source] of files) {
    const match = /^items\/(\d+)-/.exec(path);
    if (match === null) continue;
    if (/\bdetectRealFleet\s*\(/.test(source)) found.push(Number(match[1]));
  }
  return found.sort((a, b) => a - b);
}

describe("bar/lib/fleet.ts tells the truth about which items are credentialed", () => {
  test("exactly one item calls detectRealFleet, and it is item 5", () => {
    expect(itemsDrivingRealFleet(typescriptFiles(BAR))).toEqual([5]);
  });

  test("the comment names that item and no other", () => {
    const fleet = readFileSync(fileURLToPath(new URL("./lib/fleet.ts", import.meta.url)), "utf8");
    // The sentence a reader relies on, asserted as bytes.
    expect(fleet).toContain("Exactly ONE item drives the operator's real, credentialed fleet: item 5.");
    // And the stale form must be gone, in either spelling.
    expect(/items?\s+2\s+and\s+5\s+drive/i.test(fleet)).toBe(false);
  });

  test("NEGATIVE CONTROL: the scan sees an item that only plants fixtures", () => {
    const planted = new Map([
      ["items/02-the-lane-holds.ts", "const fleet = plantFleet(binDir, ledger, []);"],
      ["items/05-review-is-cross-vendor.ts", "const realFleet = await detectRealFleet(ctx);"],
    ]);
    // Item 2 is absent from the answer precisely because planting is not driving.
    expect(itemsDrivingRealFleet(planted)).toEqual([5]);
    // And when an item DOES start driving the real fleet, the scan says so —
    // which is what makes the assertion above fail rather than rot.
    planted.set("items/02-the-lane-holds.ts", "const realFleet = await detectRealFleet(ctx);");
    expect(itemsDrivingRealFleet(planted)).toEqual([2, 5]);
  });
});
