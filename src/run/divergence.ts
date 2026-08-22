// SPDX-License-Identifier: Apache-2.0
/**
 * When a pending run stops being resumable.
 *
 * D15, and the whole of it is one sentence: **a pending run is invalidated by
 * divergence, not by a clock.** It expires the moment resuming would be wrong —
 * the operator's `HEAD` moved over something the plan owns, the working tree
 * changed under one of those paths, or a routed vendor is gone or drifted
 * (ruling 69) — and a duration was considered and rejected as the primary test.
 *
 * **PATH-SCOPED RATHER THAN WHOLE-TREE**, which is D15's own qualifier and the
 * thing that makes the difference between a mechanism and an annoyance: *"an
 * unrelated typo fix does not invalidate a run."* A repository is not a
 * lockfile, and an operator who fixes a comment in an unrelated file while
 * waiting to answer a question has not made the answer wrong.
 *
 * **AND AN EMPTY SCOPE IS NOT A WILDCARD.** A question asked BEFORE planning has
 * no claimed paths, because nothing has been computed against the repository
 * yet: there is no plan whose assumptions a commit could invalidate. Such a run
 * survives a commit, and the plan it goes on to commission is simply made
 * against the newer base — which is more correct, not less. A question asked
 * AFTER planning carries the plan's paths, and those are what a commit is
 * checked against.
 *
 * THE BACKSTOP IS A JUDGEMENT AND IS PRINTED AS ONE. Seven days, for the case
 * where nothing diverged and the operator forgot. D15 requires it to be printed
 * beside every expiry it causes, the way `BAR.md` prints the 2.5 MiB
 * contribution budget beside every verdict it produces — so the constant is
 * exported, named in the message, and labelled as unmeasured where it appears.
 */

import type { PendingRun } from "./pending.ts";

/**
 * D15's backstop. **A judgement, not a measurement**, and it is printed beside
 * every expiry it causes rather than applied silently.
 */
export const BACKSTOP_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The operator's side of the comparison, as it is NOW. */
export interface RepoNow {
  /** `git rev-parse HEAD`. */
  readonly head: string;
  /** Paths `git status --porcelain -uall` reports as dirty, untracked included. */
  readonly dirty: readonly string[];
  /**
   * Paths changed between the pending run's `HEAD` and this one.
   *
   * `undefined` means the question could not be answered — the recorded commit
   * is gone (a rebase, a reset, a pruned branch), so nothing can be said about
   * what moved. That is treated as divergence, not as sameness: see below.
   */
  readonly changedSinceHead: readonly string[] | undefined;
}

/** Which vendors are usable now, and at what version detection saw them. */
export interface FleetNow {
  readonly usable: readonly { readonly id: string; readonly version: string }[];
}

export interface Divergence {
  readonly resumable: boolean;
  /** One line per reason, in D24's form. Empty when resumable. */
  readonly reasons: readonly string[];
}

/**
 * Ask whether this pending run may still be continued.
 *
 * **Every state except positively established sameness expires.** That is
 * `kept.ts`'s rule pointed the other way, and the asymmetry is the same
 * argument: being wrong about *keeping a directory* costs disk, and being wrong
 * about *resuming a run* spends metered turns against a base that no longer
 * exists and merges the result somewhere nobody expects. So an unanswerable
 * question — a `HEAD` git cannot diff from — expires the run rather than being
 * read as "probably fine".
 */
export function divergence(pending: PendingRun, repo: RepoNow, fleet: FleetNow, now: number): Divergence {
  const reasons: string[] = [];
  const scope = new Set(pending.paths);

  if (repo.head !== pending.head) {
    if (repo.changedSinceHead === undefined) {
      reasons.push(
        `brigadier: expired — HEAD was ${short(pending.head)} and is now ${short(repo.head)}, and git cannot say what ` +
          "moved between them. A commit that is no longer reachable is a base this run cannot be resumed onto.",
      );
    } else if (scope.size === 0) {
      // Deliberately NOT a reason. Nothing had been computed against the
      // repository when this question was asked, so a newer base is simply the
      // base the plan will be made from.
    } else {
      const collided = repo.changedSinceHead.filter((path) => scope.has(path));
      if (collided.length > 0) {
        reasons.push(
          `brigadier: expired — ${collided.length} path(s) this plan claims changed in commits since it was made: ` +
            `${collided.slice(0, 3).join(", ")}${collided.length > 3 ? ", …" : ""}`,
        );
      }
    }
  }

  if (scope.size > 0) {
    const dirtied = repo.dirty.filter((path) => scope.has(path));
    const wasDirty = new Set(pending.dirty);
    const fresh = dirtied.filter((path) => !wasDirty.has(path));
    if (fresh.length > 0) {
      reasons.push(
        `brigadier: expired — ${fresh.length} path(s) this plan claims were edited while the question was open: ` +
          `${fresh.slice(0, 3).join(", ")}${fresh.length > 3 ? ", …" : ""}`,
      );
    }
  }

  // Ruling 69: a vendor that is gone, or is no longer the vendor that was
  // measured, is not the vendor this run was routed to.
  const now_ = new Map(fleet.usable.map((agent) => [agent.id, agent.version]));
  for (const agent of pending.agents) {
    const version = now_.get(agent.id);
    if (version === undefined) {
      reasons.push(`brigadier: expired — ${agent.id} was routed for this run and is no longer usable on this machine`);
    } else if (version !== agent.version) {
      reasons.push(
        `brigadier: expired — ${agent.id} was ${agent.version} when this run was routed and is now ${version} (ruling 69)`,
      );
    }
  }

  const age = now - pending.askedAt;
  if (age > BACKSTOP_DAYS * DAY_MS) {
    reasons.push(
      `brigadier: expired — this question has been open ${Math.floor(age / DAY_MS)} days, past the ${BACKSTOP_DAYS}-day ` +
        "backstop. That number is a JUDGEMENT and not a measurement: nothing diverged, and it expired anyway.",
    );
  }

  return { resumable: reasons.length === 0, reasons };
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
