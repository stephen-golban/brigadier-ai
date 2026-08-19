// SPDX-License-Identifier: Apache-2.0
/**
 * The one structured multi-item progress channel ACP has, and the two ways it
 * has already been got wrong.
 *
 * PROGRESS IS THE WHOLE STABLE `plan`, RE-SENT. MEASURED against `Zed 1.15.0`
 * on ticket #48: `plan_update` is marked UNSTABLE in the schema and Zed
 * silently ignores it — the task list rendered once and then sat on three
 * pending spinners for the entire turn while every slice finished. Not stale:
 * actively wrong, and wrong in the direction that looks like brigadier hanging.
 * `plan` is stable and carries its entries at the top level, so every progress
 * report is the complete list again.
 *
 * STATUS IS MUTATED BY IDENTITY, NEVER DERIVED FROM AN INDEX. The same ticket
 * recorded the second bug: a version that computed every entry's status from
 * the finishing item's index flipped already-finished entries back to
 * `in_progress` whenever two finished out of order, so the display ran
 * backwards. That is why this is a class holding entry objects rather than a
 * function of (n, total), and why `finish` takes a NAME.
 *
 * AN UNKNOWN NAME THROWS. A mistyped stage that silently did nothing is the
 * first bug again with a different cause — the list renders once and then never
 * moves — and it is invisible from the outside, because a plan that never
 * advances looks exactly like work that never finished.
 */

export type PlanEntryStatus = "pending" | "in_progress" | "completed";

/**
 * One ACP plan entry, in the shape the client reads.
 *
 * `priority` is fixed at `"medium"`: the field is required by the schema and
 * brigadier has never measured anything that would justify ranking one stage of
 * its own pipeline above another. A made-up priority is a claim.
 */
export interface PlanEntry {
  content: string;
  priority: "medium";
  status: PlanEntryStatus;
}

export class UnknownPlanEntry extends Error {
  constructor(
    readonly content: string,
    known: readonly string[],
  ) {
    super(`no plan entry named ${JSON.stringify(content)}; this plan has: ${known.map((k) => JSON.stringify(k)).join(", ")}`);
    this.name = "UnknownPlanEntry";
  }
}

export class TurnPlan {
  readonly #entries: PlanEntry[];

  constructor(contents: readonly string[]) {
    this.#entries = contents.map((content) => ({ content, priority: "medium", status: "pending" }));
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * The entries to put on the wire, copied.
   *
   * Copied because the caller is about to serialise them into a frame that the
   * client keeps, and handing out the live objects would let a later mutation
   * change something already reported.
   */
  entries(): PlanEntry[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  start(content: string): void {
    this.#find(content).status = "in_progress";
  }

  finish(content: string): void {
    this.#find(content).status = "completed";
  }

  /** Everything not `completed`, for the honest tail of a cancelled turn. */
  unfinished(): string[] {
    return this.#entries.filter((entry) => entry.status !== "completed").map((entry) => entry.content);
  }

  #find(content: string): PlanEntry {
    const found = this.#entries.find((entry) => entry.content === content);
    if (found === undefined) throw new UnknownPlanEntry(content, this.#entries.map((e) => e.content));
    return found;
  }
}
