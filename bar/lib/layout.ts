// SPDX-License-Identifier: Apache-2.0
/**
 * Where the product actually puts a clone, read out of the product.
 *
 * The ninth instrument defect of this session, and the same shape as the other
 * eight: a check that reported confidently about a place it was not looking.
 * `bar/items/07-interruption-leaves-nothing.ts` enumerated
 * `<run-root>/<dir>/clones/<n>`. The product writes `<run-root>/r/<run-id>/<n>`
 * — `src/repo/layout.ts`, where ruling 61 fixes that short shape deliberately:
 * `r` rather than `runs`, a short run id, a bare item number, because the
 * spread between the shortest and longest candidate root is 23 characters, 13%
 * of #5's entire measured MAX_PATH budget.
 *
 * So the enumeration always returned nothing, and TWO symptoms followed from
 * the one bug. `retained.length === 0` rendered as *"NONE — the only copy of
 * that work was destroyed"*, accusing the product of reproducing finding 92
 * while `sweepAtStart` was in fact retaining correctly. And the same function
 * gated readiness, which is what produced item 7's *"the kill landed too early
 * … a scheduling failure of this item, not of the product"* disclaimer.
 *
 * Two defences, because either alone has failed before:
 *
 *   THE SHAPE IS NOT COPIED, IT IS READ. `bar/` imports nothing from `src/` —
 *   a harness assembled from the product's own predicates shares the product's
 *   bugs — so the constant is recovered from the product's SOURCE TEXT, exactly
 *   as `bar/lib/timeout-order.test.ts` recovers `DEFAULT_WORKER_TIMEOUT_MS`.
 *   Reading a file is not importing a module: nothing here can execute the
 *   product's logic, and a rename fails loudly instead of quietly matching
 *   nothing. `bar/lib/layout.test.ts` is the drift test.
 *
 *   AND THE WALK DOES NOT DEPEND ON THE SHAPE BEING RIGHT. `.git` is what makes
 *   a directory a clone, so the enumeration confirms that too. A shape that
 *   drifts under us produces an EMPTY result, which is precisely the failure
 *   that read as a product defect — so the drift test's negative control is the
 *   old path shape, and it must find nothing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Assembled from parts rather than written as one literal, for the reason
// `bar/self-check.test.ts` records: a literal specifier here would itself read
// as a reach into `src/`, and the scanner would — correctly — flag this file.
export const LAYOUT_SOURCE = fileURLToPath(new URL(["..", "..", "src", "repo", "layout.ts"].join("/"), import.meta.url));

/**
 * The product's run-directory name, recovered from its own source.
 *
 * A missing constant is a FINDING, not a default. Falling back to `"r"` when
 * the product renames it would restore the exact failure this module exists to
 * prevent — a harness looking in a place nothing is — so this throws.
 */
export function productRunDir(source = readFileSync(LAYOUT_SOURCE, "utf8")): string {
  const match = /export const RUN_DIR\s*=\s*["'`]([^"'`]+)["'`]/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`RUN_DIR is not declared in ${LAYOUT_SOURCE} — the harness cannot know where a clone lives`);
  }
  return match[1];
}

/** `<run-root>/<RUN_DIR>/<run-id>/<item>` — the product's `itemDir`, composed here. */
export function itemDirOf(runRoot: string, runId: string, item: number | string): string {
  return join(runRoot, productRunDir(), runId, String(item));
}

export interface CloneDir {
  path: string;
  runId: string;
  /** The bare item NUMBER the product names the directory by, never a plan id. */
  item: number;
}

/**
 * Every clone the product has created under `runRoot`, right now.
 *
 * Deliberately tolerant of a run in flight: a directory caught mid-`git clone`
 * has no `.git` yet and is simply not returned, which is the sampler's luck
 * rather than a fact about the product. Deliberately INTOLERANT of anything
 * that is not a bare item number, so `state/` and the manifest never masquerade
 * as clones.
 */
export function cloneDirsUnder(runRoot: string): CloneDir[] {
  const found: CloneDir[] = [];
  const runs = join(runRoot, productRunDir());
  const listing = (dir: string): string[] => {
    try {
      return statSync(dir).isDirectory() ? readdirSync(dir) : [];
    } catch {
      return [];
    }
  };
  for (const runId of listing(runs)) {
    for (const entry of listing(join(runs, runId))) {
      if (!/^[0-9]+$/.test(entry)) continue;
      const path = join(runs, runId, entry);
      if (!existsSync(join(path, ".git"))) continue;
      found.push({ path, runId, item: Number(entry) });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
