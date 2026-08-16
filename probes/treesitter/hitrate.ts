/**
 * Probe — ticket #44. How often does a work item's target actually land in the
 * repo map, and does a bigger budget or an item-aware ranking change it?
 *
 * #23 measured the map's effect in both directions and got opposite signs:
 * target in the map -> 24 tool calls became 0; target NOT in the map -> 15
 * became 25. So the economics are decided by the HIT RATE, and #23 measured
 * that on exactly two hand-picked items.
 *
 * The expensive way to measure a hit rate is to run agents. The cheap way is to
 * notice that a repository already contains a large, unbiased sample of real
 * work items: its own commits. Each non-merge commit is one unit of work, and
 * the files it modified are that item's target. That gives hundreds of items per
 * repository for the cost of a `git log`, and it is not hand-picked.
 *
 * Measured per repository, per budget:
 *   anyHit    >= 1 of the item's target files appears in the map  (case A of #23)
 *   allHit    every target file appears                           (the strong form)
 *   coverage  mean fraction of an item's target files in the map
 *
 * And in two ranking modes:
 *   pagerank    the map as #23 built it — one map per repo, item-blind
 *   item-aware  Aider weights identifiers mentioned in the current context 10x.
 *               #23 implemented neither multiplier. Here the item's commit
 *               subject stands in for its brief, and files defining a symbol the
 *               subject mentions are boosted.
 *
 * Two honesty notes that bound what this can claim:
 *   - A commit subject is a PROXY for a work order and a thin one. A real brief
 *     names acceptance criteria and owned paths, so the item-aware column here
 *     is a lower bound on what a real brief could do.
 *   - The boost is a post-hoc multiplier on the final rank, NOT Aider's
 *     edge-weight multiplier re-run through PageRank. Cheaper, and the direction
 *     should match; the magnitude should not be quoted as Aider's.
 *   - Files a commit touched that no longer exist at HEAD are excluded and
 *     counted, because the map is built from HEAD and could not contain them.
 *
 * Usage: bun hitrate.ts <repo-dir> [--items N] [--budgets 1024,2048,4096,8192]
 */

import { Language, Parser, Query } from "web-tree-sitter";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";

import runtimeWasm from "./node_modules/web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import wTs from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import wTsx from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import wJs from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import wPy from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" with { type: "file" };
import wGo from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm" with { type: "file" };
import wRs from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm" with { type: "file" };

const repo = Bun.argv[2];
if (!repo) { console.error("usage: bun hitrate.ts <repo-dir> [--items N] [--budgets a,b,c]"); process.exit(2); }
const arg = (n: string, d: string) => {
  const i = Bun.argv.indexOf(`--${n}`);
  return i === -1 ? d : (Bun.argv[i + 1] ?? d);
};
const MAX_ITEMS = Number(arg("items", "150"));
const BUDGETS = arg("budgets", "1024,2048,4096,8192").split(",").map(Number);
// A 200-file sweep is not a work item; decision 19's items are scoped units.
const MAX_FILES_PER_ITEM = Number(arg("max-files", "8"));

// The pipeline below is deliberately a copy of repomap.ts rather than a shared
// import: repomap.ts is the artefact #23's numbers were measured against and is
// left byte-stable so those numbers stay reproducible.
const GRAMMARS: Record<string, string> = {
  ".ts": wTs, ".mts": wTs, ".cts": wTs,
  ".tsx": wTsx, ".jsx": wTsx,
  ".js": wJs, ".mjs": wJs, ".cjs": wJs,
  ".py": wPy, ".go": wGo, ".rs": wRs,
};
const TS_EXPORTS = `
  (export_statement declaration: (function_declaration name:(identifier) @d))
  (export_statement declaration: (class_declaration name:(type_identifier) @d))
  (export_statement declaration: (interface_declaration name:(type_identifier) @d))
  (export_statement declaration: (type_alias_declaration name:(type_identifier) @d))
  (export_statement declaration: (lexical_declaration (variable_declarator name:(identifier) @d)))
  (export_statement declaration: (variable_declaration (variable_declarator name:(identifier) @d)))`;
const JS_EXPORTS = `
  (export_statement declaration: (function_declaration name:(identifier) @d))
  (export_statement declaration: (class_declaration name:(identifier) @d))
  (export_statement declaration: (lexical_declaration (variable_declarator name:(identifier) @d)))
  (export_statement declaration: (variable_declaration (variable_declarator name:(identifier) @d)))`;
const QUERIES: Record<string, string> = {
  [wTs]: TS_EXPORTS, [wTsx]: TS_EXPORTS, [wJs]: JS_EXPORTS,
  [wPy]: `(module (function_definition name:(identifier) @d)) (module (class_definition name:(identifier) @d))`,
  [wGo]: `(source_file (function_declaration name:(identifier) @d))
          (source_file (type_declaration (type_spec name:(type_identifier) @d)))`,
  [wRs]: `(source_file (function_item name:(identifier) @d)) (source_file (struct_item name:(type_identifier) @d))
          (source_file (enum_item name:(type_identifier) @d)) (source_file (trait_item name:(type_identifier) @d))`,
};
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "vendor",
                      "target", "__pycache__", ".venv", "coverage", ".turbo"]);

const t0 = performance.now();
await Parser.init({ locateFile: () => runtimeWasm });
const langCache = new Map<string, any>();
const loadLang = async (p: string) => {
  if (!langCache.has(p)) langCache.set(p, await Language.load(new Uint8Array(await Bun.file(p).arrayBuffer())));
  return langCache.get(p);
};

const files: string[] = [];
const walk = (dir: string) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && GRAMMARS[extname(e.name)]) files.push(p);
  }
};
walk(repo);

const defs = new Map<string, Set<string>>();
const fileIdents = new Map<string, string[]>();
for (const f of files) {
  let src: string;
  try { if (statSync(f).size > 512 * 1024) continue; src = readFileSync(f, "utf8"); } catch { continue; }
  const gpath = GRAMMARS[extname(f)];
  try {
    const lang = await loadLang(gpath);
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(src);
    if (!tree) continue;
    const rel = relative(repo, f);
    for (const c of new Query(lang, QUERIES[gpath]).captures(tree.rootNode)) {
      const name = c.node.text;
      if (name.length < 3) continue;
      if (!defs.has(name)) defs.set(name, new Set());
      defs.get(name)!.add(rel);
    }
    fileIdents.set(rel, src.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []);
    tree.delete?.(); parser.delete?.();
  } catch { /* unparseable file is not a map entry */ }
}

const nodes = [...fileIdents.keys()];
const index = new Map(nodes.map((n, i) => [n, i]));
const outEdges: Array<Map<number, number>> = nodes.map(() => new Map());
for (const [file, idents] of fileIdents) {
  const from = index.get(file)!;
  const seen = new Map<string, number>();
  for (const id of idents) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const [id, count] of seen) {
    const declaring = defs.get(id);
    if (!declaring) continue;
    for (const target of declaring) {
      if (target === file) continue;
      const to = index.get(target);
      if (to === undefined) continue;
      outEdges[from].set(to, (outEdges[from].get(to) ?? 0) + count);
    }
  }
}
const N = nodes.length;
let rank = new Array(N).fill(1 / Math.max(N, 1));
const D = 0.85;
for (let iter = 0; iter < 20; iter++) {
  const next = new Array(N).fill((1 - D) / Math.max(N, 1));
  for (let i = 0; i < N; i++) {
    const edges = outEdges[i];
    let total = 0;
    for (const w of edges.values()) total += w;
    if (total === 0) { for (let j = 0; j < N; j++) next[j] += (D * rank[i]) / N; continue; }
    for (const [j, w] of edges) next[j] += (D * rank[i] * w) / total;
  }
  rank = next;
}
const tBuilt = performance.now();

const symbolsByFile = new Map<string, string[]>();
for (const [sym, fs] of defs) for (const f of fs) {
  if (!symbolsByFile.has(f)) symbolsByFile.set(f, []);
  symbolsByFile.get(f)!.push(sym);
}
const estTokens = (s: string) => Math.ceil(s.length / 4);
const renderFrom = (ordered: string[], topN: number) =>
  ordered.slice(0, topN).map((f) => {
    const syms = (symbolsByFile.get(f) ?? []).slice(0, 12);
    return syms.length ? `${f}:\n  ${syms.join(", ")}` : f;
  }).join("\n");

// The set of files a given budget actually admits, for a given ordering.
const admitted = (ordered: string[], budget: number): Set<string> => {
  let lo = 0, hi = ordered.length, bestN = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (estTokens(renderFrom(ordered, mid)) <= budget) { bestN = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return new Set(ordered.slice(0, bestN));
};

const baseOrder = nodes.map((n, i) => ({ file: n, r: rank[i] }))
  .sort((a, b) => b.r - a.r).map((x) => x.file);
const baseRank = new Map(nodes.map((n, i) => [n, rank[i]]));

// ------------------------------------------------------------- work items
// Real items, from the repository's own history. --no-merges because a merge
// touches everything and represents no unit of work.
const log = Bun.spawnSync(
  ["git", "-C", repo, "log", "--no-merges", "-n", String(MAX_ITEMS * 3),
   "--pretty=format:%H%x00%s", "--name-only"],
  { stdout: "pipe", stderr: "pipe" },
);
const raw = new TextDecoder().decode(log.stdout);

type Item = { sha: string; subject: string; targets: string[] };
const items: Item[] = [];
let droppedGone = 0, droppedTooBig = 0, droppedNoSource = 0;

for (const block of raw.split(/\n(?=[0-9a-f]{40}\x00)/)) {
  const lines = block.split("\n");
  const [sha, subject] = (lines.shift() ?? "").split("\x00");
  if (!sha) continue;
  const touched = lines.map((l) => l.trim()).filter(Boolean)
    .filter((p) => GRAMMARS[extname(p)]);
  if (!touched.length) { droppedNoSource++; continue; }
  if (touched.length > MAX_FILES_PER_ITEM) { droppedTooBig++; continue; }
  // The map is built from HEAD; a file that no longer exists could never appear
  // in it, and counting it as a miss would understate the map for free.
  const alive = touched.filter((p) => existsSync(join(repo, p)) && fileIdents.has(p));
  if (!alive.length) { droppedGone++; continue; }
  items.push({ sha, subject: subject ?? "", targets: alive });
  if (items.length >= MAX_ITEMS) break;
}

// ------------------------------------------------------- item-aware order
// Aider boosts identifiers mentioned in the current context. The subject line
// stands in for the brief. Path substrings are deliberately NOT matched: that
// would let a commit message naming a file trivially retrieve it, which
// measures the message, not the ranking.
const itemAwareOrder = (subject: string): string[] => {
  const mentioned = new Set((subject.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []));
  const boost = new Map<string, number>();
  for (const m of mentioned) {
    const declaring = defs.get(m);
    if (!declaring) continue;
    for (const f of declaring) boost.set(f, (boost.get(f) ?? 0) + 1);
  }
  if (!boost.size) return baseOrder;
  return nodes.slice().sort((a, b) =>
    (baseRank.get(b)! * (1 + 10 * (boost.get(b) ?? 0))) -
    (baseRank.get(a)! * (1 + 10 * (boost.get(a) ?? 0))));
};

// ------------------------------------------------------------------ report
console.log(`repo              ${repo}`);
console.log(`map nodes         ${N} files, ${defs.size} symbols, built in ${(tBuilt - t0).toFixed(0)}ms`);
console.log(`items             ${items.length} (dropped: ${droppedTooBig} too-broad, ${droppedNoSource} no-source, ${droppedGone} files-gone)`);
if (!items.length) { console.log("NO ITEMS — nothing measured here."); process.exit(0); }

// Without this, an item-aware column identical to the baseline is ambiguous
// between "the boost changed nothing" and "the boost never fired" — which is
// the guard-that-always-passes shape. Report how often it could possibly apply.
let itemsWithMention = 0, boostedFilesTotal = 0;
for (const it of items) {
  const mentioned = new Set(it.subject.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []);
  let n = 0;
  for (const m of mentioned) n += defs.get(m)?.size ?? 0;
  if (n > 0) { itemsWithMention++; boostedFilesTotal += n; }
}
console.log(`item-aware fires  ${itemsWithMention}/${items.length} items had a subject naming a mapped symbol ` +
            `(${(100 * itemsWithMention / items.length).toFixed(1)}%), ${boostedFilesTotal} file-boosts total`);
if (itemsWithMention === 0) {
  console.log("  !! the item-aware column below is NOT a measurement of ranking — the boost never fired.");
}
console.log("");
console.log("budget  mode        mapFiles  anyHit   allHit   coverage");

for (const budget of BUDGETS) {
  const baseAdmitted = admitted(baseOrder, budget);
  for (const mode of ["pagerank", "item-aware"] as const) {
    let any = 0, all = 0, cov = 0;
    for (const it of items) {
      const set = mode === "pagerank" ? baseAdmitted : admitted(itemAwareOrder(it.subject), budget);
      const hits = it.targets.filter((t) => set.has(t)).length;
      if (hits > 0) any++;
      if (hits === it.targets.length) all++;
      cov += hits / it.targets.length;
    }
    const n = items.length;
    console.log(
      `${String(budget).padStart(6)}  ${mode.padEnd(11)} ${String(baseAdmitted.size).padStart(8)}  ` +
      `${(100 * any / n).toFixed(1).padStart(5)}%  ${(100 * all / n).toFixed(1).padStart(6)}%  ` +
      `${(100 * cov / n).toFixed(1).padStart(7)}%`,
    );
  }
}

console.log("");
console.log("anyHit is #23's case A — the map contained something the item needed.");
console.log("1 - anyHit is #23's case B, where the map MADE EXPLORATION WORSE (15 -> 25 tool calls).");
console.log("mapFiles is for the pagerank ordering; the item-aware ordering admits a similar count.");
