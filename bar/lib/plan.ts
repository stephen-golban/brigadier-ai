// SPDX-License-Identifier: Apache-2.0
/**
 * Plans, and the tokens that make a plan's outcome unforgeable.
 *
 * Every plan item carries a TOKEN this harness generates at run time — after
 * the binary under test was built, and never written anywhere the binary can
 * read except the plan itself. An item then asserts that exact token came back
 * out of `git cat-file blob <integration-ref>:<path>`.
 *
 * That is the difference between this file and its first draft. A fixed string
 * can be echoed; a fixed needle in a refusal message can be echoed; the first
 * draft's item 8 was satisfied by `read plan → print it → exit 4`. A token that
 * has to travel plan → worker → commit → merge → object store cannot be echoed
 * by anything that did not do the work.
 *
 * `directive` is the fixture channel and `prompt` is the real one. A real agent
 * gets prose; `bar/fakes/vendor.ts` gets a structured instruction, so the
 * positive control is deterministic rather than a language-model coin toss.
 * A product that reads `directive` instead of `prompt` would be reading a field
 * no real plan has — which is why items assert on the token in the tree and
 * never on the directive.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type Directive =
  /** Write `token` into `path`, relative to the clone. The ordinary case. */
  | { do: "write"; path: string; token: string }
  /** Ask to write OUTSIDE the clone. The lane must deny it. */
  | { do: "escape"; absolutePath: string; token: string }
  /** The same, with a permission payload carrying no locations at all (Codex `edit`). */
  | { do: "escape-blind"; absolutePath: string; token: string }
  /** Plant the three measured git payload shapes in this clone, and commit a receipt. */
  | { do: "plant-git-payloads"; canaryPath: string; receipt: string; token: string }
  /** Read a prerequisite's output and write it on, proving the wave saw it. */
  | { do: "read-then-write"; read: string; path: string; token: string }
  /** Write into this checkout even though the item is read-only. Nothing may reach the branch. */
  | { do: "write-anyway"; path: string; token: string }
  /** Detach a long-lived descendant, so an interrupt has something that escaped. */
  | { do: "escape-process"; heartbeat: string; token: string }
  /** Commit real work, then hang, so an interrupt finds a clone worth retaining. */
  | { do: "commit-then-hang"; path: string; token: string }
  /** Try to delegate back to brigadier. Ruling 57's refusal must fire. */
  | { do: "delegate"; path: string; token: string }
  /** Put the granted secret into a committed file. Ruling 65's redaction sink must catch it. */
  | { do: "leak-secret"; env: string; path: string; token: string };

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

export interface DisjointPlan {
  plan: Plan;
  /** Path in the merged tree → the token that must be in it. */
  expected: Map<string, string>;
  itemIds: string[];
}

/** `n` disjoint write items, each carrying its own token. */
export function disjointPlan(n: number, prefix = "item"): DisjointPlan {
  const expected = new Map<string, string>();
  const items: PlanItem[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `${prefix}-${i}`;
    const path = `${id}.txt`;
    const value = token(id);
    expected.set(path, value);
    items.push({
      id,
      kind: "write",
      paths: [path],
      prompt: `create ${path} containing exactly ${value}`,
      directive: { do: "write", path, token: value },
    });
  }
  return { plan: { version: 1, items }, expected, itemIds: items.map((i) => i.id) };
}

/**
 * #23 measured `chars/4` underestimating a real artifact by 22%, so a report
 * budget checked with the naive formula would be checked against a number known
 * to be too small. The correction is applied here and named where it is used.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.22);
}
