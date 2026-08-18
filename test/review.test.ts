// SPDX-License-Identifier: Apache-2.0
/**
 * The reviewer's seams: who is chosen, what is parsed, and what is discarded.
 *
 * Everything here is a pure function, which is exactly why it is not the whole
 * of the evidence — `test/review-run.test.ts` drives the same code as a process
 * and asserts on `git cat-file` output, because a correct predicate with no call
 * site is the shape this repository keeps catching (`driftFor` was a complete,
 * on-spec ruling 69 with zero callers and a full green suite).
 *
 * What this file is for is the cases a process test cannot reach cheaply: a
 * reviewer that echoes the template before answering, one that nests an object
 * inside `found`, one that names a defect the diff does not contain.
 */

import { describe, expect, test } from "bun:test";
import { PROFILES, type AgentId } from "../src/agent/profiles.ts";
import type { ResolvedAgent } from "../src/queue/admit.ts";
import {
  REVIEW_PREFIX,
  SELF_REVIEW_BIAS,
  catchRateLine,
  caughtIn,
  chooseReviewer,
  composeReviewBrief,
  notReviewable,
  parseVerdict,
  rankReviewers,
  reviewApplies,
  reviewQualifier,
} from "../src/queue/review.ts";

function agent(id: AgentId): ResolvedAgent {
  const profile = PROFILES[id];
  return { id, profile, resolved: `/usr/local/bin/${profile.command}`, bridged: profile.bridged, capabilities: profile.capabilities };
}

describe("ruling 32: cross-vendor is PREFERRED, and a one-vendor machine still reviews", () => {
  test("two vendors: the reviewer is not the builder's vendor", () => {
    const choice = chooseReviewer([agent("copilot"), agent("qwen")], "copilot");
    expect(choice.crossVendor).toBe(true);
    expect(choice.agent?.id).toBe("qwen");
    expect(choice.sameVendorReason).toBeUndefined();
  });

  test("one vendor: it reviews its own work, and the record says WHY it is weaker", () => {
    const choice = chooseReviewer([agent("qwen")], "qwen");
    expect(choice.crossVendor).toBe(false);
    expect(choice.agent?.id).toBe("qwen");
    // The reason is not decoration: it is the whole difference between
    // degrading visibly and degrading quietly.
    expect(choice.sameVendorReason ?? "").toContain("only qwen is drivable");
    expect(choice.sameVendorReason ?? "").toContain(SELF_REVIEW_BIAS);
  });

  test("NEGATIVE CONTROL: adding a second vendor flips the same call to cross-vendor", () => {
    // Without this, "one vendor reports same-vendor" would also be satisfied by
    // a function that reports same-vendor unconditionally.
    const one = chooseReviewer([agent("qwen")], "qwen");
    const two = chooseReviewer([agent("qwen"), agent("copilot")], "qwen");
    expect(one.crossVendor).toBe(false);
    expect(two.crossVendor).toBe(true);
    expect(two.agent?.id).not.toBe("qwen");
  });

  test("no vendor at all is NOT a same-vendor review", () => {
    const choice = chooseReviewer([], null);
    expect(choice.agent).toBeNull();
    expect(choice.sameVendorReason ?? "").toContain("no review at all");
  });

  test("ruling 68: an unranked reviewer is eligible and sorts LAST, never excluded", () => {
    // opencode carries no reviewer score. A router that refused what it has not
    // heard of would drop it, which is finding 87's shape.
    const ranked = rankReviewers([agent("opencode"), agent("qwen")]);
    expect(ranked.map((a) => a.id)).toEqual(["qwen", "opencode"]);
    expect(chooseReviewer([agent("opencode")], "qwen").agent?.id).toBe("opencode");
  });
});

describe("a reviewer that produces no verdict", () => {
  test("silence parses as no verdict, not as approval", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("Looks good to me! No problems found.")).toBeNull();
    expect(parseVerdict("VERDICT approved")).toBeNull();
    expect(parseVerdict('VERDICT {"verdict": "maybe"}')).toBeNull();
  });

  test("the LAST verdict wins, so an echoed template is not read as the answer", () => {
    const text = [
      "I will answer in this shape:",
      REVIEW_PREFIX.split("\n").find((l) => l.startsWith("VERDICT")) ?? "",
      "Having read the diff:",
      'VERDICT {"verdict": "rejected", "found": ["src/a.ts: off-by-one"]}',
    ].join("\n");
    expect(parseVerdict(text)).toEqual({ verdict: "rejected", found: ["src/a.ts: off-by-one"] });
  });

  test("a nested object inside `found` does not truncate the parse", () => {
    const text = 'VERDICT {"verdict": "rejected", "found": ["A"], "notes": {"where": "x"}}';
    expect(parseVerdict(text)?.verdict).toBe("rejected");
    expect(parseVerdict(text)?.found).toEqual(["A"]);
  });

  test("a brace inside a string does not truncate it either", () => {
    const text = 'VERDICT {"verdict": "rejected", "found": ["a { b"]}';
    expect(parseVerdict(text)?.found).toEqual(["a { b"]);
  });
});

describe("FOUND, not KNOWN: a claim is kept only where the diff carries it", () => {
  test("a defect the diff does not contain is discarded", () => {
    const diff = "+const x = 1; // DEFECT-AAA\n";
    expect(caughtIn(diff, ["DEFECT-AAA", "DEFECT-GHOST"])).toEqual(["DEFECT-AAA"]);
  });

  test("NEGATIVE CONTROL: an empty claim list is not a perfect score", () => {
    // `.every()` is true of an empty array, so a check written the obvious way
    // scores a reviewer that found nothing as one that found everything.
    expect(caughtIn("+anything\n", [])).toEqual([]);
    expect(caughtIn("", ["DEFECT-AAA"])).toEqual([]);
  });

  test("duplicates collapse: the rate counts defects, not mentions", () => {
    expect(caughtIn("+DEFECT-AAA\n", ["DEFECT-AAA", "DEFECT-AAA"])).toEqual(["DEFECT-AAA"]);
  });
});

describe("the catch rate is PUBLISHED, not gated", () => {
  test("with a denominator it is a rate, and it prints whatever the number is", () => {
    expect(catchRateLine(0, 5)).toContain("catch rate 0 of 5");
    expect(catchRateLine(5, 5)).toContain("catch rate 5 of 5");
    expect(catchRateLine(0, 5)).toContain("0 of 3");
  });

  test("without one it is a count, and it says so rather than inventing a denominator", () => {
    expect(catchRateLine(2, undefined)).not.toMatch(/catch rate \d+ of \d+/);
    expect(catchRateLine(2, undefined)).toContain("2 defect(s)");
  });
});

describe("the brief", () => {
  const brief = composeReviewBrief({
    id: "alpha",
    kind: "write",
    paths: ["a.txt"],
    prompt: "write a.txt",
    baseRef: "refs/brigadier/r1/base",
    baseSha: "0".repeat(40),
    itemRef: "refs/brigadier/r1/review/1",
    diff: "+DEFECT-AAA\n",
  });

  test("ruling 21: every byte of the prefix comes first, and nothing item-specific is in it", () => {
    expect(brief.startsWith(REVIEW_PREFIX)).toBe(true);
    expect(REVIEW_PREFIX).not.toContain("alpha");
    expect(REVIEW_PREFIX).not.toContain("refs/brigadier");
  });

  test("ruling 52: the diff, and the base it is taken against, are both in it", () => {
    expect(brief).toContain("+DEFECT-AAA");
    expect(brief).toContain(`git diff ${"0".repeat(40)}..refs/brigadier/r1/review/1`);
  });
});

describe("ruling 49: a read-only item has no diff, so there is nothing to review", () => {
  test("the check is `unconfigured` — an absent check, not a skipped one", () => {
    expect(reviewApplies("write")).toBe(true);
    expect(reviewApplies("read-only")).toBe(false);
    expect(notReviewable("read-only").outcome).toBe("unconfigured");
  });
});

describe("ruling 52: the qualifier lives INSIDE the result string", () => {
  test("cross-vendor and same-vendor are different words, and one of them shouts", () => {
    expect(reviewQualifier({ crossVendor: true }, "qwen", "copilot")).toContain("cross-vendor");
    const same = reviewQualifier({ crossVendor: false }, "qwen", "qwen");
    expect(same).toContain("SAME-VENDOR");
    expect(same).not.toContain("cross-vendor");
  });
});
