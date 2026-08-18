// SPDX-License-Identifier: Apache-2.0
/**
 * Admission: what this machine can offer, said out loud before anything runs.
 *
 * Ruling 53's "find out before you spend" is a promise about ORDER, and this
 * module is where the order is fixed. Everything below is computed from the
 * plan text, the process's `PATH` and `os.totalmem()`. Nothing here starts a
 * process, creates a directory, writes a ref or spawns an agent — which is what
 * makes `--dry-run` a real answer rather than a smaller version of the run.
 *
 * Three facts are stated at admission because finding 87 records what it costs
 * to discover them later:
 *
 *   WHICH AGENTS RESOLVED, by the entry that was found. Ruling 46: v1 inferred
 *   installation from a marker file and reported an agent present on a machine
 *   where it was not on `PATH`. So the resolved path is printed, and the
 *   sentence beside it says what resolution does NOT prove — a name on `PATH`
 *   is not a drivable agent, and `brigadier detect` is the command that
 *   settles that, because it opens a session.
 *
 *   HOW LONG THE LADDER IS. Ruling 55: a MISSING rung must not render as an
 *   EXHAUSTED one. `attempts 1 of 1 — no second rung: …` and `attempts 2 of 2`
 *   are different facts about the machine and only one of them is the
 *   operator's fault. v1 discovered a short ladder after an attempt was already
 *   gone.
 *
 *   HOW MANY WORKERS, AND WHICH FILTER SAID SO. Ruling 54: three filters, the
 *   lowest wins, and the report names WHICH — *the plan had one item*,
 *   *desirability capped it* and *RAM capped it* are three different sentences
 *   because they have three different remedies. Collapsing them to "1 worker"
 *   is how an operator ends up tuning the wrong knob.
 *
 * A BRIDGED AGENT RESOLVES AS ITS LAUNCHER, and that is a real consequence
 * rather than a rendering choice: rulings 4 and 44 launch Claude and Codex
 * through `npx`, so what has to exist on `PATH` for those two is `npx` and not
 * a binary of the vendor's name. An operator with `codex` installed and no node
 * has no Codex rung here, and the line says so rather than leaving them to
 * infer it from an empty ladder.
 */

import { applyOverride, type BridgeOverride } from "../agent/drift.ts";
import { PROFILES, ALL_AGENT_IDS, type AgentId, type LaunchProfile } from "../agent/profiles.ts";
import { chooseRung, renderLadder, type LadderOutcome, type RungDistance } from "../work/ladder.ts";
import { DEFAULT_DESIRABILITY_CAP, planFanOut, type FanOut } from "../work/fanout.ts";
import type { AgentOnLadder, PlannedItem, PlanRefusal, ValidatedPlan } from "./plan.ts";

export interface ResolvedAgent extends AgentOnLadder {
  id: AgentId;
  /** The profile as it will actually be SPAWNED, override applied (ruling 69). */
  profile: LaunchProfile;
  /** True when the entry that resolved is a bridge launcher rather than the vendor's binary. */
  bridged: boolean;
}

/**
 * Which agents this machine can even attempt, by resolving each profile's
 * command on `PATH`.
 *
 * `Bun.which` and nothing else. There is no marker file, no version directory
 * and no "it was here last time" — ruling 46 exists because every one of those
 * produced a false positive in v1.
 *
 * Ruling 69's per-machine override is applied BEFORE the lookup, and that is the
 * whole reason it is a parameter rather than something this module reads for
 * itself: an operator who redirected a bridge and then watched `brigadier
 * agents` describe the redirected coordinate while `brigadier run` resolved the
 * shipped one would be looking at exactly the staleness ruling 69 exists to
 * catch. One table, one resolution, one thing spawned.
 */
export function agentsOnPath(
  which: (command: string) => string | null = (command) => Bun.which(command),
  overrides: readonly BridgeOverride[] = [],
): ResolvedAgent[] {
  const found: ResolvedAgent[] = [];
  for (const id of ALL_AGENT_IDS) {
    const profile = applyOverride(PROFILES[id], overrides);
    const resolved = which(profile.command);
    if (resolved === null) continue;
    found.push({
      id,
      profile,
      resolved,
      bridged: profile.bridged,
      capabilities: profile.capabilities,
    });
  }
  return found;
}

/**
 * The rungs this machine actually offers, best first.
 *
 * Deliberately conservative, and the reason is ruling 55's own: a rung claimed
 * and not delivered is worse than a rung never offered, because the report will
 * say `attempts 2 of 2` and a reader will believe a second vendor was involved.
 * `same-vendor-different-model` is offered only where the profile records that
 * `session/new` returns a model list to route over (#2, ruling 40); nothing
 * here guesses a model id.
 */
export function rungsAvailable(agents: readonly ResolvedAgent[]): RungDistance[] {
  const rungs: RungDistance[] = [];
  if (agents.length >= 2) rungs.push("different-vendor");
  if (agents.some((agent) => agent.profile.modelsAtSessionNew)) {
    rungs.push("same-vendor-different-model");
  }
  return rungs;
}

export function ladderFor(agents: readonly ResolvedAgent[]): LadderOutcome {
  const rung = chooseRung(rungsAvailable(agents));
  if (rung !== null) return { kind: "completed", attempts: 2, distance: rung };
  if (agents.length === 0) {
    return {
      kind: "short",
      attempts: 1,
      reason: "no agent resolved on this machine, so there is no first rung either",
    };
  }
  return {
    kind: "short",
    attempts: 1,
    reason:
      `only ${agents[0]?.id} resolved on this machine and its profile records no model list at ` +
      "session/new, so a second attempt would repeat the same triple (ruling 55)",
  };
}

/** Ruling 54: one sentence per filter, and no two of them are the same sentence. */
export function bindingSentence(fanOut: FanOut, wave: number): string {
  const { workers, boundBy, candidates } = fanOut;
  const where = `wave ${wave}`;
  switch (boundBy) {
    case "item-count":
      return (
        `${workers} worker(s) in ${where} — the plan had ${candidates["item-count"]} item(s) here and no ` +
        "filter reduced it"
      );
    case "desirability":
      return (
        `${workers} worker(s) in ${where} — desirability capped it: the operator's per-run budget is ` +
        `${candidates.desirability}, and ruling 21 ranks "don't spawn" the first token lever`
      );
    case "feasibility":
      return (
        `${workers} worker(s) in ${where} — RAM capped it: this machine's TOTAL memory leaves room for ` +
        `${candidates.feasibility} worker(s) at 3 GiB each (ruling 54 computes from totalmem(), never ` +
        "freemem(); brigadier does not schedule against current load and does not pretend to)"
      );
    case "legality":
      return (
        `${workers} worker(s) in ${where} — legality capped it: only ${candidates.legality} item(s) here own ` +
        "disjoint paths and may run at once"
      );
  }
}

/**
 * What ruling 14's legality filter answers once ruling 13 has already refused
 * every plan it would have caught.
 *
 * Legality for `write` items is disjoint path ownership, and `validatePlan`
 * REFUSES a plan whose items collide — so by the time fan-out is computed there
 * is no surviving plan for which legality binds. Passing the wave's item count
 * here instead would tie with the item-count filter on every wave and, because
 * ties resolve away from `item-count`, would make *the plan only had one item*
 * unreachable — three different reasons to run one worker rendering as one
 * sentence, which is precisely what ruling 54 forbids.
 */
export const LEGALITY_UNBOUNDED = Number.MAX_SAFE_INTEGER;

export interface Admission {
  plan: ValidatedPlan;
  agents: ResolvedAgent[];
  ladder: LadderOutcome;
  /** One per wave, in wave order. */
  fanOut: FanOut[];
  refusals: PlanRefusal[];
}

export interface AdmitInput {
  plan: ValidatedPlan;
  agents: readonly ResolvedAgent[];
  /** Decision 25: brigadier invoked from inside a host agent session reserves that agent's RAM. */
  hostFirst: boolean;
  desirabilityCap?: number;
}

/**
 * Everything admission decides, including the refusal that comes from the
 * machine rather than from the plan.
 *
 * An empty ladder is a refusal and not a warning. A plan that no agent can
 * attempt is a plan whose every item would end at ruling 52's `not-run`, and
 * ruling 53's whole subject is learning that before a clone exists rather than
 * after five of them do.
 */
export function admit(input: AdmitInput): Admission {
  const refusals = [...input.plan.refusals];
  if (input.agents.length === 0) {
    refusals.push({
      ruling: "ruling 53",
      lines: [
        "no agent resolved on PATH, so there is no rung to attempt this plan on.",
        `  brigadier looked for ${ALL_AGENT_IDS.map((id) => PROFILES[id].command).join(", ")} —`,
        "  and note that claude and codex are reached through a vendored bridge (rulings 4 and 44),",
        "  so what must be on PATH for those two is `npx`, not a binary of the vendor's name.",
        "  Remedy: install one of them and run `brigadier detect`, which opens a session and is",
        "  the only thing that proves an agent is drivable rather than merely present.",
      ],
    });
  }

  const ladder = ladderFor(input.agents);
  const fanOut = input.plan.waves.map((wave) =>
    planFanOut({
      itemCount: wave.length,
      legalityCap: LEGALITY_UNBOUNDED,
      hostFirst: input.hostFirst,
      desirabilityCap: input.desirabilityCap ?? DEFAULT_DESIRABILITY_CAP,
    }),
  );

  return { plan: input.plan, agents: [...input.agents], ladder, fanOut, refusals };
}

/** The lines `--dry-run` prints when a plan is admitted. */
export function describeAdmission(admission: Admission, planPath: string): string[] {
  const { plan, agents, ladder, fanOut } = admission;
  const lines = [
    `admitted — ${planPath}: ${plan.items.length} item(s) in ${plan.waves.length} wave(s)`,
  ];

  lines.push(
    agents.length === 0
      ? "  agents     none resolved on PATH"
      : `  agents     ${agents.length} resolved on PATH: ${agents
          .map((a) => `${a.id} at ${a.resolved}${a.bridged ? " (bridge launcher)" : ""}`)
          .join(", ")}`,
  );
  lines.push(
    "             resolving a name is not driving an agent — `brigadier detect` opens a session,",
    "             and that is the only thing that proves one is usable (ruling 46).",
  );
  lines.push(`  ladder     ${renderLadder(ladder)}`);
  for (const [index, wave] of plan.waves.entries()) {
    const names = wave.map((n) => plan.items.find((i) => i.number === n)?.id ?? String(n));
    lines.push(`  wave ${index + 1}     ${names.join(", ")}`);
    const bound = fanOut[index];
    if (bound !== undefined) lines.push(`             ${bindingSentence(bound, index + 1)}`);
  }
  if (plan.waves.length > 1) {
    lines.push(
      "             a wave boundary is a gate boundary: wave N+1 clones from wave N's integration",
      "             commit and does not start until the gate on it did not block (ruling 54).",
    );
  }
  for (const item of plan.items) {
    for (const line of describeItem(item)) lines.push(`  ${line}`);
  }
  lines.push(
    "  ruling 37  a verify command committed in the repository is never read and never run:",
    "             brigadier runs the command the operator handed it, and nothing else.",
  );
  return lines;
}

/** Per-item admission facts. Ruling 67's clamp prints here, per item, always. */
export function describeItem(item: PlannedItem): string[] {
  const lines: string[] = [];
  if (item.difficulty !== null && item.clampedTo !== null) {
    lines.push(
      item.clampedTo === item.difficulty
        ? `${item.id}    difficulty: ${item.difficulty}`
        : `${item.id}    difficulty: ${item.difficulty} (clamped to ${item.clampedTo})`,
    );
  }
  if (item.verify.status === "resolved") {
    lines.push(`${item.id}    verify \`${item.verify.argv.join(" ")}\` resolved at ${item.verify.resolved}`);
  } else if (item.verify.status === "unconfigured") {
    lines.push(`${item.id}    verify: unconfigured — ruling 52 prints this, and does not block on it`);
  }
  return lines;
}

/** The lines a refusal prints. Never a count of what was excluded. */
export function describeRefusals(refusals: readonly PlanRefusal[], planPath: string): string[] {
  const lines = [
    `refused — ${planPath} was not admitted, and nothing was started:`,
    "  zero processes, zero clones, zero refs. The refusal is computed from the plan text, PATH",
    "  and this machine's memory, before anything is created (rulings 13, 52, 53, 54).",
    "",
  ];
  for (const refusal of refusals) {
    lines.push(`${refusal.ruling}:`);
    for (const line of refusal.lines) lines.push(`  ${line}`);
    lines.push("");
  }
  return lines;
}
