// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 29's third axis, and the two shapes ruling 40 measured it having.
 *
 * The controls that matter here are the ones that keep an honest report from
 * quietly becoming a flattering one:
 *
 *   THE CLAMP ONLY EVER GOES DOWN. Effort is the axis that most directly sets
 *   the bill, so an upward move is money the operator did not ask for. Checked
 *   exhaustively over the whole vocabulary rather than at the two interesting
 *   points.
 *
 *   CLAUDE'S TWO STATES NEVER RENDER AS FOUR. Ruling 40 MEASURED
 *   `MAX_THINKING_TOKENS` to be a switch — 0 gives no thinking block and 768
 *   median output tokens, 4000 gives 2744, 32000 gives 2836 — so printing
 *   `high` there would be naming a position on a dial that does not exist.
 *
 *   NOTHING SAYS CONFIRMED. #45 measured that neither vendor's setting is
 *   confirmable over the protocol; both had to be recovered from vendor-private
 *   on-disk records. Every rendering is checked for the word.
 */

import { describe, expect, test } from "bun:test";
import { PROFILES } from "../src/agent/profiles.ts";
import {
  CEILING,
  CLAUDE_THINKING_OFF,
  CLAUDE_THINKING_ON,
  EFFORT_ORDER,
  atMost,
  chooseEffortModel,
  deriveEffort,
  effortOf,
  leverFor,
  renderEffort,
  switchState,
  type EffortOutcome,
  type EffortRequest,
} from "../src/queue/effort.ts";
import { EFFORT_REQUEST_ID, gradedEffortChannel } from "../src/queue/spawn.ts";
import { validatePlan, type AgentOnLadder } from "../src/queue/plan.ts";
import type { LineChannel } from "../src/acp/channel.ts";

const AGENTS: AgentOnLadder[] = [
  { id: "codex", resolved: "/x/npx", capabilities: { commandExecution: true } },
];

describe("ruling 31: the plan may not set effort", () => {
  test("an item carrying `effort` is refused, and the refusal names the remedy", () => {
    const result = validatePlan(
      { version: 1, items: [{ id: "a", kind: "write", paths: ["a.txt"], prompt: "x", effort: "xhigh" }] },
      { cwd: process.cwd(), agents: AGENTS },
    );
    const text = result.refusals.flatMap((r) => r.lines).join("\n");
    expect(text).toContain("a plan may not");
    expect(text).toContain("difficulty");
    expect(text).toContain("--xhigh");
  });

  test("NEGATIVE CONTROL: the same item without `effort` is admitted", () => {
    const result = validatePlan(
      { version: 1, items: [{ id: "a", kind: "write", paths: ["a.txt"], prompt: "x", difficulty: "hard" }] },
      { cwd: process.cwd(), agents: AGENTS },
    );
    expect(result.refusals).toEqual([]);
  });
});

describe("ruling 31's derivation, and ruling 30's ceiling", () => {
  test("difficulty drives it, and a write item at `hard` gets the ceiling", () => {
    expect(deriveEffort("write", "easy")).toBe("low");
    expect(deriveEffort("write", "medium")).toBe("medium");
    expect(deriveEffort("write", "hard")).toBe("high");
  });

  test("an item that declares nothing gets the middle, not the top", () => {
    expect(deriveEffort("write", null)).toBe("medium");
  });

  test("a read-only item takes one step DOWN — its result is never diffed or merged", () => {
    expect(deriveEffort("read-only", "hard")).toBe("medium");
    expect(deriveEffort("read-only", "medium")).toBe("low");
    expect(deriveEffort("read-only", "easy")).toBe("low");
  });

  test("ruling 30: derivation can never reach xhigh on its own", () => {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      for (const kind of ["write", "read-only"] as const) {
        expect(deriveEffort(kind, difficulty)).not.toBe("xhigh");
      }
    }
    expect(CEILING).toBe("high");
  });

  test("NEGATIVE CONTROL: xhigh IS reachable when the operator declares it", () => {
    // Without this, "derivation never reaches xhigh" would also be satisfied by
    // a vocabulary in which xhigh is unreachable by anyone — and ruling 30
    // permits it as a declared edge case.
    expect(deriveEffort("write", "hard", "xhigh")).toBe("xhigh");
  });

  test("NEGATIVE CONTROL: --xhigh promotes nothing that had not already reached the ceiling", () => {
    // Otherwise the flag would be a way to set effort directly, which is what
    // ruling 31 takes away from the plan and did not hand to the command line.
    expect(deriveEffort("write", "easy", "xhigh")).toBe("low");
    expect(deriveEffort("write", "medium", "xhigh")).toBe("medium");
    expect(deriveEffort("read-only", "hard", "xhigh")).toBe("medium");
  });

  test("the clamp only ever goes DOWN, over the whole vocabulary", () => {
    for (const asked of EFFORT_ORDER) {
      for (const ceiling of EFFORT_ORDER) {
        const got = atMost(asked, ceiling);
        expect(EFFORT_ORDER.indexOf(got)).toBeLessThanOrEqual(EFFORT_ORDER.indexOf(asked));
        expect(EFFORT_ORDER.indexOf(got)).toBeLessThanOrEqual(EFFORT_ORDER.indexOf(ceiling));
      }
    }
  });

  test("`max` and `ultra` are not in the vocabulary at all (ruling 30)", () => {
    // Unreachable rather than filtered: a value that cannot be named cannot be
    // requested by a later edit that forgot why.
    expect(EFFORT_ORDER as readonly string[]).not.toContain("max");
    expect(EFFORT_ORDER as readonly string[]).not.toContain("ultra");
  });
});

describe("ruling 40: two shapes, and Claude's is a switch", () => {
  test("Claude's lever is MAX_THINKING_TOKENS with exactly two states", () => {
    const lever = leverFor(PROFILES.claude);
    expect(lever.kind).toBe("switch");
    expect(lever.kind === "switch" && lever.variable).toBe("MAX_THINKING_TOKENS");
    expect(lever.kind === "switch" && lever.on).toBe(CLAUDE_THINKING_ON);
    expect(lever.kind === "switch" && lever.off).toBe(CLAUDE_THINKING_OFF);
  });

  test("NEGATIVE CONTROL: Claude's two states never render as a four-state grade", () => {
    // The failure this guards: printing `high` on a lever MEASURED to be a
    // switch — 4000 → 2744 median output tokens against 32000 → 2836, an 8×
    // budget for 3% with fully overlapping ranges.
    const states = new Set(EFFORT_ORDER.map((request) => switchState(request)));
    expect([...states].sort()).toEqual(["thinking-off", "thinking-on"]);
    for (const request of EFFORT_ORDER) {
      expect(EFFORT_ORDER as readonly string[]).not.toContain(switchState(request));
    }
  });

  test("only `low` switches thinking off", () => {
    expect(switchState("low")).toBe("thinking-off");
    for (const request of ["medium", "high", "xhigh"] as const) {
      expect(switchState(request)).toBe("thinking-on");
    }
  });

  test("Codex's lever is graded, and every other vendor has none measured", () => {
    expect(leverFor(PROFILES.codex).kind).toBe("graded");
    for (const id of ["copilot", "qwen", "opencode", "gemini"] as const) {
      const lever = leverFor(PROFILES[id]);
      expect(lever.kind).toBe("none");
      // Absent is not zero, and it is not default-is-fine.
      expect(lever.kind === "none" && lever.why).toContain("nobody has measured");
    }
  });
});

describe("Codex: an effort-bearing id is READ, never constructed", () => {
  const listed = [
    "gpt-5.6-sol[low]",
    "gpt-5.6-sol[medium]",
    "gpt-5.6-sol[high]",
    "gpt-5.6-sol[max]",
    "gpt-5.6-sol",
  ];

  test("the suffix is what carries the effort", () => {
    expect(effortOf("gpt-5.6-sol[high]")).toBe("high");
    expect(effortOf("gpt-5.6-sol")).toBeNull();
  });

  test("it picks the highest id at or BELOW the request", () => {
    expect(chooseEffortModel(listed, "high")).toBe("gpt-5.6-sol[high]");
    expect(chooseEffortModel(listed, "medium")).toBe("gpt-5.6-sol[medium]");
    expect(chooseEffortModel(listed, "low")).toBe("gpt-5.6-sol[low]");
  });

  test("NEGATIVE CONTROL: it never picks one ABOVE the request", () => {
    // Overshooting is money the operator did not ask for — ruling 67's rule
    // about difficulty, on the axis that actually sets the bill.
    for (const request of EFFORT_ORDER) {
      const picked = chooseEffortModel(listed, request);
      if (picked === null) continue;
      const suffix = effortOf(picked) as EffortRequest;
      expect(EFFORT_ORDER.indexOf(suffix)).toBeLessThanOrEqual(EFFORT_ORDER.indexOf(request));
    }
  });

  test("NEGATIVE CONTROL: a `[max]` id is never chosen, at any request (ruling 30)", () => {
    for (const request of EFFORT_ORDER) expect(chooseEffortModel(listed, request)).not.toContain("[max]");
  });

  test("a list with no effort-bearing id yields null rather than a constructed one", () => {
    // Ruling 40 measured an invalid id failing -32603, so a guess is a failed
    // handshake rather than a slightly-wrong setting.
    expect(chooseEffortModel(["gpt-5.6-sol", "o4"], "high")).toBeNull();
    expect(chooseEffortModel([], "high")).toBeNull();
  });
});

// ------------------------------------------------------- the wire, in flight

function scriptedChannel(inbound: string[]): LineChannel & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: (line) => void sent.push(line),
    diagnostics: () => "",
    close: async () => {},
    async *lines() {
      for (const line of inbound) yield line;
    },
  };
}

const SESSION_NEW = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  result: {
    sessionId: "s1",
    models: { availableModels: [{ modelId: "gpt-5.6-sol[low]" }, { modelId: "gpt-5.6-sol[high]" }] },
  },
});

async function drain(channel: LineChannel): Promise<string[]> {
  const seen: string[] = [];
  for await (const line of channel.lines()) seen.push(line);
  return seen;
}

describe("the graded lever, asserted on the wire", () => {
  const outcomeOf = (): { current: EffortOutcome } => ({
    current: {
      requested: "high",
      asserted: "high",
      lever: "session/set_model",
      disposition: "unavailable",
      confirmed: false,
    },
  });

  test("session/set_model is sent once session/new is answered, with an id the agent listed", async () => {
    const inner = scriptedChannel([SESSION_NEW]);
    const state = outcomeOf();
    await drain(gradedEffortChannel(inner, "high", state));
    expect(inner.sent).toHaveLength(1);
    const frame = JSON.parse(inner.sent[0] as string) as { id: string; method: string; params: { modelId: string } };
    expect(frame.method).toBe("session/set_model");
    expect(frame.params.modelId).toBe("gpt-5.6-sol[high]");
    expect(state.current.disposition).toBe("sent");
  });

  test("the id is a STRING, so it cannot collide with Connection's numbered calls", async () => {
    const inner = scriptedChannel([SESSION_NEW]);
    await drain(gradedEffortChannel(inner, "high", outcomeOf()));
    const frame = JSON.parse(inner.sent[0] as string) as { id: unknown };
    expect(typeof frame.id).toBe("string");
    expect(frame.id).toBe(EFFORT_REQUEST_ID);
  });

  test("our own answer is swallowed; nothing above sees an id it did not issue", async () => {
    const answer = JSON.stringify({ jsonrpc: "2.0", id: EFFORT_REQUEST_ID, result: null });
    const inner = scriptedChannel([SESSION_NEW, answer, '{"jsonrpc":"2.0","id":3,"result":{}}']);
    const state = outcomeOf();
    const seen = await drain(gradedEffortChannel(inner, "high", state));
    expect(seen).toEqual([SESSION_NEW, '{"jsonrpc":"2.0","id":3,"result":{}}']);
    expect(state.current.disposition).toBe("accepted");
  });

  test("a refusal is recorded with the vendor's own message, not swallowed into a pass", async () => {
    const error = JSON.stringify({
      jsonrpc: "2.0",
      id: EFFORT_REQUEST_ID,
      error: { code: -32603, message: "unknown model id" },
    });
    const state = outcomeOf();
    await drain(gradedEffortChannel(scriptedChannel([SESSION_NEW, error]), "high", state));
    expect(state.current.disposition).toBe("rejected");
    expect(state.current.detail).toContain("unknown model id");
    expect(renderEffort(state.current)).toContain("REFUSED");
  });

  test("NEGATIVE CONTROL: an agent offering no effort-bearing id gets NO request sent", async () => {
    // Without this, "it sends set_model" would also be satisfied by a channel
    // that sends one unconditionally — with a constructed id, which ruling 40
    // measured failing -32603.
    const bare = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "s1", models: { availableModels: [{ modelId: "gpt-5.6-sol" }] } },
    });
    const inner = scriptedChannel([bare]);
    const state = outcomeOf();
    await drain(gradedEffortChannel(inner, "high", state));
    expect(inner.sent).toEqual([]);
    expect(state.current.disposition).toBe("unavailable");
    expect(state.current.detail).toContain("never constructed");
  });

  test("NEGATIVE CONTROL: nothing is sent before session/new is answered", async () => {
    const inner = scriptedChannel(['{"jsonrpc":"2.0","method":"session/update","params":{}}']);
    await drain(gradedEffortChannel(inner, "high", outcomeOf()));
    expect(inner.sent).toEqual([]);
  });
});

describe("#45: brigadier says what it SET, never what RAN", () => {
  const base: EffortOutcome = {
    requested: "high",
    asserted: "gpt-5.6-sol[high]",
    lever: "session/set_model",
    disposition: "sent",
    confirmed: false,
  };

  test("every rendering carries the qualifier INSIDE the value", () => {
    for (const disposition of ["set-at-spawn", "sent", "accepted"] as const) {
      const rendered = renderEffort({ ...base, disposition });
      expect(rendered).toMatch(/NOT confirmed/);
      expect(rendered).toContain("#45");
    }
  });

  test("NEGATIVE CONTROL: no rendering ever claims confirmation", () => {
    // The sentence this exists to make unwritable: `(codex, gpt-5.6-sol, high)`
    // read as the effort that ran.
    for (const disposition of ["set-at-spawn", "sent", "accepted", "rejected", "unavailable", "no-lever"] as const) {
      const rendered = renderEffort({ ...base, disposition });
      // The only permitted appearance of the word is the denial of it.
      const claims = rendered.match(/confirmed/gi) ?? [];
      const denials = rendered.match(/NOT confirmed/g) ?? [];
      expect(claims.length).toBe(denials.length);
      expect(rendered.toLowerCase()).not.toContain("effort that ran");
    }
  });

  test("`confirmed` is the literal false on every path", () => {
    expect(base.confirmed).toBe(false);
  });
});
