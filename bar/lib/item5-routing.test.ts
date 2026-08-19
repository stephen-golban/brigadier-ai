// SPDX-License-Identifier: Apache-2.0
/**
 * The negative control for item 5's routing guard (ruling 62b).
 *
 * The positive case is cheap and proves nothing on its own: a guard that always
 * passes looks identical to a working one. So the first test below REPLAYS the
 * 2026-08-19 misrouting exactly as it happened — capability configured on
 * `copilot`, `copilot` routed as the BUILDER, `qwen` routed as the reviewer —
 * and asserts this module refuses it. If that block ever starts returning
 * `onTarget: true`, item 5 can publish a fabricated catch rate again.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plantFleet } from "./fixtures.ts";
import { fleetFor, judgePlantRouting, nameDiff, readRouting } from "./item5-routing.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "item5-routing-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const VENDORS = [
  { id: "qwen", version: "0.21.13" },
  { id: "copilot", version: "1.0.80" },
] as const;

describe("item 5 — the plant must land on the vendor that reviews", () => {
  test("NEGATIVE CONTROL: the 2026-08-19 misrouting is refused, and named", () => {
    const verdict = judgePlantRouting({
      configured: "copilot",
      recordBuilder: "copilot",
      recordReviewer: "qwen",
      ledgerReviewers: ["qwen"],
    });
    expect(verdict.onTarget).toBe(false);
    // The failure has to say WHICH vendor was which, or the reader is left with
    // the same unreadable number the defect produced.
    expect(verdict.detail).toContain("copilot");
    expect(verdict.detail).toContain("qwen");
    expect(verdict.detail).toContain("THE PLANT IS ON THE BUILDER");
  });

  test("the plant on the routed reviewer is accepted", () => {
    const verdict = judgePlantRouting({
      configured: "qwen",
      recordBuilder: "copilot",
      recordReviewer: "qwen",
      ledgerReviewers: ["qwen"],
    });
    expect(verdict.onTarget).toBe(true);
  });

  test("a record that names no reviewer is refused, not treated as a zero catch rate", () => {
    const verdict = judgePlantRouting({
      configured: "qwen",
      recordBuilder: "copilot",
      recordReviewer: undefined,
      ledgerReviewers: [],
    });
    expect(verdict.onTarget).toBe(false);
    expect(verdict.detail).toContain("names no reviewer");
  });

  test("a record whose named reviewer never ran as a PROCESS is refused", () => {
    const verdict = judgePlantRouting({
      configured: "qwen",
      recordBuilder: "copilot",
      recordReviewer: "qwen",
      ledgerReviewers: [],
    });
    expect(verdict.onTarget).toBe(false);
    expect(verdict.detail).toContain("no such vendor PROCESS ran as one");
  });

  test("an unplanted run is refused rather than scored", () => {
    expect(
      judgePlantRouting({
        configured: undefined,
        recordBuilder: "copilot",
        recordReviewer: "qwen",
        ledgerReviewers: ["qwen"],
      }).onTarget,
    ).toBe(false);
  });
});

describe("item 5 — reading the routing rather than assuming it", () => {
  test("record and ledger agreeing is the only thing that places the plant", () => {
    const read = readRouting({
      recordBuilder: "copilot",
      recordReviewer: "qwen",
      ledgerReviewers: ["qwen"],
      ledgerBuilders: ["copilot"],
    });
    expect(read.vendor).toBe("qwen");
  });

  test("NEGATIVE CONTROL: record and ledger disagreeing places nothing", () => {
    const read = readRouting({
      recordBuilder: "qwen",
      recordReviewer: "copilot",
      ledgerReviewers: ["qwen"],
      ledgerBuilders: ["copilot"],
    });
    expect(read.vendor).toBeUndefined();
    expect(read.detail).toContain("DISAGREE");
  });

  test("no reviewer named, nothing planted", () => {
    expect(
      readRouting({ recordBuilder: "copilot", recordReviewer: undefined, ledgerReviewers: ["qwen"], ledgerBuilders: ["copilot"] })
        .vendor,
    ).toBeUndefined();
  });

  test("two vendors having reviewed is ambiguous, so nothing is planted", () => {
    expect(
      readRouting({
        recordBuilder: "copilot",
        recordReviewer: "qwen",
        ledgerReviewers: ["qwen", "copilot"],
        ledgerBuilders: ["copilot"],
      }).vendor,
    ).toBeUndefined();
  });
});

describe("item 5 — the capability lands on the routed reviewer, in the bytes on disk", () => {
  test("MEASURED on this host on 2026-08-19: the product routes copilot to build and qwen to review", () => {
    // Not an assumption this file may make — it is what a real
    // `brigadier run --review` recorded against these two planted vendors, and
    // it is the reason the old hard-coded plant sat on the builder. The item
    // reads it back out of a run record every time; this test only pins the
    // SHAPE of that reading.
    const read = readRouting({
      recordBuilder: "copilot",
      recordReviewer: "qwen",
      ledgerReviewers: ["qwen"],
      ledgerBuilders: ["copilot"],
    });
    const fleet = fleetFor(VENDORS, read.vendor, { catches: ["m1", "m2", "m3"] });
    expect(fleet.find((v) => v.id === "qwen")?.catches).toEqual(["m1", "m2", "m3"]);
    expect(fleet.find((v) => v.id === "copilot")?.catches).toBeUndefined();
  });

  test("the config files the fixture actually reads carry the capability on the reviewer only", () => {
    const binDir = join(scratch, "bin");
    plantFleet(binDir, join(scratch, "ledger.tsv"), fleetFor(VENDORS, "qwen", { catches: ["m1"] }));
    const config = (id: string) => JSON.parse(readFileSync(join(binDir, `${id}.vendor.json`), "utf8")) as { catches?: string[] };
    expect(config("qwen").catches).toEqual(["m1"]);
    expect(config("copilot").catches).toBeUndefined();
  });

  test("NEGATIVE CONTROL: the capability hard-coded to copilot lands on the builder, and is refused", () => {
    // The defect, reproduced through the real code path rather than described.
    const fleet = fleetFor(VENDORS, "copilot", { catches: ["m1", "m2", "m3"] });
    expect(fleet.find((v) => v.id === "copilot")?.catches).toEqual(["m1", "m2", "m3"]);
    expect(fleet.find((v) => v.id === "qwen")?.catches).toBeUndefined();
    // The reviewer therefore has no capability at all, the run publishes a low
    // rate, and this is the assertion that stops it being read as one.
    expect(
      judgePlantRouting({
        configured: "copilot",
        recordBuilder: "copilot",
        recordReviewer: "qwen",
        ledgerReviewers: ["qwen"],
      }).onTarget,
    ).toBe(false);
  });

  test("`dieAsReviewer` follows the same routing — on the builder it never fires", () => {
    const fleet = fleetFor(VENDORS, "qwen", { dieAsReviewer: true });
    expect(fleet.find((v) => v.id === "qwen")?.dieAsReviewer).toBe(true);
    expect(fleet.find((v) => v.id === "copilot")?.dieAsReviewer).toBeUndefined();
  });

  test("an unknown reviewer attaches the capability to nobody", () => {
    const fleet = fleetFor(VENDORS, undefined, { catches: ["m1"], dieAsReviewer: true });
    expect(fleet.every((v) => v.catches === undefined && v.dieAsReviewer === undefined)).toBe(true);
  });
});

describe("item 5 — set equality on names", () => {
  test("an empty report is not a perfect score", () => {
    const diff = nameDiff([], ["a", "b", "c"]);
    expect(diff.equal).toBe(false);
    expect(diff.missing).toEqual(["a", "b", "c"]);
  });

  test("the right count of the wrong markers is not equality", () => {
    const diff = nameDiff(["x", "y", "z"], ["a", "b", "c"]);
    expect(diff.equal).toBe(false);
    expect(diff.unexpected).toEqual(["x", "y", "z"]);
  });

  test("the same names in any order are equal", () => {
    expect(nameDiff(["c", "a", "b"], ["a", "b", "c"]).equal).toBe(true);
  });
});
