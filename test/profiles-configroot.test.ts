// SPDX-License-Identifier: Apache-2.0
//
// Decision 17 suppresses user-global ambient instruction files by redirecting
// each vendor's config root at spawn. That only works where the vendor HAS a
// config-root lever, and ruling 57 classifies the coverage: present on some
// vendors, absent on Gemini, and Copilot recorded as UNESTABLISHED.
//
// BAR item 9 caught the consequence live: a Copilot worker wrote
// `ambient-obeyed.txt`, i.e. it genuinely obeyed an ambient file, because its
// profile declared no lever and so nothing was redirected.
import { describe, expect, test } from "bun:test";
import { ALL_AGENT_IDS, PROFILES, buildEnvironment } from "../src/agent/profiles.ts";

const REDIRECT = "/tmp/scratch-config-root";

describe("decision 17's redirect holds only where a vendor has a lever", () => {
  // MEASURED against `copilot 1.0.80` on 2026-08-18: an ACP `initialize` under
  // a redirected COPILOT_HOME wrote config.json and logs/ into that directory;
  // the negative control with the variable unset wrote nothing there.
  test("copilot's config root is COPILOT_HOME, and the redirect reaches the spawn", () => {
    expect(PROFILES.copilot.configRootEnv).toBe("COPILOT_HOME");
    const env = buildEnvironment(PROFILES.copilot, { configRoot: REDIRECT });
    expect(env.COPILOT_HOME).toBe(REDIRECT);
  });

  // The demonstrated negative. #42 measured Gemini's GEMINI_DIR as an internal
  // constant with ZERO env reads, so there is no lever to set and decision 17
  // cannot hold there. This asserts the ABSENCE reaches the environment as an
  // absence -- not as some default that would look like suppression.
  test("NEGATIVE CONTROL: gemini has no lever, so nothing is redirected", () => {
    expect(PROFILES.gemini.configRootEnv).toBeUndefined();
    const env = buildEnvironment(PROFILES.gemini, { configRoot: REDIRECT });
    for (const value of Object.values(env)) expect(value).not.toBe(REDIRECT);
  });

  // A drift guard. If a vendor gains or loses a lever, ambient suppression
  // silently changes scope on that vendor -- exactly the failure item 9 found.
  // Keeping the split explicit makes such a change a visible edit here.
  test("the lever exists on 5 of 6 vendors, and gemini is the one without", () => {
    const withLever = ALL_AGENT_IDS.filter((id) => PROFILES[id].configRootEnv !== undefined);
    const without = ALL_AGENT_IDS.filter((id) => PROFILES[id].configRootEnv === undefined);
    expect(withLever.length).toBe(5);
    expect(without).toEqual(["gemini"]);
  });
});
