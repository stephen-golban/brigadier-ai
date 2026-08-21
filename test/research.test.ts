// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 78's `research` kind, decision D22's dated-finding rule, and ruling
 * 84's decision about where a research turn runs.
 *
 * The rule under test is a SHAPE check and is asserted as one. D22's accepted
 * cost is written into the ruling — *"a worker that fabricates a date passes"* —
 * so a test that claimed to verify freshness would be claiming something the
 * mechanism does not do. What it does verify is that a finding CARRIES a date,
 * that the date is the one brigadier named rather than the one the model's
 * training reaches for, and that every source line carries a date of its own.
 *
 * Every acceptance below has its refusal beside it.
 */

import { describe, expect, test } from "bun:test";
import {
  AS_OF,
  FindingUnusable,
  RESEARCH_RULES,
  findingForPlanner,
  looksLikeItNeedsResearch,
  requireDatedFinding,
  researchBrief,
  todayStamp,
} from "../src/plan/research.ts";
import { chooseResearcher } from "../src/plan/commission.ts";
import { deriveEffort } from "../src/queue/effort.ts";
import { ALL_WORK_KINDS, KIND_CONTRACT, PLANNABLE_KINDS, lanePolicyFor } from "../src/work/kind.ts";
import { PROFILES, laneModeFor, reachesWeb } from "../src/agent/profiles.ts";
import { parsePlan, validatePlan } from "../src/queue/plan.ts";

const TODAY = "2026-08-21";

/** The shape the brief asks for, and the shape the checker accepts. */
const GOOD = [
  "FINDING:",
  "Bun's current release is 1.4.0.",
  "",
  "SOURCES:",
  "- https://bun.com/blog/bun-v1.4 — 2026-08-20",
  "",
  `${AS_OF} ${TODAY}`,
].join("\n");

describe("D22: a finding must say when it was taken", () => {
  test("a well-formed finding is accepted, and its date and sources come back", () => {
    const finding = requireDatedFinding(GOOD, TODAY, "claude");
    expect(finding.asOf).toBe(TODAY);
    expect(finding.sources).toHaveLength(1);
    expect(finding.sources[0]).toContain("2026-08-20");
  });

  test("no `AS OF` line at all is REFUSED", () => {
    const undated = GOOD.split("\n").filter((line) => !line.startsWith(AS_OF)).join("\n");
    expect(() => requireDatedFinding(undated, TODAY, "claude")).toThrow(FindingUnusable);
    try {
      requireDatedFinding(undated, TODAY, "claude");
    } catch (error) {
      expect((error as FindingUnusable).message).toContain("does not say when it was taken");
      // The raw text travels with the refusal, or an operator is told only that
      // something was wrong with an answer they cannot see.
      expect((error as FindingUnusable).received).toContain("Bun's current release");
    }
  });

  test("A DATE FROM THE MODEL'S TRAINING is refused, which is the whole point of the kind", () => {
    const stale = GOOD.replace(`${AS_OF} ${TODAY}`, `${AS_OF} 2024-06-01`);
    expect(() => requireDatedFinding(stale, TODAY, "claude")).toThrow(/dated 2024-06-01 and this run is 2026-08-21/);
  });

  test("a date in the wrong FORMAT is refused rather than guessed at", () => {
    const loose = GOOD.replace(`${AS_OF} ${TODAY}`, `${AS_OF} 21 August 2026`);
    expect(() => requireDatedFinding(loose, TODAY, "claude")).toThrow(/carries no YYYY-MM-DD date/);
  });

  test("no sources is refused: a finding nobody else can check is not a finding", () => {
    const sourceless = [`FINDING:`, "Bun's current release is 1.4.0.", "", `${AS_OF} ${TODAY}`].join("\n");
    expect(() => requireDatedFinding(sourceless, TODAY, "claude")).toThrow(/no `SOURCES:` lines/);
  });

  test("an UNDATED source line is refused, and saying `undated` is how a worker complies honestly", () => {
    const bare = GOOD.replace("- https://bun.com/blog/bun-v1.4 — 2026-08-20", "- https://bun.com/blog/bun-v1.4");
    expect(() => requireDatedFinding(bare, TODAY, "claude")).toThrow(/carry no date and do not say `undated`/);

    const admitted = GOOD.replace("- https://bun.com/blog/bun-v1.4 — 2026-08-20", "- https://bun.com/blog/bun-v1.4 — undated");
    expect(requireDatedFinding(admitted, TODAY, "claude").sources).toHaveLength(1);
  });

  test("an empty answer is refused as an empty answer, not as an undated one", () => {
    expect(() => requireDatedFinding("   \n  ", TODAY, "claude")).toThrow(/returned nothing at all/);
  });

  test("it REFUSES rather than repairing: nothing here stamps a date on somebody else's claim", () => {
    const undated = GOOD.split("\n").filter((line) => !line.startsWith(AS_OF)).join("\n");
    let repaired: unknown;
    try {
      repaired = requireDatedFinding(undated, TODAY, "claude");
    } catch {
      repaired = undefined;
    }
    // The negative control for the tempting fix. A stamp applied here would be
    // brigadier's date on a worker's claim, and the record would show a dated
    // finding that nobody dated (ruling 52's shape).
    expect(repaired).toBeUndefined();
  });
});

describe("the brief tells the worker what the checker requires", () => {
  test("it names today's date, and names it as the value for the AS OF line", () => {
    const brief = researchBrief({ question: "what is the latest bun?", today: TODAY, repoName: "r" });
    expect(brief).toContain(`Today's date is ${TODAY}`);
    expect(brief).toContain(`Use exactly that on the ${AS_OF} line`);
  });

  test("the stable rules are the PREFIX, which is ruling 21's 16.5x cache lever", () => {
    const brief = researchBrief({ question: "q", today: TODAY, repoName: "r" });
    expect(brief.startsWith(RESEARCH_RULES)).toBe(true);
    // And the varying part is after it, rather than interleaved.
    expect(brief.indexOf("q")).toBeGreaterThan(RESEARCH_RULES.length);
  });

  test("it tells the worker to use the tool rather than its memory", () => {
    expect(RESEARCH_RULES).toContain("Do not answer from memory");
    // And what to do when the tool fails, because a guess dressed as a finding
    // is the failure this kind exists to prevent.
    expect(RESEARCH_RULES).toContain("A failed search reported plainly is a useful answer");
  });

  test("the planner is told the finding wins over its instincts, and when it was taken", () => {
    const block = findingForPlanner(requireDatedFinding(GOOD, TODAY, "claude"));
    expect(block).toContain(`taken on ${TODAY}`);
    expect(block).toContain("it wins");
    expect(block).toContain("Bun's current release is 1.4.0.");
  });
});

describe("D3: research is not forced", () => {
  test("a goal that turns on something current suggests it", () => {
    expect(looksLikeItNeedsResearch("upgrade to the latest release of bun")).toBe(true);
    expect(looksLikeItNeedsResearch("migrate off the deprecated api")).toBe(true);
  });

  test("a goal that does not, does not — the negative control", () => {
    expect(looksLikeItNeedsResearch("rename the helper in src/util.ts")).toBe(false);
    expect(looksLikeItNeedsResearch("fix the typo in the readme")).toBe(false);
  });

  test("today is the operator's local today, zero-padded", () => {
    expect(todayStamp(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    // Local rather than UTC: a run at 23:00 dated tomorrow reads as a
    // fabrication to the only person who can check it.
    expect(todayStamp(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });
});

describe("ruling 78's column decides who may research, before anything spends", () => {
  test("a fleet with a measured vendor gets one", () => {
    const chosen = chooseResearcher(["claude", "codex"], undefined);
    expect(chosen).toEqual({ agent: "claude" });
    expect(reachesWeb("claude")).toBe(true);
  });

  test("the operator's configured order is honoured within the eligible set", () => {
    // opencode is measured too, so a configured preference for it is real
    // rather than a preference over an ineligible vendor.
    expect(chooseResearcher(["claude", "opencode"], ["opencode"])).toEqual({ agent: "opencode" });
    // And a configured vendor that may NOT research does not win by being named.
    expect(chooseResearcher(["claude", "codex"], ["codex"])).toEqual({ agent: "claude" });
  });

  test("a fleet with none returns each vendor's OWN reason, and the two reasons differ", () => {
    const chosen = chooseResearcher(["codex", "qwen"], undefined);
    expect("refusals" in chosen).toBe(true);
    const refusals = ("refusals" in chosen ? chosen.refusals : []).join("\n");
    // Ruling 53: `unmeasured` needs somebody to run a probe; `unsupported`
    // needs a different vendor. Collapsing them sends half the operators to the
    // wrong remedy.
    expect(refusals).toContain("UNMEASURED");
    expect(refusals).not.toContain("unsupported");
    expect(reachesWeb("codex")).toBeUndefined();
  });
});

describe("ruling 78's contract answers every field for the two new kinds", () => {
  test("every kind answers every field — that is what the constant is for", () => {
    const fields = Object.keys(KIND_CONTRACT.write);
    for (const kind of ALL_WORK_KINDS) {
      for (const field of fields) {
        expect(KIND_CONTRACT[kind]).toHaveProperty(field);
        expect(KIND_CONTRACT[kind][field as keyof (typeof KIND_CONTRACT)["write"]]).toBeDefined();
      }
    }
    expect(ALL_WORK_KINDS).toEqual(["write", "read-only", "plan", "research"]);
  });

  test("`product` is what separates the three read-only-shaped kinds", () => {
    expect(KIND_CONTRACT["read-only"].product).toBe("text");
    expect(KIND_CONTRACT.plan.product).toBe("plan-json");
    expect(KIND_CONTRACT.research.product).toBe("dated-finding");
    // And the directory does NOT separate them, which is why `product` exists.
    for (const kind of ["read-only", "plan", "research"] as const) {
      expect(KIND_CONTRACT[kind].isolation).toBe("pooled");
      expect(KIND_CONTRACT[kind].mergesBack).toBe(false);
      expect(KIND_CONTRACT[kind].mayInstallDependencies).toBe(false);
      expect(lanePolicyFor(kind)).toBe("deny");
    }
  });

  test("only `research` requires web reach", () => {
    expect(KIND_CONTRACT.research.requiresWebReach).toBe(true);
    for (const kind of ["write", "read-only", "plan"] as const) {
      expect(KIND_CONTRACT[kind].requiresWebReach).toBe(false);
    }
  });

  test("THE VENDOR MODE: a plan or research worker gets the read-only mode, not the write one", () => {
    // The bug this guard exists for: `laneModeFor` compared `kind ===
    // "read-only"` and fell through to the WRITE mode for anything else. On
    // Codex that is `agent`, which permits writing inside the clone — so two
    // new kinds would have silently arrived with a builder's sandbox.
    const codex = PROFILES.codex.laneAssertion;
    expect(laneModeFor(codex, "write")).toBe("agent");
    for (const kind of ["read-only", "plan", "research"] as const) {
      expect(laneModeFor(codex, kind)).toBe("read-only");
      expect(laneModeFor(codex, kind)).not.toBe("agent");
    }
  });
});

describe("ruling 79's rows for the kinds brigadier commissions", () => {
  test("plan and research take the middle, whatever difficulty says", () => {
    for (const kind of ["plan", "research"] as const) {
      expect(deriveEffort(kind, null)).toBe("medium");
      // There IS no model-supplied difficulty for these kinds; a caller that
      // invents one must not be able to move the effort with it.
      expect(deriveEffort(kind, "hard")).toBe("medium");
      expect(deriveEffort(kind, "easy")).toBe("medium");
    }
  });

  test("they are NOT stepped down the way read-only is, and read-only still is", () => {
    // Ruling 79's own reason for the step: nothing downstream can check that a
    // costlier read-only attempt was worth paying for. A plan is validated and
    // executed and a finding is checked and carried, so the premise does not
    // hold for either.
    expect(deriveEffort("read-only", "hard")).toBe("medium");
    expect(deriveEffort("plan", "hard")).toBe("medium");
    expect(deriveEffort("write", "hard")).toBe("high");
  });

  test("the operator's ceiling still clamps them", () => {
    expect(deriveEffort("plan", null, "low")).toBe("low");
  });
});

describe("ruling 84: a plan may not declare the kinds brigadier commissions", () => {
  const validate = (text: string) => validatePlan(parsePlan(text, "/p.json"), { cwd: "/repo", agents: [] });
  const plan = (kind: string) =>
    JSON.stringify({
      version: 1,
      items: [{ id: "a", kind, paths: ["src/a.ts"], prompt: "do the thing" }],
    });

  test("`research` in a submitted plan is refused BY NAME, and told where research happens", () => {
    const parsed = validate(plan("research"));
    const refusals = parsed.refusals.flatMap((refusal) => refusal.lines).join("\n");
    expect(refusals).toContain("which a plan may not declare (ruling 84)");
    expect(refusals).toContain("--goal");
    expect(parsed.items).toHaveLength(0);
  });

  test("`plan` in a submitted plan is refused too — a planner asking for a planner", () => {
    const refusals = validate(plan("plan")).refusals.flatMap((r) => r.lines).join("\n");
    expect(refusals).toContain("which a plan may not declare (ruling 84)");
  });

  test("the two kinds a plan MAY declare still parse — the control", () => {
    for (const kind of PLANNABLE_KINDS) {
      const parsed = validate(plan(kind));
      expect(parsed.refusals).toEqual([]);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]?.kind).toBe(kind);
    }
  });

  test("an unknown kind still names all four, so a reader learns the vocabulary", () => {
    const refusals = validate(plan("sideways")).refusals.flatMap((r) => r.lines).join("\n");
    expect(refusals).toContain("write, read-only, plan, research");
  });
});
