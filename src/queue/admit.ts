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
import type { Detection } from "../agent/detect.ts";
import { isCapped, type Audience } from "../report/budget.ts";
import { PROFILES, ALL_AGENT_IDS, type AgentId, type LaunchProfile } from "../agent/profiles.ts";
import { chooseRung, renderLadderOffered, type LadderOutcome, type RungDistance } from "../work/ladder.ts";
import { DEFAULT_DESIRABILITY_CAP, planFanOut, type FanOut } from "../work/fanout.ts";
import { chooseReviewer, type ReviewerChoice } from "./review.ts";
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
 * and no "it was here last time" — ruling 6 exists because v1 inferred
 * installation from a MARKER FILE and reported `opencode` present on a machine
 * where it was not on `PATH`, and ruling 46 adds the other half: *"detection
 * must report the resolved `PATH` entry rather than assume it is ours"*, because
 * v1 shipped a `brigadier` of its own on a Homebrew tap at 0.2.1.
 *
 * CORRECTED 2026-08-20. This comment used to attribute the marker-file false
 * positive to ruling 46, which is the IDENTITY ruling. Ruling 62 (f) makes a
 * comment contradicting its cited fact a `fail` rather than advisory, and this
 * file's citations are the only thing a reader can check the claim against.
 *
 * Ruling 71's detection cache does not weaken the "no it-was-here-last-time"
 * rule and is not an exception to it: nothing stored is trusted unless the
 * command still resolves to the same entry and that entry's bytes have not
 * moved, and this function — which resolves rather than remembers — is what the
 * cache is checked against on every invocation.
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

/** One agent `agentsOnPath` resolved but detection will not let `run` use. */
export interface DetectionRejection {
  id: AgentId;
  /** `unusable`, `absent`, or `drift` — which of the two gates refused it. */
  because: "unusable" | "absent" | "drift";
  /** The vendor's own words where there are any, else ours. */
  detail: string;
}

/**
 * Narrow `agentsOnPath`'s answer to the agents detection actually proved.
 *
 * THIS IS FINDING V1. `agentsOnPath` resolves a command on `PATH` and stops
 * there — correctly, that is all it claims to do — and `run` used to admit on
 * that alone. MEASURED by the independent verifier on 2026-08-20: `detect`
 * reported five vendors usable AND graded Claude/Codex version drift
 * `blocking`; `run` used none of it, routed a write to Claude, and failed the
 * first prompt with `Authentication required`. A resolved `PATH` entry is
 * ruling 41's *present*, and work needs *usable*.
 *
 * Two gates, and they are different rulings:
 *
 *   Ruling 41 — anything not `usable` is refused, because a completed handshake
 *   is not a completed session and only the second one means work can start.
 *
 *   Ruling 69 — a `blocking` drift refuses WRITE work specifically. The lane
 *   assertion is the blocking grade because if it silently stops working the
 *   containment is gone and nothing goes red. A `read-only` item does not block
 *   on it: ruling 49 gave that kind a flat `deny` lane needing no vendor
 *   cooperation.
 *
 * AND AN OPERATOR-OVERRIDDEN PROFILE IS EXEMPT FROM THE SECOND GATE, which is
 * not a softening. Ruling 69's Q3 exists to let an operator replace a stale
 * bridge WITHOUT waiting for a brigadier release. A replacement bridge reports
 * whatever version it reports, so it drifts from `measuredVersion` essentially
 * by definition — blocking on that would mean every override kills all write
 * work on that vendor, and the remedy ruling 69 built would be unusable the day
 * it shipped. The ruling says what happens instead, and says it twice: an
 * overridden bridge "invalidates every measured fact … the operator chose it,
 * so the operator gets the consequences, **stated at the start of a run rather
 * than discovered in the middle**". Stated. `overrideWarning` is what states it,
 * and it has already printed by the time this function runs.
 *
 * The distinction is between drift the operator CHOSE and drift that happened
 * TO them — a vendor auto-updating underneath a machine is the case the blocking
 * grade was written for, and it is untouched.
 *
 * WHAT IT COSTS, stated: a detection sweep stands between `run` and its first
 * item. Ruling 71 already accepted that shape — detection is lazy on first run —
 * and bounds it by the slowest agent rather than their sum, since the probes are
 * concurrent.
 *
 * Ruling 71's cache landed on 2026-08-20 and it does NOT remove that cost from
 * `run`, deliberately. `src/cli.ts`'s `sweep` lets `plan`, `--dry-run` and
 * `--estimate` answer from the last probe — those spend nothing, and the sweep
 * in front of them was the wait ruling 71 objected to — while a real `run`
 * re-probes, on ruling 63's rule that where the world can be consulted directly
 * the world wins. So the drift gate below is never decided from a stored version
 * string, which is the half of finding V1 a cache could most easily have
 * re-opened.
 */
export function admissibleAfterDetection(
  agents: readonly ResolvedAgent[],
  detections: readonly Detection[],
  options: { hasWriteWork: boolean; overridden?: ReadonlySet<string> },
): { admitted: ResolvedAgent[]; rejected: DetectionRejection[] } {
  const overridden = options.overridden ?? new Set<string>();
  const byId = new Map(detections.map((d) => [d.id, d]));
  const admitted: ResolvedAgent[] = [];
  const rejected: DetectionRejection[] = [];

  for (const agent of agents) {
    const detection = byId.get(agent.id);
    if (detection === undefined) {
      // Never silently admit an agent nobody probed. An absent result is not a
      // clean one, and ruling 53's principle is the same shape: unmeasured does
      // not satisfy a requirement.
      rejected.push({
        id: agent.id,
        because: "absent",
        detail: "resolved on PATH but detection never probed it",
      });
      continue;
    }
    if (detection.availability !== "usable") {
      rejected.push({
        id: agent.id,
        because: detection.availability,
        detail: detection.remedy ?? `detection reported ${detection.availability}`,
      });
      continue;
    }
    const blocking = (detection.drift ?? []).filter((d) => d.severity === "blocking");
    if (options.hasWriteWork && blocking.length > 0 && !overridden.has(agent.id)) {
      rejected.push({
        id: agent.id,
        because: "drift",
        detail: blocking
          .map((d) => `${d.field}: measured against ${d.measuredAgainst}, observed ${d.observed} — ${d.why}`)
          .join("; "),
      });
      continue;
    }
    admitted.push(agent);
  }

  return { admitted, rejected };
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
  // Two rungs are OFFERED. `attempts` is what an item spent and is filled in per
  // item afterwards by `ladderTaken`; here it is 0, because at admission nothing
  // has been spent — which is the whole of ruling 53's ordering promise.
  if (rung !== null) return { kind: "completed", attempts: 0, of: 2, distance: rung };
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
      `only one vendor is drivable (${agents[0]?.id}), and its profile records no model list at ` +
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
  /**
   * Ruling 32, decided HERE and used by the run, or `null` when `--review` was
   * not asked for.
   *
   * One decision, in the place that prints it before anything is spent. The run
   * reading it back rather than recomputing it is what stops a run from
   * reporting a different answer from the one its own admission printed — the
   * same reasoning ruling 69 gives for one table, one resolution, one spawn.
   */
  reviewer: ReviewerChoice | null;
}

export interface AdmitInput {
  plan: ValidatedPlan;
  agents: readonly ResolvedAgent[];
  /** Decision 25: brigadier invoked from inside a host agent session reserves that agent's RAM. */
  hostFirst: boolean;
  desirabilityCap?: number;
  /** `--review`. An operator who did not ask for a reviewer is not told about one. */
  review?: boolean;
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

  return {
    plan: input.plan,
    agents: [...input.agents],
    ladder,
    fanOut,
    refusals,
    reviewer: input.review === true ? chooseReviewer(input.agents, input.agents[0]?.id ?? null) : null,
  };
}

/**
 * The lines an admitted plan prints, sized for whoever is paying for them.
 *
 * RULING 58'S CEILING IS ON THE WHOLE OF STDOUT, NOT ON THE REPORT ALONE, and
 * that is a MEASURED repair rather than a tidy-up. MEASURED on 2026-08-18
 * against `bun 1.3.14`: a fifty-item run into a host session printed 3,682
 * tokens against a 2,000-token ceiling. `src/report/run-report.ts` was inside
 * its budget the whole time — 1,648 of those tokens were THIS function, printed
 * before the report and never counted against anything, because the cap was
 * written as a property of one artifact rather than of the channel. A budget
 * that only governs the last thing written is not a budget.
 *
 * So in `host-session` the two O(items) sections here — the wave membership and
 * the per-item admission facts — collapse to counts, and everything that stays
 * is O(1) or O(vendors). Nothing is lost that a reader cannot reach: the plan
 * file is named on the first line and is where every per-item fact came from,
 * and ruling 67's clamp is printed per item AGAIN in the run report, where the
 * cap never collapses an item carrying a blocking check.
 *
 * A terminal reader keeps every line, and that difference is the negative
 * control: a renderer that simply printed less would fail there.
 */
export function describeAdmission(
  admission: Admission,
  planPath: string,
  audience: Audience = "terminal",
): string[] {
  const { plan, agents, ladder, fanOut } = admission;
  const capped = isCapped(audience);
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
  lines.push(`  ladder     ${renderLadderOffered(ladder)}`);
  // Ruling 32, stated with the ladder and before anything is spent, because the
  // two are the same fact about the machine seen from two sides: a `PATH` with
  // one vendor has no second rung AND no cross-vendor reviewer. v1's shape was
  // to discover both after an attempt was already gone. Printed only when the
  // operator asked for a reviewer — a line about a check nobody requested is
  // the kind of noise that teaches people to skim the block this ruling needs
  // them to read.
  const reviewer = admission.reviewer;
  if (reviewer !== null) {
    lines.push(
      `  review     ${
        reviewer.agent === null
          ? "no vendor is drivable, so --review has nothing to route and every item's review check blocks"
          : reviewer.crossVendor
            ? `cross-vendor is available — ${reviewer.agent.id} can review work built by ${agents[0]?.id}`
            : `SAME-VENDOR only — ${reviewer.sameVendorReason ?? ""}`
      }`,
    );
  }
  for (const [index, wave] of plan.waves.entries()) {
    const names = wave.map((n) => plan.items.find((i) => i.number === n)?.id ?? String(n));
    lines.push(capped ? `  wave ${index + 1}     ${wave.length} item(s)` : `  wave ${index + 1}     ${names.join(", ")}`);
    const bound = fanOut[index];
    if (bound !== undefined) lines.push(`             ${bindingSentence(bound, index + 1)}`);
  }
  if (plan.waves.length > 1) {
    lines.push(
      "             a wave boundary is a gate boundary: wave N+1 clones from wave N's integration",
      "             commit and does not start until the gate on it did not block (ruling 54).",
    );
  }
  if (capped) {
    for (const line of collapsedItems(plan.items, planPath)) lines.push(`  ${line}`);
  } else {
    for (const item of plan.items) {
      for (const line of describeItem(item)) lines.push(`  ${line}`);
    }
  }
  lines.push(
    "  ruling 37  a verify command committed in the repository is never read and never run:",
    "             brigadier runs the command the operator handed it, and nothing else.",
  );
  return lines;
}

/**
 * The per-item admission facts as COUNTS, for a reader that pays per byte.
 *
 * Ruling 58's collapse rule one artifact over: print fewer ITEMS, never fewer
 * KINDS OF FACT. Every category a terminal reader would have seen is still
 * named here — a clamped difficulty, an unclamped one, a resolved verify, an
 * unconfigured verify — so a category cannot vanish by being empty-looking, and
 * only the per-item repetition is gone. The clamp in particular is not dropped:
 * a clamp that fired is printed with its item ids, because ruling 67 exists
 * because v1's recurring shape is the silent downgrade nobody sees, and the
 * clamped set is the one category whose size is bounded by how many items the
 * operator over-declared rather than by the plan.
 */
export function collapsedItems(items: readonly PlannedItem[], planPath: string): string[] {
  const clamped = items.filter(
    (item) => item.difficulty !== null && item.clampedTo !== null && item.clampedTo !== item.difficulty,
  );
  const declared = items.filter(
    (item) => item.difficulty !== null && item.clampedTo !== null && item.clampedTo === item.difficulty,
  );
  const resolved = items.filter((item) => item.verify.status === "resolved");
  const unconfigured = items.filter((item) => item.verify.status === "unconfigured");
  const lines = [
    `items      ${items.length} item(s); per-item admission facts are COLLAPSED for a host session ` +
      "(ruling 58: the ceiling is on everything this process writes, not on the report alone).",
    `             they were computed from ${planPath} and every one of them is in the run record.`,
  ];
  if (clamped.length > 0) {
    // Named rather than counted. Ruling 67: a clamp spends less than the
    // operator asked for, and a silent downgrade is the shape it exists to stop.
    for (const item of clamped) {
      lines.push(`             ${item.id}    difficulty: ${item.difficulty} (clamped to ${item.clampedTo})`);
    }
  }
  if (declared.length > 0) lines.push(`             ${declared.length} item(s) declared a difficulty that was NOT clamped`);
  if (resolved.length > 0) lines.push(`             ${resolved.length} item(s) carry a verify command, resolved on PATH before anything ran`);
  if (unconfigured.length > 0) {
    lines.push(
      `             ${unconfigured.length} item(s) verify: unconfigured — ruling 52 prints this, and does not block on it`,
    );
  }
  // A category that is neither of the two above — a verify command that did not
  // resolve — is NAMED rather than left to be inferred from arithmetic. A
  // collapse that silently loses a category is exactly the shape ruling 52
  // forbids one level down, and this is the only line here that can be reached
  // by a state nobody thought of.
  const other = items.length - resolved.length - unconfigured.length;
  if (other > 0) {
    lines.push(
      `             ${other} item(s) whose verify command did NOT resolve on PATH — the plan's refusal above says which`,
    );
  }
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
