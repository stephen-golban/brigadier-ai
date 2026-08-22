// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 75's D13, D14 and D15: a run that stops to ask, and what makes it stop
 * being resumable.
 *
 * **The interesting assertions here are the ones where NOTHING expires.** D15
 * chose divergence over a clock and then qualified it — *"divergence is
 * path-scoped rather than whole-tree, so an unrelated typo fix does not
 * invalidate a run"* — and a check that expired everything would satisfy every
 * safety-shaped test while making the feature useless. So each expiry below has
 * its survival beside it.
 */

import { describe, expect, test } from "bun:test";
import { BACKSTOP_DAYS, divergence } from "../src/run/divergence.ts";
import { PendingUnusable, encodePending, pendingPath, readPending, type PendingRun } from "../src/run/pending.ts";

const DAY = 24 * 60 * 60 * 1000;
const ASKED_AT = 1_787_000_000_000;

const PENDING: PendingRun = {
  version: 1,
  runId: "r1",
  askedAt: ASKED_AT,
  kind: "plan-consent",
  question: "plan it anyway?",
  goal: "fix the typo",
  repo: "/repo",
  head: "aaaaaaaaaaaa1111",
  dirty: [],
  paths: [],
  agents: [{ id: "claude", version: "0.70.0" }],
};

const FLEET = { usable: [{ id: "claude", version: "0.70.0" }] };
const SAME = { head: PENDING.head, dirty: [], changedSinceHead: [] };

const ask = (over: Partial<PendingRun>): PendingRun => ({ ...PENDING, ...over });

describe("a pending run survives what does not make it wrong", () => {
  test("nothing moved: resumable, with no reasons at all", () => {
    const verdict = divergence(PENDING, SAME, FLEET, ASKED_AT + 60_000);
    expect(verdict.resumable).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  test("THE TYPO FIX: a commit while the question was open, with no plan yet", () => {
    // D15's own example. Nothing had been computed against the repository when
    // the question was asked — `paths` is empty — so a newer base is simply the
    // base the plan will be made from.
    const verdict = divergence(
      PENDING,
      { head: "bbbbbbbbbbbb2222", dirty: ["README.md"], changedSinceHead: ["README.md"] },
      FLEET,
      ASKED_AT + 60_000,
    );
    expect(verdict.resumable).toBe(true);
  });

  test("a commit that misses every path the plan claims", () => {
    const verdict = divergence(
      ask({ paths: ["src/a.ts"] }),
      { head: "bbbbbbbbbbbb2222", dirty: [], changedSinceHead: ["docs/README.md"] },
      FLEET,
      ASKED_AT + 60_000,
    );
    expect(verdict.resumable).toBe(true);
  });

  test("a path that was ALREADY dirty when the question was asked", () => {
    // It was dirty then and it is dirty now: nothing changed under the run's
    // feet, and expiring here would punish an operator for the state they were
    // in when brigadier asked.
    const verdict = divergence(
      ask({ paths: ["src/a.ts"], dirty: ["src/a.ts"] }),
      { head: PENDING.head, dirty: ["src/a.ts"], changedSinceHead: [] },
      FLEET,
      ASKED_AT + 60_000,
    );
    expect(verdict.resumable).toBe(true);
  });

  test("six days is not seven", () => {
    expect(divergence(PENDING, SAME, FLEET, ASKED_AT + 6 * DAY).resumable).toBe(true);
  });
});

describe("a pending run expires when resuming would be wrong", () => {
  test("a commit over a path the plan claims", () => {
    const verdict = divergence(
      ask({ paths: ["src/a.ts", "src/b.ts"] }),
      { head: "bbbbbbbbbbbb2222", dirty: [], changedSinceHead: ["src/b.ts"] },
      FLEET,
      ASKED_AT + 60_000,
    );
    expect(verdict.resumable).toBe(false);
    expect(verdict.reasons.join("\n")).toContain("src/b.ts");
  });

  test("an EDIT to a path the plan claims, made while the question was open", () => {
    const verdict = divergence(
      ask({ paths: ["src/a.ts"] }),
      { head: PENDING.head, dirty: ["src/a.ts"], changedSinceHead: [] },
      FLEET,
      ASKED_AT + 60_000,
    );
    expect(verdict.resumable).toBe(false);
    expect(verdict.reasons.join("\n")).toContain("edited while the question was open");
  });

  test("A HEAD GIT CANNOT DIFF FROM expires, rather than being read as unchanged", () => {
    // A rebase, a reset, a pruned branch. `undefined` is the unanswerable case,
    // and every state except positively established sameness expires — the same
    // asymmetry `kept.ts` applies in the other direction.
    const verdict = divergence(
      PENDING,
      { head: "bbbbbbbbbbbb2222", dirty: [], changedSinceHead: undefined },
      FLEET,
      ASKED_AT + 60_000,
    );
    expect(verdict.resumable).toBe(false);
    expect(verdict.reasons.join("\n")).toContain("git cannot say what moved");
  });

  test("a routed vendor that is gone", () => {
    const verdict = divergence(PENDING, SAME, { usable: [] }, ASKED_AT + 60_000);
    expect(verdict.resumable).toBe(false);
    expect(verdict.reasons.join("\n")).toContain("no longer usable");
  });

  test("a routed vendor that DRIFTED under the same name (ruling 69)", () => {
    const verdict = divergence(PENDING, SAME, { usable: [{ id: "claude", version: "0.71.0" }] }, ASKED_AT + 60_000);
    expect(verdict.resumable).toBe(false);
    expect(verdict.reasons.join("\n")).toContain("0.70.0");
    expect(verdict.reasons.join("\n")).toContain("0.71.0");
  });

  test("the backstop fires, and PRINTS ITSELF as the judgement it is", () => {
    const verdict = divergence(PENDING, SAME, FLEET, ASKED_AT + (BACKSTOP_DAYS + 1) * DAY);
    expect(verdict.resumable).toBe(false);
    const reason = verdict.reasons.join("\n");
    // D15 requires the number to be printed beside every expiry it causes, the
    // way BAR.md prints the 2.5 MiB budget beside every verdict it produces.
    expect(reason).toContain(`${BACKSTOP_DAYS}-day`);
    expect(reason).toContain("JUDGEMENT and not a measurement");
    // And it says the honest thing: nothing diverged and it expired anyway.
    expect(reason).toContain("nothing diverged");
  });

  test("the backstop is seven days, and that number is the one in the message", () => {
    expect(BACKSTOP_DAYS).toBe(7);
  });
});

describe("the pending file refuses what it cannot act on", () => {
  const read = (text: string) => readPending("/p.json", () => text);

  test("a good record round-trips", () => {
    const back = read(encodePending(PENDING));
    expect(back).toEqual(PENDING);
  });

  test("a future version is refused rather than guessed at", () => {
    expect(() => read(JSON.stringify({ ...PENDING, version: 2 }))).toThrow(PendingUnusable);
  });

  test("a missing field is refused BY NAME", () => {
    const { goal, ...without } = PENDING;
    expect(() => read(JSON.stringify(without))).toThrow(/`goal` is missing/);
  });

  test("a missing askedAt says what it costs: D15's backstop cannot be applied", () => {
    const { askedAt, ...without } = PENDING;
    expect(() => read(JSON.stringify(without))).toThrow(/backstop cannot be applied/);
  });

  test("text that is not JSON is refused as that, not as a missing field", () => {
    expect(() => read("not json")).toThrow(/not valid JSON/);
  });

  test("it lives beside the plan it belongs to", () => {
    expect(pendingPath("/root", "r1")).toBe("/root/r/r1/pending.json");
  });
});
