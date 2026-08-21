// SPDX-License-Identifier: Apache-2.0
/**
 * The planner: what brigadier asks a workhorse for when it is given a goal
 * instead of a plan.
 *
 * Ruling 74, which overturns ruling 20's *consequence* and keeps ruling 20's
 * text. This is the module where that distinction becomes code, so it is worth
 * being exact about it:
 *
 *   **The orchestrator still holds no context window.** Nothing in brigadier
 *   accumulates a conversation, prunes it, compacts it or counts its tokens
 *   before dispatch. What changed is that one of the things brigadier can ask a
 *   worker to produce is *a plan*, and a plan is a file. Ruling 20's advice —
 *   that published LLM-harness context management does not apply to a pipe —
 *   applies to this module exactly as it always did.
 *
 * The consequence being overturned is the one nobody wrote down: that brigadier
 * therefore takes a plan rather than making one. `src/work/kind.ts` had two
 * kinds and `run` had one entry point, `--plan <path>`, pointing at a file
 * somebody else had already authored — in practice the host model, instructed to
 * do it by the shipped `SKILL.md`.
 *
 * WHAT THE PLANNER IS GIVEN, and why it is not more. Ruling 16 settles this and
 * it is not negotiable here: **identifiers up front, contents just-in-time.** The
 * planner gets the goal, the repository's own map (ruling 39's ~2K budget), and
 * the rules its output must satisfy. It does NOT get file contents; it has the
 * repository on disk and its own tools, which is the same hybrid strategy
 * Anthropic documents and the same one Claude Code itself uses.
 *
 * WHAT COMES BACK IS DATA, NOT TRUST. The planner's output is fed to
 * `parsePlan`, then `validatePlan`, both unchanged — so ruling 11's *"the host
 * model drafts, brigadier validates against measured reality"* becomes *"a
 * planner drafts, brigadier validates"*, and **the validator does not care who
 * authored it.** That is the property that makes ruling 74 cheap: no new
 * validation, no new refusal path, no second standard for a plan brigadier
 * commissioned versus one it was handed. Ruling 14's legality filter, ruling
 * 53's requirement checks and ruling 67's difficulty clamp all fire on a
 * planner's plan exactly as they fire on anyone else's.
 */

import type { AgentId } from "../agent/profiles.ts";

/**
 * Everything the brief says that does not depend on the goal.
 *
 * Kept as one constant, and kept BEFORE the varying part at every call site,
 * because ruling 21 measured a **16.5×** cache lever on a byte-stable prefix and
 * ruling 16 makes the worker brief byte-identical across agents on purpose. A
 * planner brief that interleaved the goal with the rules would spend that lever
 * for nothing.
 */
export const PLANNER_RULES = `You are brigadier's planner. You produce a PLAN and you do not do the work.

Return ONE JSON object and nothing else. No prose before it, no prose after it. A fenced
\`\`\`json block is accepted; anything else is refused.

The shape:

  {
    "version": 1,
    "items": [
      {
        "id": "short-stable-slug",
        "kind": "write" | "read-only",
        "paths": ["src/a.ts", "src/b.ts"],
        "prompt": "what this worker must do, in full, as if it has read nothing else",
        "dependsOn": ["id-of-another-item"],
        "difficulty": "easy" | "medium" | "hard"
      }
    ]
  }

The rules your plan must satisfy, each of which is checked and will refuse your plan:

  1. NO TWO ITEMS MAY CLAIM THE SAME PATH. This is the legality filter and it is absolute.
     Two items that need the same file are ONE item. Over-claiming paths shrinks your own
     fan-out and buys you nothing.
  2. Every path is repository-relative and must be a path an item actually writes to.
     \`paths\` is an ownership claim, not a list of things to read.
  3. \`prompt\` is the WHOLE brief for a worker that has seen nothing else — not a title, not
     a reference to another item, not "as above". Each worker runs alone, in its own clone,
     with no memory of this plan.
  4. You MAY NOT set \`effort\`. It is derived from (kind, difficulty) and a plan that sets it
     is refused by name. Declaring \`difficulty\` honestly is how you influence it; inflating
     it is measured against this repository's own history and clamped down, loudly.
  5. \`kind\` is "write" when the item changes files and "read-only" when its only output is
     text. A "read-only" item is never diffed, never merged and never read back.
  6. \`dependsOn\` is a wave boundary, not a channel. A dependent item starts after its
     dependency lands; it cannot see that item's working directory.

Prefer FEWER, LARGER items over many small ones. Every item is a separate agent with a
separate context and a separate bill, and coordination between them is not free. An item
that is one edit to one file is usually not worth being an item.

If the goal cannot be decomposed into independent items — because it is one change, or because
everything touches the same file — say so by returning a single item.
That is a correct plan, not a failure.`;

/** What the planner is asked about, on top of the rules. */
export interface PlannerRequest {
  readonly goal: string;
  /** Ruling 39's repo map, or empty when one could not be built. */
  readonly repoMap: string;
  /** Repository-relative, for the planner's own orientation. */
  readonly repoName: string;
}

/**
 * The full brief: stable rules first, then the varying part.
 *
 * Order is the point. See `PLANNER_RULES`.
 */
export function plannerBrief(request: PlannerRequest): string {
  const parts = [PLANNER_RULES, "", `Repository: ${request.repoName}`];
  if (request.repoMap.trim().length > 0) {
    parts.push("", "A map of this repository, by identifier. It is a starting point and not a", "guarantee — read what you need:", "", request.repoMap);
  }
  parts.push("", "THE GOAL:", "", request.goal, "", "Return the JSON object now.");
  return parts.join("\n");
}

/** A planner's answer that cannot be used, with what was actually received. */
export class PlannerUnusable extends Error {
  constructor(
    readonly agent: AgentId | string,
    why: string,
    /** The raw text, so a person can see what the model actually said. */
    readonly received: string,
  ) {
    super(`the planner (${agent}) did not return a usable plan: ${why}`);
    this.name = "PlannerUnusable";
  }
}

/**
 * The JSON object in a planner's reply, extracted from whatever it wrapped it in.
 *
 * Models fence JSON, prefix it with a sentence, and follow it with an offer to
 * explain — that is not misbehaviour, it is how they are trained, and a parser
 * that demanded a bare object would refuse most correct plans. So this finds the
 * object rather than insisting the whole reply be one.
 *
 * **It refuses loudly rather than salvaging.** If there is no object, or the
 * object does not parse, the caller gets the raw text back in the error: a
 * planner that returned prose is a fact the operator needs to see, and a
 * "helpful" partial extraction would hand `validatePlan` a plan nobody wrote.
 *
 * The scan is deliberately crude — first `{` to last `}` — because the
 * alternative is a JSON tokeniser, and the failure it would prevent (a reply
 * containing two JSON objects) is one where refusing is the right answer anyway.
 */
export function extractPlanJson(text: string, agent: AgentId | string): string {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const open = candidate.indexOf("{");
  const close = candidate.lastIndexOf("}");
  if (open === -1 || close <= open) {
    throw new PlannerUnusable(agent, "there is no JSON object in the reply", text);
  }
  const body = candidate.slice(open, close + 1);
  try {
    JSON.parse(body);
  } catch (error) {
    throw new PlannerUnusable(agent, `the JSON did not parse — ${(error as Error).message}`, text);
  }
  return body;
}

/**
 * Does this goal plausibly need a plan at all?
 *
 * D3: *"Planning and research are not forced. Work that needs neither gets
 * neither."* A typo fix does not get a planning turn.
 *
 * **This is a heuristic and it is named as one everywhere it is used.** There is
 * no measurement behind it and there cannot easily be one: whether a sentence
 * describes one edit or ten is a judgement about a codebase nobody has looked at
 * yet. It exists so the common cheap case is cheap, and it only ever suggests —
 * D3 says brigadier **asks the user anyway**, so the answer to this question is
 * a default in a question, never a decision taken silently.
 */
export function looksTrivial(goal: string): boolean {
  const words = goal.trim().split(/\s+/).length;
  if (words > 12) return false;
  return /\b(typo|rename|bump|comment|whitespace|format|lint|spelling)\b/i.test(goal);
}
