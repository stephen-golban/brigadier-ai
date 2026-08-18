// SPDX-License-Identifier: Apache-2.0
/**
 * Admission, the ladder and the fan-out — asserted on the SENTENCES, because
 * ruling 54's requirement is about what a reader can tell apart.
 *
 * "The report names which bound the count" is not satisfied by a report that
 * names it in a field nobody prints. The three cases must produce three
 * different sentences, so the test compares the sentences.
 */

import { describe, expect, test } from "bun:test";
import { PROFILES } from "../src/agent/profiles.ts";
import {
  admit,
  agentsOnPath,
  bindingSentence,
  describeAdmission,
  describeRefusals,
  ladderFor,
  LEGALITY_UNBOUNDED,
  rungsAvailable,
  type ResolvedAgent,
} from "../src/queue/admit.ts";
import { BRIEF_PREFIX, composeBrief } from "../src/queue/brief.ts";
import { activeLevers, ceilingRefusal, estimatePlan, itemCeilingReserve, NO_SAVINGS_CLAIM } from "../src/queue/estimate.ts";
import { ambientSuppression } from "../src/queue/execute.ts";
import { validatePlan, type PlannedItem } from "../src/queue/plan.ts";
import { planFanOut } from "../src/work/fanout.ts";

function agent(id: keyof typeof PROFILES): ResolvedAgent {
  const profile = PROFILES[id];
  return { id, profile, resolved: `/x/${profile.command}`, bridged: profile.bridged, capabilities: profile.capabilities };
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "write",
  paths: [`${id}.txt`],
  prompt: `write ${id}.txt`,
  ...extra,
});

function planOf(items: unknown[], agents: ResolvedAgent[]) {
  return validatePlan({ version: 1, items }, { cwd: process.cwd(), agents });
}

describe("agents are found by resolving PATH, and by nothing else (ruling 46)", () => {
  test("every profile whose command resolves is reported with the ENTRY that was found", () => {
    const found = agentsOnPath((command) => (command === "qwen" ? "/planted/bin/qwen" : null));
    expect(found.map((a) => a.id)).toEqual(["qwen"]);
    expect(found[0]?.resolved).toBe("/planted/bin/qwen");
  });

  test("NEGATIVE CONTROL: nothing on PATH means no agent, not a default one", () => {
    // v1 inferred installation from a marker file and reported an agent present
    // on a machine where it was not on PATH.
    expect(agentsOnPath(() => null)).toEqual([]);
  });

  test("ruling 69: an overridden bridge is the coordinate that is RESOLVED", () => {
    // The staleness ruling 69 exists to catch is a table describing one
    // coordinate while another one runs. `brigadier agents` applies the
    // override; so must the thing that spawns.
    const found = agentsOnPath(
      (command) => (command === "/opt/fixed-codex-acp" ? "/opt/fixed-codex-acp" : null),
      [{ agent: "codex", command: "/opt/fixed-codex-acp", args: ["--acp"] }],
    );
    expect(found.map((a) => a.id)).toEqual(["codex"]);
    expect(found[0]?.profile.command).toBe("/opt/fixed-codex-acp");
    expect(found[0]?.profile.args).toEqual(["--acp"]);
  });

  test("NEGATIVE CONTROL: with no override the shipped coordinate is what resolves", () => {
    // Without this, the assertion above would also pass on a resolver that
    // ignored the profile entirely and echoed whatever it was handed.
    const found = agentsOnPath((command) => (command === "/opt/fixed-codex-acp" ? "/opt/fixed-codex-acp" : null), []);
    expect(found).toEqual([]);
  });

  test("a bridged profile resolves as its LAUNCHER, and says so", () => {
    const found = agentsOnPath((command) => (command === "npx" ? "/usr/bin/npx" : null));
    expect(found.every((a) => a.bridged)).toBe(true);
    expect(found.map((a) => a.id).sort()).toEqual(["claude", "codex"]);
  });
});

describe("ruling 55: a MISSING rung never renders as an EXHAUSTED one", () => {
  test("one vendor with no model list is a SHORT ladder, and the line says so", () => {
    const outcome = ladderFor([agent("qwen")]);
    expect(outcome.kind).toBe("short");
  });

  test("NEGATIVE CONTROL: two vendors produce a full ladder with no 'no second rung'", () => {
    const outcome = ladderFor([agent("qwen"), agent("gemini")]);
    expect(outcome.kind).toBe("completed");
  });

  test("a single vendor whose profile DOES return models still has a second rung", () => {
    // The control on the control: "short" above must be about the ladder rather
    // than about the count of vendors alone.
    expect(rungsAvailable([agent("codex")])).toContain("same-vendor-different-model");
    expect(ladderFor([agent("codex")]).kind).toBe("completed");
  });

  test("an empty ladder is short and says there is no FIRST rung either", () => {
    const outcome = ladderFor([]);
    expect(outcome.kind === "short" && outcome.reason).toContain("no first rung");
  });
});

describe("ruling 54: three filters, three different sentences", () => {
  const bound = (over: Parameters<typeof planFanOut>[0]) => bindingSentence(planFanOut(over), 1);

  test("the plan had one item, desirability capped it and RAM capped it read differently", () => {
    const itemCount = bound({ itemCount: 1, legalityCap: LEGALITY_UNBOUNDED, hostFirst: false, totalMemoryBytes: 64 * 1024 ** 3 });
    const desirability = bound({ itemCount: 9, legalityCap: LEGALITY_UNBOUNDED, hostFirst: false, totalMemoryBytes: 64 * 1024 ** 3 });
    const ram = bound({ itemCount: 9, legalityCap: LEGALITY_UNBOUNDED, hostFirst: true, totalMemoryBytes: 10 * 1024 ** 3 });

    expect(itemCount).toContain("the plan had 1 item(s) here");
    expect(desirability).toContain("desirability capped it");
    expect(ram).toContain("RAM capped it");
    expect(new Set([itemCount, desirability, ram]).size).toBe(3);
  });

  test("NEGATIVE CONTROL: the one-item sentence does NOT blame RAM or the budget", () => {
    // Three different reasons to run one worker rendering as one sentence is
    // exactly what ruling 54 forbids.
    const itemCount = bound({ itemCount: 1, legalityCap: LEGALITY_UNBOUNDED, hostFirst: false, totalMemoryBytes: 64 * 1024 ** 3 });
    expect(itemCount).not.toContain("RAM");
    expect(itemCount).not.toContain("desirability");
  });

  test("the RAM sentence names totalmem() and refuses to claim load-awareness", () => {
    const ram = bound({ itemCount: 9, legalityCap: LEGALITY_UNBOUNDED, hostFirst: true, totalMemoryBytes: 10 * 1024 ** 3 });
    expect(ram).toContain("totalmem()");
    expect(ram).toContain("does not schedule against current load");
  });
});

describe("admission refuses a machine with no rung, and says what to do", () => {
  test("zero agents is a refusal naming the bridge launcher trap", () => {
    const admission = admit({ plan: planOf([item("a")], []), agents: [], hostFirst: true });
    const text = describeRefusals(admission.refusals, "p.json").join("\n");
    expect(text).toContain("no agent resolved on PATH");
    expect(text).toContain("npx");
    expect(text).toContain("brigadier detect");
    // Ruling 53: nothing was created, and the refusal says so in the first lines.
    expect(text).toContain("zero processes, zero clones, zero refs");
  });

  test("NEGATIVE CONTROL: one agent is admitted, and the admission names the ladder", () => {
    const agents = [agent("qwen")];
    const admission = admit({ plan: planOf([item("a")], agents), agents, hostFirst: true });
    expect(admission.refusals).toEqual([]);
    const text = describeAdmission(admission, "p.json").join("\n");
    expect(text).toContain("admitted");
    expect(text).toContain("ladder");
    expect(text).toContain("no second rung");
    // Ruling 55: a one-vendor machine must not be described as having two rungs.
    expect(text).not.toMatch(/2 rungs/i);
  });

  test("the admission prints ruling 67's clamp per item", () => {
    const agents = [agent("qwen")];
    const admission = admit({ plan: planOf([item("a", { difficulty: "hard" })], agents), agents, hostFirst: true });
    expect(describeAdmission(admission, "p.json").join("\n")).toContain("difficulty: hard (clamped to medium)");
  });

  test("NEGATIVE CONTROL: an item declaring nothing prints no clamp at all", () => {
    const agents = [agent("qwen")];
    const admission = admit({ plan: planOf([item("a")], agents), agents, hostFirst: true });
    expect(describeAdmission(admission, "p.json").join("\n")).not.toContain("clamped to");
  });
});

describe("ruling 16 and 21: the brief's prefix is byte-stable", () => {
  const planned = (id: string, prompt: string): PlannedItem => ({
    number: 1,
    id,
    kind: "write",
    paths: ["a.txt"],
    prompt,
    dependsOn: [],
    requires: [],
    verify: { status: "unconfigured", argv: [], resolved: null, refusal: null },
    difficulty: null,
    clampedTo: null,
  });

  test("two different items share every byte of the prefix", () => {
    const one = composeBrief(planned("a", "do one thing"));
    const two = composeBrief(planned("b", "do another thing"));
    expect(one.startsWith(BRIEF_PREFIX)).toBe(true);
    expect(two.startsWith(BRIEF_PREFIX)).toBe(true);
    expect(one).not.toBe(two);
  });

  test("NEGATIVE CONTROL: the prefix carries no run id, path or timestamp", () => {
    // A varying token inside the stable prefix destroys the property the prefix
    // exists for, and it would be invisible in the test above.
    expect(BRIEF_PREFIX).not.toMatch(/\d{6,}/);
    expect(BRIEF_PREFIX).not.toContain("/");
  });

  test("the brief tells the worker why delegating will fail, before it tries (finding 114)", () => {
    expect(BRIEF_PREFIX).toContain("Do not delegate");
    expect(BRIEF_PREFIX).toContain("COMMIT IT");
  });
});

describe("ruling 66 and 70: a range, its provenance, and no savings claim", () => {
  const planned = (n: number): PlannedItem[] =>
    Array.from({ length: n }, (_, index) => ({
      number: index + 1,
      id: `i${index}`,
      kind: "write" as const,
      paths: [`i${index}.txt`],
      prompt: "x",
      dependsOn: [],
      requires: [],
      verify: { status: "unconfigured" as const, argv: [], resolved: null, refusal: null },
      difficulty: null,
      clampedTo: null,
    }));

  test("the estimate is an interval whose width is measured, not hedged", () => {
    const estimate = estimatePlan(planned(4), 3);
    expect(estimate.high).toBeGreaterThan(estimate.low);
    expect(estimate.provenance).toContain("#44");
    expect(estimate.provenance).toContain("#23");
  });

  test("NEGATIVE CONTROL: it is not a single number wearing an interval", () => {
    const estimate = estimatePlan(planned(1), 1);
    expect(estimate.high).not.toBe(estimate.low);
  });

  test("opencode makes the total a LOWER BOUND (#42)", () => {
    expect(estimatePlan(planned(1), 1, ["opencode"]).lowerBound).toBe(true);
  });

  test("NEGATIVE CONTROL: a run without opencode is not marked a lower bound for that reason", () => {
    expect(estimatePlan(planned(1), 1, ["qwen"]).lowerBound).toBe(false);
  });

  test("no lever is stated as a quantity anyone could read as a saving (ruling 70)", () => {
    const claim = /\b(saved|savings|reduced (?:cost|spend|tokens) by)\b/i;
    for (const lever of activeLevers(planned(2), 2)) expect(lever).not.toMatch(claim);
    // And the disclaimer carries the word a skimmer scans for on its OWN line,
    // because a footnote is not in the same block.
    expect(NO_SAVINGS_CLAIM).toMatch(claim);
    expect(NO_SAVINGS_CLAIM).toMatch(/makes no claim/i);
  });
});

// -------------------------------- decision 17, per vendor rather than blanket

/**
 * The record's `ambientSuppressed` used to be a constant sentence claiming the
 * config root was redirected *"for every worker"*.
 *
 * MEASURED against this tree on 2026-08-18: the redirect IS
 * `LaunchProfile.configRootEnv`, and two shipped profiles declare none — so on a
 * machine where one of those is the drivable vendor the run suppressed nothing
 * and recorded that it had. A claim that is true on some machines and false on
 * others, written as a constant, is the same failure as a check that reports
 * success for something that did not happen.
 */
describe("decision 17: the suppression claim names the vendors it is true of", () => {
  test("a vendor WITH a config-root variable is named with the variable", () => {
    const lines = ambientSuppression([agent("qwen")]).join("\n");
    expect(lines).toContain("qwen (QWEN_HOME)");
    expect(lines).not.toContain("NO config-root redirect");
  });

  test("a vendor WITHOUT one is named as NOT suppressed, rather than covered by a blanket claim", () => {
    // The negative control, and the reason this function exists: on this fleet
    // the two answers are both reachable, and the old constant gave the first
    // answer for both.
    const bare = PROFILES["copilot"].configRootEnv;
    expect(bare).toBeUndefined();
    const lines = ambientSuppression([agent("copilot")]).join("\n");
    expect(lines).toContain("NO config-root redirect exists for copilot");
    expect(lines).toContain("still readable by them");
    expect(lines).not.toContain("copilot (");
  });

  test("a mixed fleet says both halves, and the worker marker is claimed for all of them", () => {
    const lines = ambientSuppression([agent("qwen"), agent("copilot")]).join("\n");
    expect(lines).toContain("qwen (QWEN_HOME)");
    expect(lines).toContain("NO config-root redirect exists for copilot");
    // Ruling 57's marker is the one lever that really is universal, so it is the
    // one sentence allowed to say so.
    expect(lines).toContain("inert inside every worker");
  });
});

// ------------------------------- ruling 66's two answers about a ceiling pair

describe("ruling 66: an incoherent pair is refused and a narrow one is not", () => {
  test("a hard ceiling at or below the soft one is REFUSED", () => {
    const verdict = ceilingRefusal(1000, 1000, 1);
    expect(verdict?.refuse).toBe(true);
    expect(verdict?.lines.join(" ")).toContain("can never act first");
  });

  test("a narrow gap is a WEAKENING, not a refusal", () => {
    // The repair. Refusing here left the operator with no run, no record, no
    // report and no blocking check — a run that "integrated nothing" and named
    // nothing, which is the shape ruling 52 exists to make unreachable.
    const verdict = ceilingRefusal(1000, 1001, 1);
    expect(verdict?.refuse).toBe(false);
    expect(verdict?.lines.join(" ")).toContain("WEAKENED SOFT CEILING");
    expect(verdict?.lines.join(" ")).toContain("The run PROCEEDS");
  });

  test("NEGATIVE CONTROL: a wide gap says nothing at all", () => {
    expect(ceilingRefusal(1000, 1000 + itemCeilingReserve() * 2, 1)).toBeNull();
    // And one ceiling on its own is not a pair, so the rule does not apply.
    expect(ceilingRefusal(undefined, 1000, 1)).toBeNull();
    expect(ceilingRefusal(1000, undefined, 1)).toBeNull();
  });

  test("the reserve scales with the workers that can be in flight", () => {
    // Ruling 66's arithmetic: with W concurrent workers, W items are still
    // running when the soft ceiling trips.
    const oneWorker = ceilingRefusal(1000, 1000 + itemCeilingReserve() + 1, 1);
    const threeWorkers = ceilingRefusal(1000, 1000 + itemCeilingReserve() + 1, 3);
    expect(oneWorker).toBeNull();
    expect(threeWorkers?.refuse).toBe(false);
    expect(threeWorkers?.lines.join(" ")).toContain("WEAKENED SOFT CEILING");
  });
});
