// SPDX-License-Identifier: Apache-2.0
/**
 * The item set, derived from `BAR.md` at runtime rather than restated here.
 *
 * A blind critic deleted three items AND edited a constant on an adjacent line,
 * and got `10/10 PASS · 0 blocking`, exit 0, no INCOMPLETE line — a fully green
 * release bar on a binary that does nothing. A constant that can be edited
 * beside the thing it guards is not a guard.
 *
 * So the count, the titles and the ruling lists all come from the document that
 * defines them. `BAR.md` is the specification; the register in
 * `bar/items/index.ts` is an implementation of it, and a disagreement in EITHER
 * direction — an item the document has and the register does not, a title that
 * drifted, a ruling list that lost an entry — fails the run before any item is
 * driven. That last case is not hypothetical: the first draft of item 4 listed
 * a different set from `BAR.md`'s own line, and nothing noticed.
 *
 * Deliberately offline and deliberately textual. `scripts/claims.ts` already
 * treats `BAR.md` as the local shadow of the canonical map for the same reason:
 * a gate that needs the network is a gate that fails in the wrong way.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface SpecItem {
  id: number;
  title: string;
  rulings: number[];
}

/** `### 4. Fan-out isolates, and integration merges` */
const HEADING = /^###\s+(\d+)\.\s+(.+?)\s*$/;
/** `*Rulings 19, 14, 7, 13, 33, 16, 9, 2, 39, 49, 50.*` */
const RULINGS = /^\*Rulings?\s+([\d,\s]+)\.\*/;

export function parseSpec(markdown: string): SpecItem[] {
  const items: SpecItem[] = [];
  let current: SpecItem | undefined;

  for (const line of markdown.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading?.[1] && heading[2]) {
      if (current) items.push(current);
      current = { id: Number(heading[1]), title: heading[2], rulings: [] };
      continue;
    }
    if (!current || current.rulings.length > 0) continue;
    const rulings = RULINGS.exec(line);
    if (rulings?.[1]) {
      current.rulings = rulings[1]
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
  }
  if (current) items.push(current);
  return items.sort((a, b) => a.id - b.id);
}

/** The ruling numbers `BAR.md`'s coverage table accounts for. */
export function parseCoverage(markdown: string): number[] {
  return [...markdown.matchAll(/^\|\s*(\d+)\s+[^|]*\|/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
}

export function specPath(): string {
  return fileURLToPath(new URL("../../BAR.md", import.meta.url));
}

export function readSpec(path = specPath()): SpecItem[] {
  if (!existsSync(path)) {
    throw new Error(
      `BAR.md not found at ${path}. The bar derives its item set from the document that defines it; ` +
        `without BAR.md there is nothing to check completeness against.`,
    );
  }
  return parseSpec(readFileSync(path, "utf8"));
}

export interface Disagreement {
  kind: "missing-from-register" | "not-in-spec" | "title" | "rulings";
  id: number;
  detail: string;
}

/**
 * Where the register and the document disagree.
 *
 * Both directions, because "an item BAR.md has that the register lost" and "an
 * item the register invented" are different mistakes and only the first one
 * looks like a mistake.
 */
export function disagreements(
  spec: readonly SpecItem[],
  register: readonly { id: number; title: string; rulings: number[] }[],
): Disagreement[] {
  const found: Disagreement[] = [];
  const byId = new Map(register.map((r) => [r.id, r]));

  for (const item of spec) {
    const registered = byId.get(item.id);
    if (!registered) {
      found.push({
        kind: "missing-from-register",
        id: item.id,
        detail: `BAR.md defines item ${item.id} "${item.title}" and bar/items/index.ts does not register it`,
      });
      continue;
    }
    if (registered.title !== item.title) {
      found.push({
        kind: "title",
        id: item.id,
        detail: `item ${item.id} title: BAR.md says ${JSON.stringify(item.title)}, the register says ${JSON.stringify(registered.title)}`,
      });
    }
    const expected = [...item.rulings].sort((a, b) => a - b).join(",");
    const actual = [...registered.rulings].sort((a, b) => a - b).join(",");
    if (expected !== actual) {
      found.push({
        kind: "rulings",
        id: item.id,
        detail: `item ${item.id} rulings: BAR.md says [${expected}], the register says [${actual}]`,
      });
    }
  }

  for (const registered of register) {
    if (!spec.some((s) => s.id === registered.id)) {
      found.push({
        kind: "not-in-spec",
        id: registered.id,
        detail: `bar/items/index.ts registers item ${registered.id} "${registered.title}" and BAR.md has no such heading`,
      });
    }
  }

  return found.sort((a, b) => a.id - b.id);
}
