// SPDX-License-Identifier: Apache-2.0
/**
 * The denominator, in both directions, with real `git`.
 *
 * MEASURED on this host on 2026-08-18: item 5 planted five defect markers in
 * `seeds/reviewed.seed` as `uncommitted-tracked` and expected a reviewer to find
 * them in `git diff <base>..work`. Ruling 33 carries uncommitted TRACKED and
 * UNTRACKED work into the base commit, so the markers were in the BASE and the
 * diff never mentioned them. Item 5 would have recorded `caughtDefects: []`
 * however well the reviewer performed — and `BAR.md` makes that number the
 * public verdict on ruling 52's assumption, printed beside v1's 0-of-3 baseline.
 *
 * The failure was silent and pointed the wrong way: it looked exactly like a
 * product that reviews badly.
 *
 * So both directions are driven here against real repositories, real seeds and
 * real `git`. The negative control REPRODUCES the defect rather than describing
 * it: same repository, same seed, same placement, only the directive changed
 * back to the one that does not carry. If that block ever starts passing with
 * markers present, the control has stopped controlling.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rehearseBuilderTurn } from "./denominator.ts";
import { typescriptFiles } from "./imports.ts";
import { plantVendor } from "./fixtures.ts";
import { ensureDir } from "./fs.ts";
import { makeRepo, plantSeeds } from "./git.ts";
import { nonce } from "./derive.ts";
import { token } from "./plan.ts";
import { exec } from "./proc.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-denominator-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MARKERS = Array.from({ length: 5 }, (_, i) => token(`DEFECT-${i + 1}`));

/** A repository shaped exactly as item 5 builds one. */
async function bed(name: string): Promise<{ repo: string; binDir: string; vendor: string }> {
  const root = ensureDir(join(scratch, name));
  const repo = join(root, "repo");
  await makeRepo(repo, { "README.md": "base\n" });
  await plantSeeds(repo, [
    {
      path: "seeds/reviewed.seed",
      value: `${nonce("reviewed-seed")}\n${MARKERS.join("\n")}`,
      // The placement is NOT the bug and is not changed here: it is how items
      // prove ruling 33 carries uncommitted tracked work into every clone.
      placement: "uncommitted-tracked",
    },
  ]);
  const binDir = ensureDir(join(root, "bin"));
  const vendor = plantVendor(binDir, { id: "qwen", version: "0.21.13" });
  return { repo, binDir, vendor };
}

describe("a reviewer's diff really carries the planted defects", () => {
  test("derive-and-carry puts every marker into `git diff base..work`", async () => {
    const { repo, binDir, vendor } = await bed("carry");
    const rehearsal = await rehearseBuilderTurn({
      repo,
      scratch: join(scratch, "carry", "work"),
      vendorBin: vendor,
      binDir,
      itemId: "reviewed",
      directive: { do: "derive-and-carry", read: "seeds/reviewed.seed", path: "reviewed.txt", salt: "reviewed" },
      markers: MARKERS,
    });

    expect(rehearsal.missing).toEqual([]);
    // Asserted as ADDED lines, not merely as bytes present somewhere: a marker
    // that appeared on the `-` side would mean the reviewer was shown a removal.
    for (const marker of MARKERS) expect(rehearsal.diff).toContain(`+${marker}`);
    // And it is in the file the BUILDER created, which is what put it in the diff.
    expect(rehearsal.diff).toContain("+++ b/reviewed.txt");
  }, 120_000);

  test("NEGATIVE CONTROL: with the old directive the diff carries NONE of them", async () => {
    const { repo, binDir, vendor } = await bed("seed-only");
    const rehearsal = await rehearseBuilderTurn({
      repo,
      scratch: join(scratch, "seed-only", "work"),
      vendorBin: vendor,
      binDir,
      itemId: "reviewed",
      // The exact shape item 5 shipped with. Everything else is identical.
      directive: { do: "derive-write", read: "seeds/reviewed.seed", path: "reviewed.txt", salt: "reviewed" },
      markers: MARKERS,
    });

    // THE DEFECT, reproduced. The builder really worked and really committed —
    // the diff is not empty — and not one marker is in it.
    expect(rehearsal.diff.length).toBeGreaterThan(0);
    expect(rehearsal.diff).toContain("+++ b/reviewed.txt");
    expect(rehearsal.missing).toEqual([...MARKERS]);

    // And here is WHY, read out of the base commit itself rather than asserted
    // from the ruling: ruling 33's base already holds every marker, so there is
    // nothing left for the diff to introduce.
    const inBase = await exec(["git", "show", `${rehearsal.baseSha}:seeds/reviewed.seed`], {
      cwd: join(scratch, "seed-only", "work"),
      timeoutMs: 60_000,
    });
    expect(inBase.code).toBe(0);
    for (const marker of MARKERS) expect(inBase.stdout).toContain(marker);
  }, 120_000);
});

/**
 * The audit, made mechanical so it survives the next item.
 *
 * `uncommitted-tracked` is legitimate and load-bearing — items 2 and 4 use it to
 * prove ruling 33 carries the operator's uncommitted work into every clone — so
 * the rule is not "never plant that way". The rule is narrower and is the one
 * that was actually broken: an item that expects a REVIEWER to find a marker
 * needs that marker in what the builder WRITES, because the reviewer's brief is
 * `git diff <base>..work` and nothing else.
 *
 * Item 5 is the only such item today. This asserts that, so a second one cannot
 * arrive quietly with the defect back in it.
 */
describe("no item expects a reviewer to find something the base already holds", () => {
  /** Items that configure a reviewer fixture with a list of markers to spot. */
  function itemsWithReviewerCatches(files: ReadonlyMap<string, string>): string[] {
    return [...files]
      .filter(([path]) => /^items\/\d+-/.test(path))
      .filter(([, source]) => /\bcatches:\s/.test(source))
      .map(([path]) => path)
      .sort();
  }

  const BAR = new URL("..", import.meta.url).pathname;

  test("every item that configures reviewer catches uses derive-and-carry", () => {
    const files = typescriptFiles(BAR);
    const owners = itemsWithReviewerCatches(files);
    expect(owners).toEqual(["items/05-review-is-cross-vendor.ts"]);
    for (const owner of owners) {
      const source = files.get(owner) ?? "";
      expect(source).toContain('do: "derive-and-carry"');
      // And the old shape must not be what feeds the reviewed item.
      expect(/read: "seeds\/reviewed\.seed"[\s\S]{0,80}?do: "derive-write"/.test(source)).toBe(false);
    }
  });

  test("NEGATIVE CONTROL: the scan finds an item that configures catches without carrying", () => {
    const planted = new Map([
      ["items/99-invented.ts", 'plantFleet(bin, l, [{ id: "copilot", catches: defects }]);\ndirective: { do: "derive-write" }'],
      ["items/98-unrelated.ts", 'plantSeeds(repo, [{ placement: "uncommitted-tracked" }]);'],
    ]);
    expect(itemsWithReviewerCatches(planted)).toEqual(["items/99-invented.ts"]);
    expect(planted.get("items/99-invented.ts")).not.toContain('do: "derive-and-carry"');
    // The unrelated item plants the same way and is correctly ignored: the
    // placement is not the defect, the expectation about the diff is.
    expect(itemsWithReviewerCatches(planted)).not.toContain("items/98-unrelated.ts");
  });
});
