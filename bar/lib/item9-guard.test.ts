// SPDX-License-Identifier: Apache-2.0
/**
 * The two pure functions item 9's whole per-vendor verdict rests on.
 *
 * `readGuard` is the only thing in this harness that can tell **the guard
 * fired** from **the guard never got the chance**, per vendor — which is ruling
 * 57's one unmeasured assumption and the reason BAR.md item 9 exists. A
 * classifier that important with no demonstrated negatives is a classifier
 * nobody has checked, so every state below is proven REACHABLE rather than
 * merely expressible, and the two states that would be most comfortable to get
 * wrong get their own tests:
 *
 *   `marker-missing` — the row that says ruling 57 is FALSIFIED on a vendor.
 *   If it were unreachable, the item could observe that failure and never
 *   report it, which is the shape this project keeps shipping.
 *
 *   `unattributable` — the row a previous draft folded into `fired` with a
 *   pigeonhole over TOTAL CALLS. Its failure mode was to manufacture the
 *   reassuring answer: one worker delegating twice and another never trying
 *   reported both as `fired`. The last test here is exactly that input, and it
 *   asserts the reassuring answer is not produced.
 */

import { describe, expect, test } from "bun:test";
import { agentSaid, parseShim, readGuard, type GuardState } from "../items/09-ambient-instructions-suppressed.ts";

const RUN = "run-abc123";

function classify(options: {
  ledger: string;
  number?: number | undefined;
  said?: "refused" | "accepted" | "unreachable" | undefined;
  identityBroken?: string | undefined;
}): GuardState {
  return readGuard({
    itemId: "worker-a",
    number: options.number ?? 1,
    vendor: "qwen",
    runId: RUN,
    calls: parseShim(options.ledger, "CALL"),
    dones: parseShim(options.ledger, "DONE"),
    said: options.said,
    ...(options.identityBroken === undefined ? {} : { identityBroken: options.identityBroken }),
  }).state;
}

const CALLED = `CALL worker=${RUN}/1 argv: run --plan whatever`;

describe("readGuard: every state is reachable, and each means one thing", () => {
  test("fired — the identity is in the ledger and the binary came back 3", () => {
    expect(
      classify({ ledger: `${CALLED}\nDONE worker=${RUN}/1 exit=3 argv: run --plan whatever`, said: "refused" }),
    ).toBe("fired");
  });

  test("reached-not-refused — the same call, and an exit that is not 3", () => {
    // The marker and the PATH both arrived and the guard did not stop it. This
    // is a product failure, and it must never read as `fired`.
    expect(
      classify({ ledger: `${CALLED}\nDONE worker=${RUN}/1 exit=0 argv: run --plan whatever`, said: "accepted" }),
    ).toBe("reached-not-refused");
  });

  test("reached-not-refused — a CALL with no DONE at all is not a refusal", () => {
    // The shim writes CALL before it runs the binary and DONE after. A missing
    // DONE means nothing came back, and "nothing came back" is not exit 3.
    expect(classify({ ledger: CALLED, said: "refused" })).toBe("reached-not-refused");
  });

  test("marker-missing — the agent reached brigadier and the ledger has no identity for it", () => {
    // RULING 57 FALSIFIED, with a vendor's name attached: the PATH reached the
    // agent's tool shell and BRIGADIER_WORKER did not.
    expect(classify({ ledger: "", said: "refused" })).toBe("marker-missing");
    expect(classify({ ledger: "", said: "accepted" })).toBe("marker-missing");
  });

  test("marker-missing says what it means, in words a reader cannot skim past", () => {
    const reading = readGuard({
      itemId: "worker-a",
      number: 1,
      vendor: "gemini",
      runId: RUN,
      calls: [],
      dones: [],
      said: "refused",
    });
    expect(reading.state).toBe("marker-missing");
    expect(reading.detail).toContain("RULING 57'S UNMEASURED ASSUMPTION IS FALSIFIED ON GEMINI");
    expect(reading.detail).toContain("CANNOT FIRE ON THIS VENDOR AT ALL");
  });

  test("unreachable — the agent tried and could not resolve `brigadier`", () => {
    expect(classify({ ledger: "", said: "unreachable" })).toBe("unreachable");
  });

  test("never-tried — nothing in either channel", () => {
    expect(classify({ ledger: "", said: undefined })).toBe("never-tried");
  });

  test("an ordinal belonging to ANOTHER item is not this worker's evidence", () => {
    const ledger = `CALL worker=${RUN}/2 argv: run --plan whatever\nDONE worker=${RUN}/2 exit=3 argv: run --plan whatever`;
    expect(classify({ ledger, number: 1, said: undefined })).toBe("never-tried");
    expect(classify({ ledger, number: 2, said: undefined })).toBe("fired");
  });

  test("an item the record gave NO ordinal cannot be attributed at all", () => {
    // Called directly rather than through `classify`, whose `?? 1` default would
    // supply the very thing this test says is missing — the first draft of this
    // test did exactly that and reported `fired` for a worker with no identity.
    const reading = readGuard({
      itemId: "worker-a",
      number: undefined,
      vendor: "qwen",
      runId: RUN,
      calls: parseShim(`${CALLED}\nDONE worker=${RUN}/1 exit=3 argv: run`, "CALL"),
      dones: parseShim(`${CALLED}\nDONE worker=${RUN}/1 exit=3 argv: run`, "DONE"),
      said: undefined,
    });
    expect(reading.state).toBe("never-tried");
  });
});

describe("unattributable: the reassuring answer is NOT manufactured", () => {
  const broken = `CALL worker=${RUN}/x argv: run --plan whatever`;

  test("a marker whose tail is not an ordinal blocks rather than passing", () => {
    expect(classify({ ledger: `${broken}\nDONE worker=${RUN}/x exit=3 argv: run --plan whatever`, identityBroken: broken })).toBe(
      "unattributable",
    );
  });

  test("THE DEMONSTRATED NEGATIVE: two refused calls from ONE worker do not make a second worker `fired`", () => {
    // The exact input the dropped pigeonhole got wrong. Two refusals and two
    // workers satisfied "total calls >= worker count", so both workers were
    // reported `fired` — including the one that never tried, which is the
    // collapse of *the guard works* into *the guard never got the chance*.
    const ledger = [
      `CALL worker=${RUN}/x argv: run --plan whatever`,
      `DONE worker=${RUN}/x exit=3 argv: run --plan whatever`,
      `CALL worker=${RUN}/x argv: run --plan whatever`,
      `DONE worker=${RUN}/x exit=3 argv: run --plan whatever`,
    ].join("\n");
    for (const number of [1, 2]) {
      expect(classify({ ledger, number, identityBroken: broken, said: undefined })).toBe("unattributable");
    }
  });

  test("a broken identity elsewhere never overrides this worker's own evidence", () => {
    // `unattributable` is a fallback, not a veto: a worker whose own identity IS
    // in the ledger is still read from the ledger.
    const ledger = `${CALLED}\nDONE worker=${RUN}/1 exit=3 argv: run --plan whatever\n${broken}`;
    expect(classify({ ledger, number: 1, identityBroken: broken })).toBe("fired");
  });
});

describe("agentSaid: the agent's own account, per item", () => {
  const log = [
    "worker-a out {\"method\":\"session/prompt\"}",
    "worker-a in {\"params\":{\"update\":{\"content\":{\"text\":\"DELEGATION-REFUSED (exit 3: brigadier is already running)\"}}}}",
    "worker-b in {\"params\":{\"update\":{\"content\":{\"text\":\"DELEGATION-UNREACHABLE (could NOT spawn)\"}}}}",
    "worker-c in {\"params\":{\"update\":{\"content\":{\"text\":\"DELEGATION-ACCEPTED (exit 0)\"}}}}",
    "worker-d stopReason end_turn bytes 42",
  ].join("\n");

  test("it reads each outcome", () => {
    expect(agentSaid(log, "worker-a")).toBe("refused");
    expect(agentSaid(log, "worker-b")).toBe("unreachable");
    expect(agentSaid(log, "worker-c")).toBe("accepted");
  });

  test("an item that said nothing is undefined, not a guess", () => {
    expect(agentSaid(log, "worker-d")).toBeUndefined();
    expect(agentSaid("", "worker-a")).toBeUndefined();
  });

  test("it does not bleed across items whose ids share a prefix", () => {
    // `worker-a` and `worker-ab` are different items, and a `startsWith` on the
    // id alone would hand one item the other's verdict — which would attribute a
    // refusal to a vendor that never made one.
    const shared = 'worker-ab in {"text":"DELEGATION-REFUSED (exit 3)"}';
    expect(agentSaid(shared, "worker-a")).toBeUndefined();
    expect(agentSaid(shared, "worker-ab")).toBe("refused");
  });
});
