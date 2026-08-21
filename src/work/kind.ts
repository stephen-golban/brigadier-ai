// SPDX-License-Identifier: Apache-2.0
/**
 * Work kinds.
 *
 * Ruling 19 introduced `write` and `read-only` as the core abstraction. Ruling
 * 49 made them concrete, and the shape it settled on is not the obvious one.
 *
 * The obvious design says `read-only` means the agent cannot write. **That is
 * unenforceable on this fleet and was measured to be, three separate times:**
 * Codex sends nothing on a permission request and asks non-deterministically
 * (#3, #41); Qwen never issues one at all; opencode has no boundary of any kind
 * for execute-class work — it ran `printf > ~/…` and reported exit 0 (#50). A
 * client-side rule that three of five vendors never consult is worse than a
 * comment, because it looks like a boundary in the code.
 *
 * So the kind is defined by what brigadier does with the directory afterwards,
 * which is a property brigadier can keep alone:
 *
 *   A `read-only` item's directory is never diffed, never merged and never
 *   read back. Its only output is the text the agent returns.
 *
 * The lane policy for `read-only` is a flat `deny`, and that is forced by a
 * measurement rather than by caution. #41 held mode, prompt and paths fixed and
 * varied only the client's answer: an APPROVED `session/request_permission`
 * runs the command outside Codex's own OS sandbox. On the one vendor where real
 * read-only enforcement was measured to exist, answering "allow" is the act
 * that destroys it — a permission request IS the escalation out of read-only.
 */

import type { Policy } from "../lane/lane.ts";

export type WorkKind = "write" | "read-only" | "plan" | "research";

export const ALL_WORK_KINDS: WorkKind[] = ["write", "read-only", "plan", "research"];

/**
 * The kinds a PLAN may declare. Ruling 84.
 *
 * `plan` and `research` are commissioned by brigadier from a person's sentence,
 * before there is a plan for anyone to have written them into. A plan declaring
 * a `plan` item is a planner asking for another planner; a plan declaring a
 * `research` item is asking for something ruling 78 describes — *"a finding
 * carried into a later item's brief"* — through a channel `PLANNER_RULES` rule 6
 * explicitly denies, because `dependsOn` is a wave boundary and not a channel.
 *
 * So they are refused by name rather than silently mishandled, and the refusal
 * says which entry point does commission them.
 */
export const PLANNABLE_KINDS: WorkKind[] = ["write", "read-only"];

/**
 * Everything ruling 49 settled about a kind, in one place, so that a caller
 * cannot implement half of it. This is a specification constant: the modules
 * that act on it — the clone pool, the integration step, the router — belong to
 * the build phase and are named here rather than written here.
 */
export interface KindContract {
  /** How the worker's directory is obtained. */
  readonly isolation:
    | /** A dedicated `git clone --local`, one per in-flight item, never shared. */ "clone"
    | /** A pooled directory recycled to the item's ref. */ "pooled";
  /**
   * What the directory starts as.
   *
   * `base-commit` is ruling 33's scratch commit — HEAD plus uncommitted tracked
   * AND untracked work — because `git clone --local` clones committed state
   * only and a person who has been editing for an hour is the normal case.
   */
  readonly baseState: "base-commit" | "named-ref";
  /**
   * The recycle command, where there is one.
   *
   * `git clean -fdx` is mandatory rather than hygiene: #19 measured that
   * `checkout --force` leaves untracked and gitignored residue behind, and that
   * residue is exactly how one item's junk becomes the next item's context.
   */
  readonly recycle: readonly string[];
  /** May the worker install dependencies? An item that must is a `write` item. */
  readonly mayInstallDependencies: boolean;
  /** Ruling 49. `deny` is not paranoia — see the module comment. */
  readonly lanePolicy: Policy;
  /** Ruling 32's cross-vendor review is a `write`-only rule: no diff, nothing to gate. */
  readonly crossVendorReview: boolean;
  /** Does anything reach the integration branch? */
  readonly mergesBack: boolean;
  /**
   * What ruling 14's *legality* filter checks for this kind.
   *
   * It does not vanish for `read-only`, it changes subject: disjoint path
   * ownership is meaningless without a diff, but "the ref resolves and no two
   * items ask the same question of it" is a real precondition, checkable before
   * anything spawns — and it is exactly the class of failure v1 kept
   * discovering inside a worker instead of before one.
   */
  readonly legality: "disjoint-paths" | "resolvable-distinct-refs";
  /**
   * What brigadier does with what comes BACK, which is the whole of what
   * separates the four kinds since ruling 78.
   *
   * Ruling 49 defines a kind by what brigadier does with the DIRECTORY, and by
   * that definition `read-only`, `plan` and `research` are one kind: pooled,
   * never diffed, never merged, never read back. They are three kinds because
   * the text differs — one is reported and dropped, one is parsed into a plan
   * brigadier then validates and executes, and one is a finding carried into a
   * later brief. A contract that recorded only the directory would say these
   * three were interchangeable, and routing would then be free to treat them so.
   */
  readonly product:
    | /** The diff, merged onto the integration ref. The text is a report. */ "diff"
    | /** The text, reported to the operator and never read back. */ "text"
    | /** The text, parsed as a plan and validated exactly like a handed-in one. */ "plan-json"
    | /** The text, carried into a later brief, refused if it carries no date. */ "dated-finding";
  /**
   * Must the agent be able to reach today's web with its own tool?
   *
   * Ruling 78: NOT a ruling 53 requirement term — on Codex web reach is an argv
   * flag and a boolean cannot pass a flag — so it is a launch-profile column
   * (`LaunchProfile.reachesWeb`) that the router filters on, and this is the
   * field that says which kinds make it filter. Ruling 53's rule governs it
   * unchanged: **unmeasured is not permission**, and the refusal says
   * *unmeasured on this agent* rather than *unsupported*.
   */
  readonly requiresWebReach: boolean;
  /**
   * May a plan declare an item of this kind? Ruling 84 — see `PLANNABLE_KINDS`.
   */
  readonly plannable: boolean;
}

export const KIND_CONTRACT: Record<WorkKind, KindContract> = {
  write: {
    isolation: "clone",
    baseState: "base-commit",
    recycle: [],
    mayInstallDependencies: true,
    lanePolicy: "lane",
    crossVendorReview: true,
    mergesBack: true,
    legality: "disjoint-paths",
    product: "diff",
    requiresWebReach: false,
    plannable: true,
  },
  "read-only": {
    isolation: "pooled",
    baseState: "named-ref",
    // Measured at ~1–3 s to recycle against 6.06 s to clone (#19).
    recycle: ["git fetch", "git checkout <ref>", "git clean -fdx"],
    mayInstallDependencies: false,
    lanePolicy: "deny",
    crossVendorReview: false,
    mergesBack: false,
    legality: "resolvable-distinct-refs",
    product: "text",
    requiresWebReach: false,
    plannable: true,
  },
  /**
   * Ruling 78. `read-only` in shape, and that is exactly why the overturn of
   * ruling 20's consequence was cheap: no new isolation model, no new lane
   * policy, no new spawn path. What differs is `product`.
   *
   * The lane policy is `deny` and is NOT relaxed for a planner. A planner that
   * needed a permission granted would be a planner doing work, which is the one
   * thing it must not do — and #41 measured that on the single vendor where
   * read-only enforcement is real, answering "allow" is the act that destroys
   * it.
   */
  plan: {
    isolation: "pooled",
    baseState: "named-ref",
    recycle: ["git fetch", "git checkout <ref>", "git clean -fdx"],
    mayInstallDependencies: false,
    lanePolicy: "deny",
    crossVendorReview: false,
    mergesBack: false,
    // One planner, one question, one ref. Ruling 14's legality filter changes
    // subject rather than vanishing — see `legality` above.
    legality: "resolvable-distinct-refs",
    product: "plan-json",
    requiresWebReach: false,
    plannable: false,
  },
  /**
   * Ruling 78 and decision D22. The one kind with a requirement on the AGENT
   * rather than only on the directory, and the one whose output is checked for
   * a property rather than parsed.
   */
  research: {
    isolation: "pooled",
    baseState: "named-ref",
    recycle: ["git fetch", "git checkout <ref>", "git clean -fdx"],
    mayInstallDependencies: false,
    lanePolicy: "deny",
    crossVendorReview: false,
    mergesBack: false,
    legality: "resolvable-distinct-refs",
    product: "dated-finding",
    // The kind exists to defeat a model answering from 2024 when it is 2026. An
    // agent that cannot reach today's web can only produce a finding dated from
    // its training, so routing there and hoping is worse than refusing.
    requiresWebReach: true,
    plannable: false,
  },
};

/** Ruling 49. The only lane policy a work kind may ask for. */
export function lanePolicyFor(kind: WorkKind): Policy {
  return KIND_CONTRACT[kind].lanePolicy;
}
