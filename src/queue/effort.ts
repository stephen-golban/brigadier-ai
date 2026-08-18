// SPDX-License-Identifier: Apache-2.0
/**
 * Effort: the third member of ruling 29's triple, derived rather than requested.
 *
 * Ruling 31 is the whole of why this module exists and why it takes no input
 * from the plan: **effort is derived from (kind, difficulty), and a plan may not
 * set it.** A model choosing how hard it gets to think about its own task is a
 * self-serving input, and effort is the axis that most directly sets the bill.
 * So `validatePlan` REFUSES a plan item carrying an `effort` field, and the only
 * escape hatch is the operator's own command line.
 *
 * Ruling 30 puts a hard ceiling at `high` across every vendor. `xhigh` exists
 * only as an explicitly declared edge case — declared by the OPERATOR, never by
 * the plan — and `max` and `ultra` are never requested at all. That last part is
 * enforced by the vocabulary rather than by a check: `EffortRequest` has no such
 * members, so there is no value to filter out.
 *
 * Ruling 40 is the reason this is not one table. Effort is a GRADED axis on
 * Codex and a BINARY one on Claude, and the measurements are not close:
 *
 *   Codex     `session/set_model` genuinely moves the backend, `session/new`
 *             returns 33 effort-bearing model ids (`gpt-5.6-sol[high]`), the
 *             agent's own `turn_context` records the effort as set, and an
 *             invalid id fails `-32603`. Four grades are real.
 *
 *   Claude    the only lever is `MAX_THINKING_TOKENS`, and it is A SWITCH, NOT
 *             A DIAL: 0 gives no thinking block and 768 median output tokens,
 *             4000 gives 2744, 32000 gives 2836 — an 8× budget for a 3% change
 *             with fully overlapping ranges at n=5. So the derivation has TWO
 *             outputs there, and rendering four would be describing a dial that
 *             does not exist. Ruling 30's `high` ceiling is vacuous on Claude
 *             rather than violated.
 *
 * THE LIMIT THIS MODULE REFUSES TO PAPER OVER (#45, and `BAR.md` item 13 says
 * it in the same words): **neither vendor's effort setting is confirmable over
 * the protocol.** Both had to be recovered from vendor-private on-disk records.
 * So every value here is labelled with what brigadier DID — set it in the
 * environment, sent it on the wire, was told the id was accepted — and
 * `confirmed` is the literal `false`, with no code path that can make it
 * anything else. "The effort we asked for is the effort that ran" is asserted
 * from vendor-private records or not at all, and brigadier does not have them.
 */

import type { LaunchProfile } from "../agent/profiles.ts";
import type { WorkKind } from "../work/kind.ts";
import type { Difficulty } from "./plan.ts";

/**
 * The vocabulary. Deliberately four members and deliberately not six.
 *
 * `max` and `ultra` are absent rather than filtered: ruling 30 says never, and a
 * value that cannot be named cannot be requested by a later edit that forgot
 * why. `xhigh` is present because ruling 30 permits it as a declared edge case,
 * and `CEILING` below is what keeps it from being reachable by derivation.
 */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;
export type EffortRequest = (typeof EFFORT_ORDER)[number];

/** Ruling 30. Hard, across every vendor. Raised for one item only by the operator. */
export const CEILING: EffortRequest = "high";

/**
 * Ruling 31's derivation, and the two facts it is derived from.
 *
 * The difficulty half is the obvious one. The KIND half is not, and it is the
 * half ruling 49 supplies: a `read-only` item's directory is never diffed,
 * merged or read back, so nothing downstream can check that a more expensive
 * attempt was worth paying for. Spending a higher grade there buys an answer
 * nobody can verify, so read-only takes one step down — which is a clamp, and
 * therefore goes the only direction ruling 67 allows.
 */
export function deriveEffort(
  kind: WorkKind,
  difficulty: Difficulty | null,
  ceiling: EffortRequest = CEILING,
): EffortRequest {
  const base: Record<Difficulty, EffortRequest> = { easy: "low", medium: "medium", hard: "high" };
  // An item that declares nothing gets the middle, which is the same default
  // `plan.ts` clamps difficulty to. One default, stated in two places, would be
  // two defaults the day one of them moves — so this reads the same word.
  const asked = base[difficulty ?? "medium"];
  const stepped = kind === "read-only" ? stepDown(asked) : asked;
  // Ruling 30's declared edge case, and the reason it is not simply "the
  // operator's number wins": the declaration applies ONLY where the derivation
  // had already reached the standing ceiling. `--xhigh` on an easy item, or on
  // a read-only one, promotes nothing — otherwise the flag would be a way to
  // set effort directly, which is exactly what ruling 31 takes away from the
  // plan and did not hand to the command line.
  const declared = ceiling === "xhigh" && stepped === CEILING ? "xhigh" : stepped;
  return atMost(declared, ceiling);
}

function stepDown(effort: EffortRequest): EffortRequest {
  const index = EFFORT_ORDER.indexOf(effort);
  return EFFORT_ORDER[Math.max(0, index - 1)] ?? effort;
}

/** `Math.min` on the index, which is the whole enforcement of ruling 30. */
export function atMost(effort: EffortRequest, ceiling: EffortRequest): EffortRequest {
  const index = Math.min(EFFORT_ORDER.indexOf(effort), EFFORT_ORDER.indexOf(ceiling));
  return EFFORT_ORDER[index] ?? effort;
}

/**
 * How a vendor's effort lever is shaped, and therefore what may be said about
 * it.
 *
 * `graded` and `switch` are not two renderings of one thing. A switch has two
 * states and printing four of them is a claim about a dial that was MEASURED not
 * to exist (ruling 40), so the two kinds carry different vocabularies all the
 * way to the record.
 */
export type EffortLever =
  /** Codex: an effort-bearing model id, sent with `session/set_model`. */
  | { kind: "graded"; method: "session/set_model" }
  /** Claude: `MAX_THINKING_TOKENS` at spawn. Two states, never four. */
  | { kind: "switch"; variable: "MAX_THINKING_TOKENS"; on: string; off: string }
  /** Every other measured vendor: nothing. Absent is not zero. */
  | { kind: "none"; why: string };

/**
 * MEASURED against `claude 2.1.233` through bridge 0.69.0, recorded in ruling
 * 40 on 2026-08-17: `MAX_THINKING_TOKENS=0` produced no thinking block and a
 * 768-token median output; `4000` produced 2744; `32000` produced 2836. The
 * on-state is therefore 4000 rather than the largest number available — an 8×
 * budget bought 3%, so paying it would be spending the operator's money for a
 * difference inside the noise.
 */
export const CLAUDE_THINKING_ON = "4000";
export const CLAUDE_THINKING_OFF = "0";

export function leverFor(profile: LaunchProfile): EffortLever {
  if (profile.id === "codex") return { kind: "graded", method: "session/set_model" };
  if (profile.id === "claude") {
    return {
      kind: "switch",
      variable: "MAX_THINKING_TOKENS",
      on: CLAUDE_THINKING_ON,
      off: CLAUDE_THINKING_OFF,
    };
  }
  return {
    kind: "none",
    why:
      `no effort lever has been measured on ${profile.id}. Absent is not zero and it is not ` +
      "default-is-fine: nobody has measured whether this vendor has one, so brigadier asserts " +
      "nothing and says so rather than printing a grade it did not set.",
  };
}

/**
 * The two states a switch has. Ruling 40, and the reason this returns a state
 * name rather than a grade: `high` on a two-state lever is a word for something
 * that does not exist.
 */
export function switchState(request: EffortRequest): "thinking-on" | "thinking-off" {
  return request === "low" ? "thinking-off" : "thinking-on";
}

/** The effort a Codex model id encodes, or null when it encodes none. */
export function effortOf(modelId: string): string | null {
  const match = /\[([^\]]+)\]\s*$/.exec(modelId);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Pick an effort-bearing model id at or below the request.
 *
 * READ, NEVER CONSTRUCTED — the Codex profile's own caveat, and ruling 40
 * measured that an invalid id fails `-32603`. So this only ever returns a string
 * the agent itself supplied.
 *
 * At or BELOW, never above: overshooting spends money the operator did not ask
 * for, which is ruling 67's rule about difficulty applied to the axis that
 * actually sets the bill. A `[max]` or `[ultra]` id is unreachable here because
 * it is not in `EFFORT_ORDER` at all, so there is nothing to filter and nothing
 * to forget to filter.
 */
export function chooseEffortModel(models: readonly string[], request: EffortRequest): string | null {
  const wanted = EFFORT_ORDER.indexOf(request);
  let best: { id: string; index: number } | null = null;
  for (const id of models) {
    const suffix = effortOf(id);
    if (suffix === null) continue;
    const index = EFFORT_ORDER.indexOf(suffix as EffortRequest);
    if (index === -1 || index > wanted) continue;
    if (best === null || index > best.index) best = { id, index };
  }
  return best?.id ?? null;
}

/**
 * What brigadier DID about effort, and what it therefore may say.
 *
 * `confirmed` is typed as the literal `false`. #45 measured that neither
 * vendor's setting is confirmable over the protocol — both had to be recovered
 * from vendor-private on-disk records — so a `true` here would be a claim
 * brigadier has no way to earn, and the type is what makes it unwritable rather
 * than merely unwritten.
 */
export type EffortDisposition =
  /** Put in the spawn environment. It was there when the process started. */
  | "set-at-spawn"
  /** Sent on the wire. No answer had arrived when the item was recorded. */
  | "sent"
  /** Sent, and the agent answered that the id was accepted. Still not what RAN. */
  | "accepted"
  /** Sent, and the agent refused it. The vendor's own message is carried. */
  | "rejected"
  /** The vendor offered nothing to set it with. */
  | "unavailable"
  /** No lever has been measured on this vendor at all. */
  | "no-lever";

export interface EffortOutcome {
  /** Ruling 31's derivation. Never from the plan. */
  requested: EffortRequest;
  /** In the vendor's own vocabulary: a grade, a switch state, or `default`. */
  asserted: string;
  lever: string;
  disposition: EffortDisposition;
  /** #45. There is no code path that sets this to anything else. */
  confirmed: false;
  /** The vendor's own words on a rejection, or the reason nothing was asserted. */
  detail?: string;
}

/**
 * The short form that goes inside the triple.
 *
 * The qualifier lives INSIDE the string, which is ruling 52's rendering rule
 * borrowed one axis over: a reader who skims `(codex, gpt-5.6-sol, high)` would
 * take it as what ran, and it is not. Every rendering below says what brigadier
 * did, and none of them can be read as confirmation.
 */
export function renderEffort(outcome: EffortOutcome): string {
  switch (outcome.disposition) {
    case "set-at-spawn":
    case "sent":
      return `${outcome.asserted} (set, NOT confirmed — #45)`;
    case "accepted":
      return `${outcome.asserted} (set and the id was accepted, NOT confirmed — #45)`;
    case "rejected":
      return `${outcome.asserted} REFUSED by the agent — ${outcome.detail ?? "no message"}`;
    case "unavailable":
      return `${outcome.requested} not asserted — the agent offered no effort-bearing model id`;
    case "no-lever":
      return `${outcome.requested} not asserted — no effort lever is measured on this vendor`;
  }
}

/** The outcome for a vendor with no measured lever. Written once, so it reads the same everywhere. */
export function noLever(requested: EffortRequest, lever: EffortLever & { kind: "none" }): EffortOutcome {
  return {
    requested,
    asserted: "default",
    lever: "none measured",
    disposition: "no-lever",
    confirmed: false,
    detail: lever.why,
  };
}
