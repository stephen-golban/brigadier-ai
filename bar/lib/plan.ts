// SPDX-License-Identifier: Apache-2.0
/**
 * Plans that do not contain their own answers.
 *
 * The previous version put the value the merged tree had to carry directly in
 * the plan — `directive.token`, and again in the prompt as *"create alpha.txt
 * containing exactly tok-…"*. A forger that did no work at all scored 12 of 13
 * by echoing it back through `git hash-object` and `commit-tree`. The harness
 * was handing over the answer key and then checking whether the binary could
 * read.
 *
 * Every directive below therefore names a PLACE TO READ and a TRANSFORMATION,
 * never a value. The nonce lives only in the cloned repository's content, so the
 * output is reachable only from a clone — or from a faithful reconstruction of
 * the base commit, which means implementing ruling 33 (HEAD plus uncommitted
 * tracked plus untracked) and ruling 50 (nothing gitignored). That is the
 * intended cost: the cheapest forgery should have to implement the promise.
 *
 * `directive` is the fixture channel and `prompt` is the real one. A real agent
 * gets prose; `bar/fakes/vendor.ts` gets a structured instruction so the
 * positive control is deterministic rather than a language-model coin toss.
 * Neither ever carries the expected output.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { derive } from "./derive.ts";

export type Directive =
  /** Read a nonce from the clone, hash it with `salt`, write the result. */
  | { do: "derive-write"; read: string; path: string; salt: string }
  /** Ask to write OUTSIDE the clone. The lane must deny it. */
  | { do: "escape"; absolutePath: string }
  /** The same, with a permission payload carrying no locations (Codex `edit`). */
  | { do: "escape-blind"; absolutePath: string }
  /** Copy committed payload bytes into `.git`, then prove the clone was read. */
  | { do: "plant-git-payloads"; from: string; read: string; path: string; salt: string }
  /** Read a prerequisite's OUTPUT — a value that existed only in wave 1's commit. */
  | { do: "read-then-write"; read: string; path: string; salt: string }
  /** Write into this checkout even though the item is read-only. */
  | { do: "write-anyway"; path: string; token: string }
  /** Detach a long-lived descendant that publishes its pid. */
  | { do: "escape-process"; heartbeat: string; pidFile: string }
  /** Commit real work, then hang, so an interrupt finds a clone worth retaining. */
  | { do: "commit-then-hang"; read: string; path: string; salt: string }
  /** Try to delegate back to brigadier. Ruling 57's refusal must fire. */
  | { do: "delegate"; read: string; path: string; salt: string }
  /** Prove the granted secret arrived (a hash of it), then leak it (the value). */
  | { do: "leak-secret"; env: string; path: string; proofPath: string; salt: string };

export interface PlanItem {
  id: string;
  kind: "write" | "read-only";
  paths?: string[];
  prompt: string;
  directive?: Directive;
  dependsOn?: string[];
  verify?: string;
  requires?: string[];
  difficulty?: "easy" | "medium" | "hard";
}

export interface Plan {
  version: 1;
  items: PlanItem[];
}

/** Unguessable, and generated after the artifact under test was built. */
export function token(label = "tok"): string {
  return `${label}-${randomBytes(9).toString("hex")}`;
}

export function writePlan(dir: string, plan: Plan, name = "plan.json"): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

export interface SeededPlan {
  plan: Plan;
  /** Files to plant in the repository, and how. The nonces live only here. */
  seeds: Array<{ path: string; value: string; placement: "committed" | "uncommitted-tracked" | "untracked" }>;
  /** Path in the merged tree → the value that must be in it. Derived, never handed over. */
  expected: Map<string, string>;
  itemIds: string[];
}

/**
 * `n` disjoint write items, each reading its own nonce out of the clone.
 *
 * The placements rotate deliberately. Ruling 33 repairs ruling 7 by carrying the
 * owner's uncommitted TRACKED and UNTRACKED work into every clone, and a plan
 * whose nonces were all committed would never notice a product that dropped
 * either — which is the exact mechanism ruling 7 lost.
 */
export function disjointPlan(n: number, prefix = "item"): SeededPlan {
  const placements = ["committed", "uncommitted-tracked", "untracked"] as const;
  const seeds: SeededPlan["seeds"] = [];
  const expected = new Map<string, string>();
  const items: PlanItem[] = [];

  for (let i = 1; i <= n; i++) {
    const id = `${prefix}-${i}`;
    const seedPath = `seeds/${id}.seed`;
    const outPath = `${id}.txt`;
    const value = token(`seed-${id}`);
    const placement = placements[(i - 1) % placements.length] ?? "committed";
    seeds.push({ path: seedPath, value, placement });
    expected.set(outPath, derive(value, id));
    items.push({
      id,
      kind: "write",
      paths: [outPath],
      prompt: `read ${seedPath} from your checkout, take sha256("<its contents>:${id}") and write the first 24 hex characters into ${outPath}`,
      directive: { do: "derive-write", read: seedPath, path: outPath, salt: id },
    });
  }

  return { plan: { version: 1, items }, seeds, expected, itemIds: items.map((i) => i.id) };
}

/**
 * #23 measured `chars/4` underestimating a real artifact by 22%, so a report
 * budget checked with the naive formula would be checked against a number known
 * to be too small. The correction is applied here and named where it is used.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.22);
}
