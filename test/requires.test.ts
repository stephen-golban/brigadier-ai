// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 53, with v1's findings 70, 71 and 87 written down as tests.
 *
 * The rule under test that is easiest to get wrong: `undefined` is not `false`
 * and is not `true`. Unmeasured is not permission, and it needs its own remedy
 * text — "unmeasured on this agent" rather than "unsupported".
 */

import { describe, expect, test } from "bun:test";
import { PROFILES } from "../src/agent/profiles.ts";
import {
  ALL_REQUIREMENTS,
  REQUIREMENT_SOURCE,
  eligibleFor,
  satisfies,
} from "../src/work/requires.ts";

describe("unmeasured is not permission", () => {
  test("three states, not two", () => {
    expect(satisfies({ commandExecution: true }, "commandExecution")).toBe("satisfied");
    expect(satisfies({ commandExecution: false }, "commandExecution")).toBe("unsupported");
    expect(satisfies({}, "commandExecution")).toBe("unmeasured");
  });

  test("an unmeasured capability does not make an agent eligible", () => {
    // Qwen: #50 measured that it never issues a permission request at all, so
    // nothing about command execution has been observed either way.
    const { eligible, reasons } = eligibleFor(PROFILES.qwen.capabilities, ["commandExecution"]);
    expect(eligible).toBe(false);
    expect(reasons[0]!.satisfaction).toBe("unmeasured");
    // And it must be distinguishable from "unsupported" — different remedy.
    expect(reasons[0]!.satisfaction).not.toBe("unsupported");
  });
});

describe("the vocabulary is three terms and no term lives in two places", () => {
  test("exactly three", () => {
    expect(ALL_REQUIREMENTS).toHaveLength(3);
  });

  test("imageInput comes from the handshake and is never in the profile table", () => {
    expect(REQUIREMENT_SOURCE.imageInput).toBe("handshake");
    for (const profile of Object.values(PROFILES)) {
      expect(profile.capabilities).not.toHaveProperty("imageInput");
    }
  });

  test("the two brigadier-defined terms come from the profile", () => {
    expect(REQUIREMENT_SOURCE.commandExecution).toBe("profile");
    expect(REQUIREMENT_SOURCE.networkAccess).toBe("profile");
  });
});

describe("findings 70, 71 and 87", () => {
  test("70/71: an item requiring commands does not route to an unmeasured agent", () => {
    // Finding 71: a command-requiring item re-routed to a worker that could not
    // run `bun install`, produced an empty diff, and burned both attempts.
    const eligible = Object.values(PROFILES).filter(
      (p) => eligibleFor(p.capabilities, ["commandExecution"]).eligible,
    );
    expect(eligible.map((p) => p.id).sort()).toEqual(["claude", "codex", "copilot", "opencode"]);
  });

  test("Codex has commands and NO network in the same session", () => {
    // #41 measured ruling 49's `write` mode (`agent`) blocking all network at
    // the OS level. This is findings 70/71's asymmetry, still alive, and now
    // brigadier's own doing rather than the vendor's default.
    expect(satisfies(PROFILES.codex.capabilities, "commandExecution")).toBe("satisfied");
    expect(satisfies(PROFILES.codex.capabilities, "networkAccess")).toBe("unsupported");
    expect(eligibleFor(PROFILES.codex.capabilities, ["commandExecution", "networkAccess"]).eligible)
      .toBe(false);
  });

  test("87: the refusal names which term failed on which agent, not a count", () => {
    // v1 said `ROUTING_FAILED — 11 model(s) were eliminated`, which is
    // arithmetic. A remedy says what to fix.
    const { reasons } = eligibleFor(PROFILES.codex.capabilities, [
      "commandExecution",
      "networkAccess",
    ]);
    expect(reasons).toEqual([
      { requirement: "commandExecution", satisfaction: "satisfied" },
      { requirement: "networkAccess", satisfaction: "unsupported" },
    ]);
  });

  test("no requirements means every agent is eligible", () => {
    // Positive control: the filter can also let things through.
    for (const profile of Object.values(PROFILES)) {
      expect(eligibleFor(profile.capabilities, []).eligible).toBe(true);
    }
  });
});
