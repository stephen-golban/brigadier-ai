// SPDX-License-Identifier: Apache-2.0
/**
 * The staleness gate.
 *
 * Ruling 62, standard (g). v1 lost four documents to invisible staleness **in
 * one day**, and every instance passed all four gates, because a prompt, a
 * schema description and a document are all just text. The mitigation that
 * actually worked was a full-tree grep for the CLAIM after each wave — not a
 * review of changed files.
 *
 * That distinction is the whole point, and it is structural rather than
 * incidental: **every other check in this design is scoped to changed files**,
 * and this failure class is defined by living in a file nobody touched. Ruling
 * 51's ownership diff cannot catch it. A reviewer reading the diff cannot catch
 * it. Only a full-tree scan for the claim can.
 *
 * For this repository the greppable claims are ruling citations. Every `.ts`
 * file cites the rulings it implements, `BAR.md` carries a coverage row per
 * ruling, and ruling 48 requires that table to be revisited whenever a grilling
 * ticket lands a ruling with a user-visible promise. This makes that
 * requirement mechanical instead of remembered.
 *
 * Deliberately offline: the map is the canonical artifact but it lives on
 * GitHub, and a gate that needs the network is a gate that fails in the wrong
 * way. `BAR.md`'s coverage table is the local shadow of it, and the checks below
 * are the ones that can be made without leaving the tree.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { crossings } from "./forbidden-imports.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const CITATION = /\bruling(?:s)?\s+(\d+(?:\s*(?:,|and|–|-|\/)\s*\d+)*)/gi;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|md)$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every ruling number cited anywhere in the tree, with where it was cited. */
function citations(): Map<number, string[]> {
  const found = new Map<number, string[]>();
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(CITATION)) {
      for (const raw of match[1]!.split(/[,/]|\band\b|[–-]/)) {
        const n = Number(raw.trim());
        if (!Number.isInteger(n) || n < 1) continue;
        const where = found.get(n) ?? [];
        where.push(relative(ROOT, file));
        found.set(n, where);
      }
    }
  }
  return found;
}

/** The ruling numbers `BAR.md`'s coverage table accounts for. */
function coveredRulings(): number[] {
  const bar = readFileSync(join(ROOT, "BAR.md"), "utf8");
  const rows = bar.matchAll(/^\|\s*(\d+)\s+[^|]*\|/gm);
  return [...rows].map((r) => Number(r[1])).sort((a, b) => a - b);
}

const problems: string[] = [];
const covered = coveredRulings();
const highest = covered[covered.length - 1] ?? 0;

// 1. The table is contiguous. A gap is a ruling nobody wrote a row for, which is
//    exactly the "one-line way to make the bar lie" ruling 48 names.
for (let n = 1; n <= highest; n++) {
  if (!covered.includes(n)) problems.push(`BAR.md coverage table has no row for ruling ${n}`);
}

// 2. Nothing cites a ruling the table has never heard of. This is the staleness
//    signal: a ruling landed, code cites it, and the table was not revisited.
for (const [n, where] of [...citations()].sort((a, b) => a[0] - b[0])) {
  if (n > highest) {
    problems.push(
      `ruling ${n} is cited in ${[...new Set(where)].join(", ")} but BAR.md's coverage table stops at ${highest}`,
    );
  }
}

// 3. The table has no duplicate rows.
const seen = new Set<number>();
for (const n of covered) {
  if (seen.has(n)) problems.push(`BAR.md coverage table has two rows for ruling ${n}`);
  seen.add(n);
}

// 4. The seams that must not be crossed — `src/` into `probes/`, and (decision
//    22, made mechanical by ruling 66) the router's competence path into the
//    cost store, in either direction.
const sources = new Map<string, string>();
for (const file of walk(join(ROOT, "src"))) {
  sources.set(relative(ROOT, file), readFileSync(file, "utf8"));
}
for (const crossing of crossings(sources)) {
  problems.push(
    `${crossing.file} imports "${crossing.specifier}" across a forbidden seam — ${crossing.seam.why}`,
  );
}

if (problems.length > 0) {
  console.error("claims gate FAILED\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nRuling 48: the coverage table must be revisited each time a grilling ticket",
  );
  console.error("lands a ruling with a user-visible promise. This is that check.");
  process.exit(1);
}

console.log(`claims gate passed — ${covered.length} rulings covered, highest ${highest}`);
