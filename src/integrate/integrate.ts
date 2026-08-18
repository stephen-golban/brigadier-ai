// SPDX-License-Identifier: Apache-2.0
/**
 * Getting work out of a clone and into the operator's repository, without ever
 * touching their working tree.
 *
 * Ruling 51, and the direction is the point. **The parent fetches from the
 * clone; the clone never pushes.** MEASURED against `git 2.50.1` on 2026-08-17
 * (`probes/integration.sh` check 2, re-measured in `test/integrate.test.ts`):
 * `git -C <parent> fetch <clone-path> work:refs/brigadier/<run-id>/item/<n>`
 * works with NO remote configured on either side, and transfers only the
 * objects the item actually wrote: every object the clone STARTED from is
 * already in the parent by the same id, whether it got there as a hardlink or
 * as a copy. (It is now a copy — `src/isolation/clone.ts` clones with
 * `--no-hardlinks`, because a hardlinked object store is writable from inside
 * the directory an agent owns. The sentence this replaced said "leaves the
 * clone's objects hardlinked"; the transfer cost was never what the hardlink
 * was buying, and only the disk was.) Fetching is brigadier
 * reaching in; pushing is the agent reaching out. The same probe measured that
 * an agent CAN push into the operator's repository through the clone's own
 * `origin`, and that removing the remote is a speed bump rather than a
 * boundary — which is why the direction is a design rule and not a convenience.
 *
 * `--no-tags` IS NOT DECORATION. MEASURED against `git 2.50.1` on 2026-08-17
 * (`test/integrate.test.ts`): fetching `work:<item ref>` from a clone WITHOUT
 * `--no-tags` also copied a tag the agent had created into the operator's
 * repository, as `refs/tags/<name>` — outside `refs/brigadier/`, therefore
 * outside ruling 50's delete rule, therefore not something brigadier may clean
 * up. One flag is the difference between a ref namespace brigadier owns and a
 * ref the operator has to remove by hand.
 *
 * THE ORDER IS FIXED — fetch, then ownership, then merge — and `src/repo/git.ts`
 * carries the reason on `ownershipDiffArgv` so a refactor has to argue with it:
 * the ownership diff computes identically in the parent once the ref is here,
 * which is what keeps ruling 56's list of "git commands brigadier runs inside a
 * clone an agent touched" at zero entries.
 *
 * ON A REAL CONFLICT BRIGADIER DOES NOT RESOLVE IT and does not ask an agent
 * to. The item is reported `conflicted` with its paths named, its ref is left
 * in place for inspection, and integration CONTINUES — one bad item does not
 * cost nine good ones. Which forces the reporting rule `report.ts` implements:
 * partial integration is a first-class outcome and never renders as success.
 *
 * NO `git checkout` EXISTS ANYWHERE IN THE OPERATOR'S REPOSITORY AT ANY POINT
 * IN A RUN. `merge-tree --write-tree` merges with no checkout and no index,
 * `commit-tree` writes a commit from a tree that already exists, and
 * `update-ref --stdin` publishes. `parent.ts` refuses the working-tree commands
 * outright, so the promise is enforced rather than observed.
 */

import { ownershipDiffArgv } from "../repo/git.ts";
import { WORK_BRANCH, integrationBranch, itemRef } from "../repo/refs.ts";
import type { CheckResult } from "../work/check.ts";
import { commitTree, mergeTree, type CommitIdentity } from "./merge.ts";
import {
  judgeOwnership,
  ownershipRefusal,
  touchedPaths,
  type OwnershipVerdict,
} from "./ownership.ts";
import { assertLocalPathTransport, parentGit, refSha } from "./parent.ts";
import { applyRefTransaction, type RefEntry } from "./transaction.ts";
import { prerequisiteCheck } from "./waves.ts";
import { requireGitVersion } from "./version.ts";

export interface IntegrationItem {
  /** 1-based. The same number `src/repo/layout.ts` uses for the directory. */
  item: number;
  /**
   * The clone to fetch FROM, by filesystem path.
   *
   * brigadier never runs a git command inside it — `internal-git.ts` refuses,
   * and this module never asks. The path is an argument to a fetch that runs in
   * the operator's repository.
   */
  clone: string;
  /** Ruling 14's declared ownership, checked here rather than trusted. */
  declaredPaths: readonly string[];
}

export interface WaveSpec {
  /** The operator's repository. */
  repo: string;
  runId: string;
  /**
   * Wave 1: ruling 50's base commit. Wave N+1: the integration commit wave N
   * produced — ruling 54, and the reason wave 2 sees its prerequisite's output.
   */
  base: string;
  /** In plan order. The merge loop is ordered, and the order is the plan's. */
  items: readonly IntegrationItem[];
  wave?: number;
  /**
   * Where `refs/heads/brigadier/<run-id>` currently points, for wave N+1's
   * compare-and-swap. `null` on wave 1, when the branch is created.
   */
  branchAt?: string | null;
  /** Ruling 54: items this wave will never attempt, and what they were waiting for. */
  blocked?: ReadonlyArray<{ item: number; missing: readonly number[] }>;
  identity?: CommitIdentity;
  /**
   * The `git version` output to judge against the floor.
   *
   * Defaults to asking the git that will do the work. Present as a parameter so
   * the refusal can be exercised without an old git installed — see
   * `version.ts`, and `test/integrate.test.ts` says plainly which half of that
   * is measured and which is not.
   */
  gitVersionOutput?: string;
}

export type ItemOutcome =
  /** Merged and published. */
  | "integrated"
  /** Touched nothing. A `read-only` item's clone is never read back at all. */
  | "no-change"
  /** Wrote outside its declared paths. Rejected WHOLE. */
  | "rejected"
  /** A real conflict. Named, left for inspection, integration continued. */
  | "conflicted"
  /** Ruling 54: a prerequisite did not integrate, so this was never attempted. */
  | "not-attempted";

export interface ItemIntegration {
  item: number;
  outcome: ItemOutcome;
  /** `refs/brigadier/<run-id>/item/<n>`, whether or not it was integrated. */
  ref: string;
  /** The item's commit, once fetched. */
  sha?: string;
  ownership?: OwnershipVerdict;
  /** Present on `conflicted`, and it is the merge's own list of paths. */
  conflictPaths?: readonly string[];
  /** The integration commit this item produced. */
  integrationSha?: string;
  detail?: string;
}

export interface WaveIntegration {
  runId: string;
  wave: number;
  base: string;
  /** The wave's integration commit. Equal to `base` when nothing integrated. */
  head: string;
  branch: string;
  items: ItemIntegration[];
  /** True when the transaction ran and the branch now points at `head`. */
  published: boolean;
  /** Ruling 51: a first-class outcome, never rendered as success. */
  partial: boolean;
  /** One per item, in ruling 52's vocabulary. */
  checks: CheckResult[];
}

export class ItemRefOccupied extends Error {
  constructor(ref: string, sha: string) {
    super(
      `ruling 50: ${ref} already exists (at ${sha}), so this item has been integrated or ` +
        "attempted before. brigadier does not overwrite it. A conflicted item's ref is left " +
        "in place deliberately, for inspection; removing it is the compare-and-swap delete " +
        "`deleteRefArgv` builds, and it is the operator's call, not a retry's.",
    );
    this.name = "ItemRefOccupied";
  }
}

/**
 * Integrate one wave.
 *
 * The loop, in the order ruling 51 and ruling 56 jointly fix:
 *
 *   1. check the git version floor, ONCE, before anything is fetched;
 *   2. per item, in plan order: fetch → ownership → merge → accumulate;
 *   3. publish every item ref and the branch in ONE transaction.
 *
 * Nothing in step 2 writes to the operator's repository except the fetched
 * item refs and objects, and nothing in it can move a working tree.
 */
export async function integrateWave(spec: WaveSpec): Promise<WaveIntegration> {
  const wave = spec.wave ?? 1;
  const branch = integrationBranch(spec.runId);

  // The floor first: a refusal after five fetches is a refusal that has already
  // written to the operator's repository.
  requireGitVersion(spec.gitVersionOutput ?? (await parentGit(spec.repo, ["version"])));

  const items: ItemIntegration[] = [];
  /** Kept beside its item number, because `item 10` sorts before `item 2` as text. */
  const checks: Array<{ item: number; check: CheckResult }> = [];
  const fetched: Array<{ ref: string; sha: string }> = [];
  let head = spec.base;

  for (const blocked of spec.blocked ?? []) {
    items.push({
      item: blocked.item,
      outcome: "not-attempted",
      ref: itemRef(spec.runId, blocked.item),
      detail: `waiting on item${blocked.missing.length === 1 ? "" : "s"} ${blocked.missing.join(", ")}`,
    });
    checks.push({ item: blocked.item, check: prerequisiteCheck(blocked.item, blocked.missing) });
  }

  for (const item of spec.items) {
    const ref = itemRef(spec.runId, item.item);
    assertLocalPathTransport(item.clone);

    const occupied = await refSha(spec.repo, ref);
    if (occupied !== null) throw new ItemRefOccupied(ref, occupied);

    // FETCH. `--no-tags` because a plain fetch was measured to carry the
    // agent's tags into the operator's repository, where ruling 50's delete
    // rule cannot reach them.
    await parentGit(spec.repo, [
      "fetch",
      "--no-tags",
      item.clone,
      `${WORK_BRANCH}:${ref}`,
    ]);
    const sha = await refSha(spec.repo, ref);
    if (sha === null) {
      throw new Error(`the fetch of ${item.clone} did not create ${ref}`);
    }
    fetched.push({ ref, sha });

    // OWNERSHIP, in the parent, from the ref that just landed. `-z` is added
    // here rather than in `ownershipDiffArgv`, whose exact argv is what ruling
    // 56 measured; `test/integrate-parity.test.ts` asserts both forms name the
    // same paths in the same order, in the clone and in the parent.
    const diff = await parentGit(spec.repo, [...ownershipDiffArgv(spec.base, ref), "-z"]);
    const ownership = judgeOwnership(item.declaredPaths, touchedPaths(diff));

    if (!ownership.within) {
      const detail = ownershipRefusal(item.item, ownership);
      items.push({ item: item.item, outcome: "rejected", ref, sha, ownership, detail });
      checks.push({
        item: item.item,
        check: { name: `integrate item ${item.item}`, outcome: "fail", qualifier: "ownership", detail },
      });
      continue;
    }

    if (ownership.touched.length === 0) {
      const detail =
        `item ${item.item} changed no tracked file, so it contributes nothing to the ` +
        "integration branch. A read-only item is expected to land here.";
      items.push({ item: item.item, outcome: "no-change", ref, sha, ownership, detail });
      checks.push({
        item: item.item,
        check: { name: `integrate item ${item.item}`, outcome: "pass", qualifier: "no change", detail },
      });
      continue;
    }

    // MERGE. No checkout, no index — see `merge.ts`.
    const attempt = await mergeTree(spec.repo, head, sha);
    if (attempt.kind === "conflicted") {
      const detail =
        `item ${item.item} conflicts with work already on this wave's integration commit ` +
        `in ${attempt.paths.join(", ")}. brigadier does not resolve a conflict and does not ` +
        `ask an agent to. Its ref ${ref} is left in place for inspection, and the remaining ` +
        "items were integrated: one bad item does not cost the others.";
      items.push({
        item: item.item,
        outcome: "conflicted",
        ref,
        sha,
        ownership,
        conflictPaths: attempt.paths,
        detail,
      });
      checks.push({
        item: item.item,
        check: { name: `integrate item ${item.item}`, outcome: "fail", qualifier: "conflict", detail },
      });
      continue;
    }

    head = await commitTree(spec.repo, {
      tree: attempt.tree,
      // Two parents, so the agent's own commits stay reachable and attributed.
      parents: [head, sha],
      message:
        `brigadier: integrate item ${item.item} of run ${spec.runId} (wave ${wave})\n\n` +
        `${ownership.touched.length} path(s): ${ownership.touched.join(", ")}\n` +
        `merged with git merge-tree --write-tree; no working tree was involved.\n`,
      identity: spec.identity,
    });
    items.push({
      item: item.item,
      outcome: "integrated",
      ref,
      sha,
      ownership,
      integrationSha: head,
    });
    checks.push({ item: item.item, check: { name: `integrate item ${item.item}`, outcome: "pass" } });
  }

  // PUBLISH. One transaction: every item ref this wave read, pinned at the sha
  // the merge was computed from, plus the branch.
  let published = false;
  if (head !== spec.base) {
    const entries: RefEntry[] = fetched.map((entry) => ({
      kind: "verify",
      ref: entry.ref,
      value: entry.sha,
    }));
    entries.push(
      spec.branchAt === undefined || spec.branchAt === null
        ? { kind: "create", ref: branch, value: head }
        : { kind: "update", ref: branch, value: head, old: spec.branchAt },
    );
    await applyRefTransaction(spec.repo, spec.runId, entries);
    published = true;
  }

  return {
    runId: spec.runId,
    wave,
    base: spec.base,
    head,
    branch,
    items: items.sort((a, b) => a.item - b.item),
    published,
    partial: items.some((entry) => entry.outcome !== "integrated" && entry.outcome !== "no-change"),
    checks: checks.sort((a, b) => a.item - b.item).map((entry) => entry.check),
  };
}
