// SPDX-License-Identifier: Apache-2.0
/**
 * Driving the planner: the step where a goal becomes a plan file.
 *
 * Ruling 74. Every line here is deliberately a reuse of machinery that already
 * existed, because that is the ruling's central claim — *"the binary still holds
 * no context window; it drives a planner agent the same way it drives a
 * builder"*. If this module had needed a new isolation model, a new lane policy
 * or a new spawn path, the claim would have been false.
 *
 * What it reuses, in order: ruling 50's base commit, ruling 7's clone, ruling
 * 38's command-line marker, ruling 49's `read-only` contract, ruling 17's config
 * root, ruling 65's sink. What it adds is a brief and a JSON parser.
 *
 * **WHY THE PLANNER DOES NOT READ THE OPERATOR'S TREE**, which is the one place
 * this could plausibly have been simpler and must not be. Ruling 49 settles it:
 * *"reading the operator's own tree instead would put an agent we cannot
 * restrain inside the repository ruling 15 refuses to delete from."* A planner
 * only needs to read — but *needs to* and *is prevented from doing otherwise*
 * are different claims, and #50 measured opencode running `printf > ~/…` and
 * reporting exit 0. So the planner gets a clone like anybody else.
 *
 * **WHY IT HAS ITS OWN RUN ID.** The plan file belongs to the run it plans
 * (D4: `~/.brigadier/r/<run-id>/plan.json`), but the planner's own clone cannot
 * live at `r/<run-id>/1` — that is the first work item's directory, and the run
 * that is about to start will ask for it. So the planning phase is its own run
 * id, swept by ruling 38's sweep like any other, and only the plan file crosses
 * into the execution run's directory. Two directories, one of which is deleted
 * as soon as the planner is done, against one directory with a collision in it.
 */

import { Lane } from "../lane/lane.ts";
import { Worker } from "../agent/worker.ts";
import { PROFILES, type AgentId } from "../agent/profiles.ts";
import { spawnMarkedAgent } from "../queue/spawn.ts";
import { lanePolicyFor } from "../work/kind.ts";
import { discardClone, prepareClone, releaseToAgent } from "../isolation/clone.ts";
import type { BaseState } from "../isolation/base.ts";
import type { EffortRequest } from "../queue/effort.ts";
import { isCredentialRefusal } from "../agent/worker.ts";
import { PlannerUnusable, extractPlanJson, plannerBrief } from "./planner.ts";

/**
 * The planner was never allowed to answer.
 *
 * Separate from `PlannerUnusable` because the remedies have nothing in common:
 * that one means a model returned prose, this one means a credential was
 * refused, and ruling 52 is built on exactly this distinction — a `fail` sends
 * somebody to fix the work, an `error` sends them to fix the checker.
 */
export class PlannerRefused extends Error {
  constructor(
    readonly agent: AgentId,
    readonly detail: string,
    readonly suppressAmbient: boolean,
  ) {
    super(`the planner (${agent}) was refused by the vendor: ${detail}`);
    this.name = "PlannerRefused";
  }
}

/**
 * Ruling 79's row for a `plan` item, and the one effort decision in the product
 * with no self-serving input.
 *
 * Ruling 67 named decision 31's structural problem as *"the gate is in its own
 * fence"* — a model cannot set effort but can set the `difficulty` that
 * determines it. **A plan item has no model-supplied `difficulty` at all**: under
 * ruling 75 the input is a person's sentence, and there is no plan yet for
 * anyone to have annotated. So the fence closes by itself on the single item
 * whose failure costs the whole run rather than one item.
 *
 * `medium` because the map's own measurement puts it there: *low wins PR-scale
 * code review, medium wins Expert-SWE refactor, high wins competition
 * mathematics*, and Claude Opus 5 was measured peaking at `medium` with `high`
 * plateauing. Ruling 40 bounds how much this matters — on Claude the lever is a
 * switch, 4,000 thinking tokens giving 2,744 median output against 32,000's
 * 2,836 — so this is a real choice on Codex and close to decoration elsewhere.
 */
export const PLANNER_EFFORT: EffortRequest = "medium";

export interface CommissionSpec {
  readonly agent: AgentId;
  readonly goal: string;
  readonly repoMap: string;
  readonly repoName: string;
  readonly base: BaseState;
  readonly runRoot: string;
  /** The PLANNING run id — not the execution run's. See the module comment. */
  readonly planRunId: string;
  readonly timeoutMs: number;
  /**
   * Decision 17's toggle, read from the operator's config.
   *
   * TRUE redirects the agent's config root at the clone, which suppresses
   * user-global instruction files — and, on some vendors, logs the worker out.
   * `RULING-38-AMENDMENT.md` measured Codex and Qwen failing at `session/new`
   * under the redirect, and `isCredentialRefusal`'s own note records the
   * correction that matters here: the Claude bridge handshakes and opens a
   * session under the redirect and then fails at `session/prompt`, which is the
   * METERED call. `session/new` does not prove a credential works.
   *
   * **Seeding the operator's credential into a run-scoped directory a worker can
   * write to is a decision about a credential boundary, and it is the owner's.**
   * It is open and nothing here takes it. What this flag does instead is honour
   * the override decision 17 already provides — *"suppressed by default, with an
   * owner-facing override"* — so an operator who turns suppression off gets a
   * planner that can authenticate, and a run that says out loud that their
   * ambient instructions were not suppressed.
   */
  readonly suppressAmbient: boolean;
  readonly onFrame?: (direction: "out" | "in", raw: string) => void;
}

export interface Commission {
  /** The extracted JSON text, already proven to parse. */
  readonly planJson: string;
  /** What the planner actually said, kept for the record when it is not a plan. */
  readonly raw: string;
  readonly agent: AgentId;
  readonly bytes: number;
}

/**
 * Ask one agent for a plan, in its own clone, and take the directory away again.
 *
 * The `finally` is not hygiene. Ruling 63 draws the seam: a leaked PROCESS
 * consumes the machine and can still act, while a retained DIRECTORY is inert —
 * so an interrupted *run* keeps its clones, but a planner that has returned its
 * text has nothing left worth keeping and its ~67 MB (#19) should not accumulate
 * once per goal. The planner's output is the plan file, which is written
 * elsewhere and survives.
 */
export async function commissionPlan(spec: CommissionSpec): Promise<Commission> {
  const profile = PROFILES[spec.agent];
  const clone = await prepareClone({
    base: spec.base,
    item: 1,
    runRoot: spec.runRoot,
  });
  const owned = releaseToAgent(clone);

  const marked = spawnMarkedAgent({
    profile,
    runId: spec.planRunId,
    item: 1,
    runRoot: spec.runRoot,
    cwd: owned.dir,
    // Ruling 49's contract, unchanged and not weakened for a planner: its
    // directory is never diffed, never merged and never read back, and its lane
    // policy is a flat `deny`. A planner that needed a permission granted would
    // be a planner doing work, which is the one thing it must not do.
    kind: "read-only",
    // Decision 17, and the reason it is conditional rather than always on: see
    // `suppressAmbient`. Pointing this at the clone is what suppresses ambient
    // instruction files, and on some vendors it is also what removes the
    // credential. The operator's setting decides which cost they pay; brigadier
    // does not pick one silently and does not copy a credential to avoid it.
    ...(spec.suppressAmbient ? { configRoot: owned.dir } : {}),
    tmpDir: owned.dir,
    // Ruling 31: derived, never read from anything a model wrote. A plan item
    // has no model-supplied `difficulty` at all — there is no plan yet — so this
    // is the one effort decision in the product with no self-serving input.
    effort: PLANNER_EFFORT,
    ...(spec.onFrame ? { onFrame: spec.onFrame } : {}),
  });

  let worker: Worker | undefined;
  try {
    worker = await Worker.start(profile, {
      cwd: owned.dir,
      lane: new Lane(owned.dir, lanePolicyFor("read-only")),
      kind: "read-only",
      channel: marked.channel,
      ...(spec.onFrame ? { onFrame: spec.onFrame } : {}),
    });
    const turn = await worker.prompt(
      plannerBrief({ goal: spec.goal, repoMap: spec.repoMap, repoName: spec.repoName }),
    );
    // Refuses loudly rather than salvaging — see `extractPlanJson`. The raw text
    // travels with the error so an operator can read what the model actually
    // said rather than being told only that it was not JSON.
    const planJson = extractPlanJson(turn.text, spec.agent);
    return { planJson, raw: turn.text, agent: spec.agent, bytes: turn.bytes };
  } catch (error) {
    // A credential refusal is not a planner that wrote a bad plan, and telling
    // an operator "the planner did not return a usable plan" when the truth is
    // "it was never allowed to answer" sends them to fix the wrong thing.
    // Ruling 52's four outcomes, one layer up: this is `error`, not `fail`.
    const message = error instanceof Error ? error.message : String(error);
    if (isCredentialRefusal(message)) throw new PlannerRefused(spec.agent, message, spec.suppressAmbient);
    throw error;
  } finally {
    await worker?.close().catch(() => {});
    marked.kill();
    discardClone(owned);
  }
}

/**
 * Which agent plans, given what the machine has and what the operator configured.
 *
 * The operator's configured builder order wins, because ruling 71 writes that
 * proposal into config precisely so it can be changed. Where config says
 * nothing, the first usable agent in a stable order is used — stable rather than
 * ranked, because ranking a planner by the competence table would make the most
 * consequential single call in a run depend on a table whose own header says
 * *"Not one row says `measured`"*.
 */
export function choosePlanner(
  usable: readonly AgentId[],
  configured: readonly string[] | undefined,
): AgentId | undefined {
  for (const id of configured ?? []) {
    if ((usable as readonly string[]).includes(id)) return id as AgentId;
  }
  return usable[0];
}

export { PlannerUnusable };
