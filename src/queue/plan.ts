// SPDX-License-Identifier: Apache-2.0
/**
 * The plan, and everything that is decided about it before anything is spent.
 *
 * This module is the composition point for four separate "find out before you
 * spend" rulings, and they are together here rather than scattered because the
 * property that matters is a JOINT one: **a refused plan creates no process and
 * no clone**. A refusal computed halfway through cloning is not a refusal, it is
 * an apology.
 *
 *   ruling 13   two `write` items may not claim the same path. Disjoint
 *               ownership is what makes N concurrent workers legal at all, and
 *               it is a property of the plan text — checkable with no agent,
 *               no clone and no repository.
 *   ruling 52   the verify command's executable is resolved on `PATH`, in the
 *               environment the checker will run in, before a single worker
 *               exists (`src/gate/verify.ts`).
 *   ruling 53   eligibility is computed over the WHOLE ladder at validation,
 *               and the refusal names a remedy rather than arithmetic — and
 *               says whether the agent CANNOT or whether NOBODY HAS MEASURED
 *               IT, because those need different fixes.
 *   ruling 54   a `dependsOn` cycle is rejected at validation, never discovered
 *               during execution, where the symptom is a run that stops early
 *               with nothing to say.
 *
 * Ruling 67 also lands here, and it is the one rule in this file that is not a
 * refusal: `difficulty` clamps DOWN, loudly, and never up. An upward clamp
 * spends money the operator did not ask for, so there is deliberately no code
 * path that can produce one — `clampDifficulty` takes a minimum of two indices
 * and the report prints `difficulty: hard (clamped to medium)` per item.
 *
 * WHAT IS DELIBERATELY NOT HERE: the repository is never consulted for a verify
 * command. Ruling 37 says capability comes from the human, and a committed
 * `brigadier.json` is supplied by whoever wrote the repository — which, for a
 * cloned one, is not the operator. brigadier runs the command the OPERATOR
 * handed it in the plan on the command line, and nothing else. That is why a
 * hostile committed command never runs: not because it is filtered, but because
 * nothing ever reads it.
 */

import { ALL_REQUIREMENTS, satisfies, type Capabilities, type Requirement } from "../work/requires.ts";
import { ALL_WORK_KINDS, type WorkKind } from "../work/kind.ts";
import { CyclicPlan, UnusablePlan, planWaves, type WaveItem } from "../integrate/waves.ts";
import { resolveVerify, type VerifyResolution } from "../gate/verify.ts";

export const DIFFICULTY_ORDER = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTY_ORDER)[number];

/**
 * The ceiling an unqualified run allows.
 *
 * Ruling 67 says the clamp only ever goes down, which means something has to
 * say where the top is. It is `medium` rather than `hard` because the direction
 * of the error is asymmetric in exactly the way ruling 67 describes: a plan
 * clamped down costs the operator a weaker attempt they can see and re-run,
 * and a plan clamped up costs them money they did not agree to. The operator
 * raises it explicitly.
 */
export const DEFAULT_DIFFICULTY_CEILING: Difficulty = "medium";

/** One item as the plan file writes it. Every field but `id` and `prompt` is optional. */
export interface PlanItemSpec {
  id?: unknown;
  kind?: unknown;
  paths?: unknown;
  prompt?: unknown;
  dependsOn?: unknown;
  verify?: unknown;
  requires?: unknown;
  difficulty?: unknown;
}

export interface PlanSpec {
  version?: unknown;
  items?: unknown;
}

/** One item after validation. Every field is settled; nothing here is still a guess. */
export interface PlannedItem {
  /** 1-based and positional. This is the clone's directory name and the marker's item. */
  number: number;
  id: string;
  kind: WorkKind;
  paths: readonly string[];
  prompt: string;
  /** Item NUMBERS, resolved from the plan's ids. */
  dependsOn: readonly number[];
  requires: readonly string[];
  verify: VerifyResolution;
  /** What the plan asked for, or null when it asked for nothing. */
  difficulty: Difficulty | null;
  /** What it will actually get. Never above `difficulty` — ruling 67. */
  clampedTo: Difficulty | null;
}

/**
 * One reason a plan is refused, with the ruling it comes from and the remedy.
 *
 * A list rather than a first-failure, because an operator who fixes one problem
 * and is then told about the next has been made to run the same refusal three
 * times to learn three facts that were all known at once.
 */
export interface PlanRefusal {
  ruling: string;
  /** The remedy, in the operator's terms. Never a count of what was excluded. */
  lines: string[];
}

export interface AgentOnLadder {
  id: string;
  /** Where it resolved. Ruling 46: the entry that was found, never the name assumed. */
  resolved: string;
  capabilities: Capabilities;
}

export interface ValidationInput {
  /** Where a relative verify path is resolved from: the operator's repository. */
  cwd: string;
  /** Every rung this machine offers. Ruling 53 asks the WHOLE ladder, not the first rung. */
  agents: readonly AgentOnLadder[];
  ceiling?: Difficulty;
}

export interface ValidatedPlan {
  items: PlannedItem[];
  /** Ruling 54's wave order, by item number. Empty when the plan was refused. */
  waves: number[][];
  refusals: PlanRefusal[];
}

export class PlanUnreadable extends Error {
  constructor(source: string, why: string) {
    super(`${source} is not a usable plan: ${why}`);
    this.name = "PlanUnreadable";
  }
}

/** Parse without trusting. Every shape error names the field and the file. */
export function parsePlan(text: string, source: string): PlanSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PlanUnreadable(source, `it is not valid JSON — ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PlanUnreadable(source, "the top level must be a JSON object with an `items` array");
  }
  const spec = parsed as PlanSpec;
  if (!Array.isArray(spec.items)) {
    throw new PlanUnreadable(source, "`items` is missing or is not an array");
  }
  return spec;
}

/** Ruling 67, and the only direction it can go. `Math.min` is the whole enforcement. */
export function clampDifficulty(asked: Difficulty, ceiling: Difficulty): Difficulty {
  const index = Math.min(DIFFICULTY_ORDER.indexOf(asked), DIFFICULTY_ORDER.indexOf(ceiling));
  return DIFFICULTY_ORDER[index] ?? asked;
}

function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" && (DIFFICULTY_ORDER as readonly string[]).includes(value);
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === "string" && entry.length > 0)) return null;
  return value as string[];
}

/**
 * Ruling 53, per requirement, over the whole ladder.
 *
 * The two failing answers are kept apart all the way to the sentence, because
 * "this agent cannot" and "nobody has measured it" send an operator to two
 * different places: the first to a different agent, the second to a
 * measurement. v1's `ROUTING_FAILED — 11 model(s) were eliminated` collapsed
 * both into a number, which sends them nowhere.
 */
export function requirementRefusal(
  itemId: string,
  requirement: string,
  agents: readonly AgentOnLadder[],
): string[] {
  const known = (ALL_REQUIREMENTS as readonly string[]).includes(requirement);
  if (!known) {
    return [
      `item ${itemId} requires \`${requirement}\`, and nobody has measured it.`,
      `  brigadier's requirement vocabulary is exactly ${ALL_REQUIREMENTS.join(", ")} (ruling 53),`,
      `  and \`${requirement}\` is not in it — so this is not an agent that cannot, it is a term`,
      "  that has never been measured on any agent. Remedy: measure it and add it to the",
      "  vocabulary with its source, or drop it from the plan. An unmeasured term is not",
      "  permission and brigadier will not treat it as one.",
    ];
  }
  const term = requirement as Requirement;
  const verdicts = agents.map((agent) => ({ agent, verdict: satisfies(agent.capabilities, term) }));
  const unable = verdicts.filter((v) => v.verdict === "unsupported").map((v) => v.agent.id);
  const unmeasured = verdicts.filter((v) => v.verdict === "unmeasured").map((v) => v.agent.id);
  const lines = [`item ${itemId} requires \`${term}\`, and no rung of this run's ladder provides it.`];
  if (unable.length > 0) {
    lines.push(
      `  ${unable.join(", ")}: measured and CANNOT. Remedy: route this item to an agent that can,`,
      "  or drop the requirement if the item does not really need it.",
    );
  }
  if (unmeasured.length > 0) {
    lines.push(
      `  ${unmeasured.join(", ")}: UNMEASURED — nobody has measured \`${term}\` on it. That is a`,
      "  different problem from the agent being unable, and it needs a different fix: measure it",
      "  and record it in that agent's launch profile. Unmeasured is not permission.",
    );
  }
  if (agents.length === 0) {
    lines.push(
      "  no agent resolved on this machine at all, so nothing has been measured either way.",
    );
  }
  return lines;
}

/**
 * Validate a plan against this machine.
 *
 * Every check that can be made from the plan text alone is made first, so that
 * a plan with a typo in it does not need a machine with an agent on it to hear
 * about the typo.
 */
export function validatePlan(spec: PlanSpec, input: ValidationInput): ValidatedPlan {
  const refusals: PlanRefusal[] = [];
  const ceiling = input.ceiling ?? DEFAULT_DIFFICULTY_CEILING;
  const raw = (spec.items ?? []) as PlanItemSpec[];

  // ---- shape --------------------------------------------------------------
  const shape: string[] = [];
  if (spec.version !== undefined && spec.version !== 1) {
    shape.push(`\`version\` is ${JSON.stringify(spec.version)}; this brigadier reads version 1 plans.`);
  }
  if (raw.length === 0) shape.push("the plan has no items, so there is nothing to run.");

  const seen = new Set<string>();
  const items: PlannedItem[] = [];
  raw.forEach((entry, index) => {
    const position = index + 1;
    const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : "";
    if (id === "") {
      shape.push(`item at position ${position} has no \`id\`; every item needs one to be reported.`);
      return;
    }
    if (seen.has(id)) {
      shape.push(`two items share the id \`${id}\`; ids are how a report names an item.`);
      return;
    }
    seen.add(id);
    if (typeof entry.prompt !== "string" || entry.prompt.length === 0) {
      shape.push(`item ${id} has no \`prompt\`; there is nothing to ask a worker to do.`);
      return;
    }
    const kind = entry.kind === undefined ? "write" : entry.kind;
    if (typeof kind !== "string" || !(ALL_WORK_KINDS as readonly string[]).includes(kind)) {
      shape.push(
        `item ${id} has kind ${JSON.stringify(entry.kind)}; the kinds are ${ALL_WORK_KINDS.join(" and ")} (ruling 49).`,
      );
      return;
    }
    const paths = stringList(entry.paths);
    if (paths === null) {
      shape.push(`item ${id}'s \`paths\` must be an array of non-empty strings.`);
      return;
    }
    const requires = stringList(entry.requires);
    if (requires === null) {
      shape.push(`item ${id}'s \`requires\` must be an array of non-empty strings.`);
      return;
    }
    if (entry.difficulty !== undefined && !isDifficulty(entry.difficulty)) {
      shape.push(
        `item ${id}'s \`difficulty\` is ${JSON.stringify(entry.difficulty)}; it must be one of ${DIFFICULTY_ORDER.join(", ")}.`,
      );
      return;
    }
    if (entry.verify !== undefined && typeof entry.verify !== "string") {
      shape.push(`item ${id}'s \`verify\` must be a string command.`);
      return;
    }
    const difficulty = isDifficulty(entry.difficulty) ? entry.difficulty : null;
    items.push({
      number: items.length + 1,
      id,
      kind: kind as WorkKind,
      paths,
      prompt: entry.prompt,
      dependsOn: [],
      requires,
      verify: resolveVerify(typeof entry.verify === "string" ? entry.verify : null, input.cwd),
      difficulty,
      clampedTo: difficulty === null ? null : clampDifficulty(difficulty, ceiling),
    });
  });

  if (shape.length > 0) {
    refusals.push({ ruling: "the plan's own shape", lines: shape });
    return { items, waves: [], refusals };
  }

  // ---- ruling 54: dependsOn resolves, and the graph is acyclic -------------
  const byId = new Map(items.map((item) => [item.id, item.number]));
  const dependencyProblems: string[] = [];
  raw.forEach((entry, index) => {
    const item = items[index];
    if (item === undefined) return;
    const declared = stringList(entry.dependsOn);
    if (declared === null) {
      dependencyProblems.push(`item ${item.id}'s \`dependsOn\` must be an array of item ids.`);
      return;
    }
    const numbers: number[] = [];
    for (const dependency of declared) {
      const number = byId.get(dependency);
      if (number === undefined) {
        dependencyProblems.push(
          `item ${item.id} depends on \`${dependency}\`, which this plan does not contain. ` +
            "Remedy: add that item, or correct the id.",
        );
        continue;
      }
      numbers.push(number);
    }
    item.dependsOn = numbers;
  });
  if (dependencyProblems.length > 0) {
    refusals.push({ ruling: "ruling 54", lines: dependencyProblems });
  }

  let waves: number[][] = [];
  if (dependencyProblems.length === 0) {
    const waveItems: WaveItem[] = items.map((item) => ({ item: item.number, dependsOn: item.dependsOn }));
    try {
      waves = planWaves(waveItems);
    } catch (error) {
      if (error instanceof CyclicPlan) {
        const names = error.unresolved.map((n) => items.find((i) => i.number === n)?.id ?? String(n));
        refusals.push({
          ruling: "ruling 54",
          lines: [
            `this plan's dependsOn graph has a cycle: ${names.join(", ")} can never become eligible.`,
            "  Rejected at validation rather than during execution, where the symptom would be a",
            "  run that started, integrated nothing and could not say why. Remedy: break the cycle.",
          ],
        });
      } else if (error instanceof UnusablePlan) {
        refusals.push({ ruling: "ruling 54", lines: [error.message] });
      } else {
        throw error;
      }
    }
  }

  // ---- ruling 13: two write items may not claim one path ------------------
  const claims = new Map<string, string[]>();
  for (const item of items) {
    if (item.kind !== "write") continue;
    for (const path of item.paths) {
      const owners = claims.get(path) ?? [];
      owners.push(item.id);
      claims.set(path, owners);
    }
  }
  const collisions = [...claims].filter(([, owners]) => owners.length > 1);
  if (collisions.length > 0) {
    refusals.push({
      ruling: "ruling 13",
      lines: [
        "two items claim the same path, so they cannot run concurrently and their results",
        "  cannot be merged without one silently overwriting the other:",
        ...collisions.map(([path, owners]) => `    ${path} — claimed by ${owners.join(" and ")}`),
        "  Remedy: give each path one owner, or make the second item depend on the first with",
        "  `dependsOn` so they run in different waves (ruling 54).",
      ],
    });
  }
  const unowned = items.filter((item) => item.kind === "write" && item.paths.length === 0);
  if (unowned.length > 0) {
    refusals.push({
      ruling: "ruling 13",
      lines: [
        `item ${unowned.map((i) => i.id).join(", ")} declares no \`paths\`, so nothing bounds what it`,
        "  may write and no other item can be proved disjoint from it. Remedy: declare the paths",
        "  the item owns; ruling 51 rejects an item whole if it writes outside them.",
      ],
    });
  }

  // ---- ruling 52: the verify command exists, before anything is spent ------
  const missingCheckers = items.filter((item) => item.verify.status === "missing");
  if (missingCheckers.length > 0) {
    refusals.push({
      ruling: "ruling 52",
      lines: missingCheckers.flatMap((item) => [
        `item ${item.id}: ${item.verify.refusal ?? "the verify command could not be resolved."}`,
      ]),
    });
  }

  // ---- ruling 53: eligibility over the whole ladder ------------------------
  const requirementLines: string[] = [];
  for (const item of items) {
    for (const requirement of item.requires) {
      const known = (ALL_REQUIREMENTS as readonly string[]).includes(requirement);
      const anyAgent =
        known &&
        input.agents.some(
          (agent) => satisfies(agent.capabilities, requirement as Requirement) === "satisfied",
        );
      if (anyAgent) continue;
      requirementLines.push(...requirementRefusal(item.id, requirement, input.agents));
    }
  }
  if (requirementLines.length > 0) {
    refusals.push({ ruling: "ruling 53", lines: requirementLines });
  }

  return { items, waves, refusals };
}
