// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 63. The assertion that matters is that the second interrupt RE-RAISES:
 * `process.exit(130)` would pass a naive test and lie to whoever is above us.
 */

import { describe, expect, test } from "bun:test";
import {
  CANCEL_DEADLINE_MS,
  abandon,
  describeUnfinished,
  initialState,
  onSignal,
} from "../src/run/interrupt.ts";

describe("the interrupt state machine", () => {
  test("an interrupt before anything is in flight abandons immediately", () => {
    // v1's rule: there is nothing to clean up, and a handler that delays here
    // is pure downside.
    const state = onSignal(initialState(false), "SIGINT");
    expect(state.phase).toBe("abandoning");
  });

  test("the first interrupt in flight drains rather than abandoning", () => {
    const state = onSignal(initialState(true), "SIGINT");
    expect(state.phase).toBe("draining");
  });

  test("the SECOND interrupt abandons", () => {
    const first = onSignal(initialState(true), "SIGINT");
    const second = onSignal(first, "SIGINT");
    expect(second.phase).toBe("abandoning");
    expect(second.received).toEqual(["SIGINT", "SIGINT"]);
  });

  test("a different second signal also abandons", () => {
    // SIGTERM after SIGINT is someone escalating. It is not a fresh request.
    const second = onSignal(onSignal(initialState(true), "SIGINT"), "SIGTERM");
    expect(second.phase).toBe("abandoning");
  });
});

describe("abandoning re-raises rather than inventing an exit code", () => {
  test("the handler is removed and the SAME signal is re-raised", () => {
    const raised: NodeJS.Signals[] = [];
    abandon("SIGINT", (s) => raised.push(s));
    // Not 130. A re-raised signal produces a genuine signal-terminated status,
    // which a parent shell reports as such and a CI runner attributes
    // correctly. A hand-picked code only looks like one.
    expect(raised).toEqual(["SIGINT"]);
  });
});

describe("the cancel deadline is bounded, and bounded small", () => {
  test("it does not wait for an agent turn", () => {
    // #48 measured a real client tolerating a 285-second turn and holding a
    // permission open 195 s. `session/cancel` is an ACP notification with no
    // acknowledgement, so waiting for the agent is not a bounded wait.
    expect(CANCEL_DEADLINE_MS).toBeLessThan(285_000);
    expect(CANCEL_DEADLINE_MS).toBeGreaterThan(0);
  });
});

describe("the promise about an unfinished run is four facts and no reassurance", () => {
  const run = {
    landed: [1, 2],
    didNotLand: [3],
    retainedClones: [{ item: 3, path: "/Users/x/.brigadier/r/a1/3", bytes: 67 * 1024 ** 2 }],
    unconfirmedPids: [4242],
  };

  test("it says what landed, what did not, what is retained, and which pids", () => {
    const lines = describeUnfinished(run).join("\n");
    expect(lines).toContain("2 item(s) landed");
    expect(lines).toContain("1 did not");
    expect(lines).toContain("67 MB");
    expect(lines).toContain("/Users/x/.brigadier/r/a1/3");
    expect(lines).toContain("pid 4242");
  });

  test("retained clones are described as not merged and not reviewed", () => {
    // They are evidence, not work product. Ruling 52's slots block them.
    expect(describeUnfinished(run).join("\n")).toContain("not merged, not reviewed, not deleted");
  });

  test("a clean unfinished run still reports both counts", () => {
    const lines = describeUnfinished({
      landed: [],
      didNotLand: [],
      retainedClones: [],
      unconfirmedPids: [],
    }).join("\n");
    expect(lines).toContain("0 item(s) landed");
    expect(lines).toContain("none");
    // No pid line when there is nothing unconfirmed — silence here is honest,
    // because the absence of a hazard is not a hazard.
    expect(lines).not.toContain("could not confirm dead");
  });
});
