// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 57. The universal half of making brigadier's plugin inert.
 *
 * These tests cover only what is testable in-process: the predicate and the
 * fact that the marker is put on every worker's environment. What they
 * deliberately do NOT prove is that the marker reaches the shell an agent runs
 * commands in — that is unmeasured, is the assumption the whole mechanism rests
 * on, and belongs to BAR item 9, which drives a real worker and asserts on the
 * effect. Asserting a variable exists proves only that a variable exists.
 */

import { describe, expect, test } from "bun:test";
import { PROFILES, buildEnvironment } from "../src/agent/profiles.ts";
import { RUN_MARKER_FLAG, WORKER_MARKER, isInsideWorker } from "../src/agent/marker.ts";

describe("the worker marker", () => {
  test("is set on every profile's environment", () => {
    for (const profile of Object.values(PROFILES)) {
      expect(buildEnvironment(profile)[WORKER_MARKER]).toBe("1");
    }
  });

  test("the predicate reads set, unset and explicitly-off", () => {
    expect(isInsideWorker({ [WORKER_MARKER]: "1" })).toBe(true);
    expect(isInsideWorker({})).toBe(false);
    // "0" and "" are off — a marker that treats any value as truthy would fire
    // for someone who exported it to turn it OFF.
    expect(isInsideWorker({ [WORKER_MARKER]: "0" })).toBe(false);
    expect(isInsideWorker({ [WORKER_MARKER]: "" })).toBe(false);
  });
});

describe("two markers, not one", () => {
  test("they are different strings for different consumers", () => {
    // Ruling 57: an env var is invisible to ruling 38's sweep scanning `ps`
    // output, and a command-line marker is invisible to a binary checking
    // process.env. Neither substitutes for the other.
    expect(WORKER_MARKER).not.toBe(RUN_MARKER_FLAG);
  });

  test("the run marker is a command-line flag, never a name pattern", () => {
    // Ruling 38 is explicit about this: the sweep matches the command line, and
    // matching a process NAME would reclaim someone else's `node`.
    expect(RUN_MARKER_FLAG.startsWith("--")).toBe(true);
  });
});
