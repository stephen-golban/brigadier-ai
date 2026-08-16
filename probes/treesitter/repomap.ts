/**
 * Probe — ticket #23. A rough Aider-style repo map, built to be measured.
 *
 * tree-sitter parse -> exported symbols -> PageRank over the reference graph ->
 * binary-search to a fixed token budget. Deliberately simplified: no edge-weight
 * multipliers, no "files already in context" boost. It exists to answer two
 * questions — what does building one cost, and does shipping one change how much
 * an agent explores — not to be the implementation.
 *
 * Usage: bun repomap.ts <repo-dir> [token-budget]
 */

import { Language, Parser, Query } from "web-tree-sitter";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname, relative } from "node:path";

import runtimeWasm from "./node_modules/web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import wTs from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import wTsx from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import wJs from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import wPy from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" with { type: "file" };
import wGo from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm" with { type: "file" };
import wRs from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm" with { type: "file" };

const repo = Bun.argv[2];
const BUDGET = Number(Bun.argv[3] ?? 1024);
if (!repo) { console.error("usage: bun repomap.ts <repo-dir> [token-budget]"); process.exit(2); }

const GRAMMARS: Record<string, string> = {
  ".ts": wTs, ".mts": wTs, ".cts": wTs,
  ".tsx": wTsx, ".jsx": wTsx,
  ".js": wJs, ".mjs": wJs, ".cjs": wJs,
  ".py": wPy, ".go": wGo, ".rs": wRs,
};

// EXPORTED symbols only — decision 22 says "each file's exported symbols", and
// the distinction is not cosmetic. A first version of this also captured
// `variable_declarator`, which makes every local `const result = …` a
// definition; `result` then appeared to be declared in hundreds of files, the
// graph blew up to 1.34M edges, and the top-ranked output was test files listing
// `result, data, row, from`. A bad map would have reversed ruling 22 on the
// strength of a bug in the probe.
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
  [wTs]: TS_EXPORTS,
  [wTsx]: TS_EXPORTS,
  [wJs]: JS_EXPORTS,
  // Module-level only: an inner def is not the file's public surface.
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
const loadLang = async (path: string) => {
  if (!langCache.has(path)) {
    langCache.set(path, await Language.load(new Uint8Array(await Bun.file(path).arrayBuffer())));
  }
  return langCache.get(path);
};

// -------------------------------------------------------------------- walk
const files: string[] = [];
let skippedNoGrammar = 0;
const walk = (dir: string) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") { if (SKIP.has(e.name)) continue; }
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); }
    else if (e.isFile()) {
      if (GRAMMARS[extname(e.name)]) files.push(p);
      else if (/\.(rb|java|cs|cpp|c|h|php|swift|kt|scala|ex|erl|hs|lua|sh)$/.test(e.name)) skippedNoGrammar++;
    }
  }
};
walk(repo);
const tWalk = performance.now();

// ---------------------------------------------------------------- parse
// definitions: symbol -> files that declare it
const defs = new Map<string, Set<string>>();
// per-file token stream, for the reference pass
const fileIdents = new Map<string, string[]>();
let parsedBytes = 0;
let parseErrors = 0;

for (const f of files) {
  let src: string;
  try {
    const st = statSync(f);
    if (st.size > 512 * 1024) continue;      // a generated bundle is not a public surface
    src = readFileSync(f, "utf8");
  } catch { continue; }
  parsedBytes += src.length;
  const gpath = GRAMMARS[extname(f)];
  try {
    const lang = await loadLang(gpath);
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(src);
    if (!tree) { parseErrors++; continue; }
    const rel = relative(repo, f);
    for (const c of new Query(lang, QUERIES[gpath]).captures(tree.rootNode)) {
      const name = c.node.text;
      if (name.length < 3) continue;          // i, id, x are noise
      if (!defs.has(name)) defs.set(name, new Set());
      defs.get(name)!.add(rel);
    }
    // Cheap identifier stream for the reference edges.
    fileIdents.set(rel, src.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []);
    tree.delete?.();
    parser.delete?.();
  } catch { parseErrors++; }
}
const tParse = performance.now();

// ------------------------------------------------------ reference graph
// Edge file A -> file B when A mentions a symbol B declares. This is Aider's
// shape: rank flows to the files whose symbols other files depend on.
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
      if (target === file) continue;         // self-reference carries no signal
      const to = index.get(target);
      if (to === undefined) continue;
      outEdges[from].set(to, (outEdges[from].get(to) ?? 0) + count);
    }
  }
}
const tGraph = performance.now();

// ------------------------------------------------------------- PageRank
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
const tRank = performance.now();

// ------------------------------------------------- render to a budget
const ranked = nodes.map((n, i) => ({ file: n, rank: rank[i] })).sort((a, b) => b.rank - a.rank);
const symbolsByFile = new Map<string, string[]>();
for (const [sym, fs] of defs) for (const f of fs) {
  if (!symbolsByFile.has(f)) symbolsByFile.set(f, []);
  symbolsByFile.get(f)!.push(sym);
}

// chars/4 is the budgeting estimator; its error is measured separately.
const estTokens = (s: string) => Math.ceil(s.length / 4);
const render = (topN: number) =>
  ranked.slice(0, topN).map((r) => {
    const syms = (symbolsByFile.get(r.file) ?? []).slice(0, 12);
    return syms.length ? `${r.file}:\n  ${syms.join(", ")}` : r.file;
  }).join("\n");

// Binary search for the largest prefix that fits, exactly as Aider does.
let lo = 0, hi = ranked.length, best = "";
while (lo <= hi) {
  const mid = (lo + hi) >> 1;
  const text = render(mid);
  if (estTokens(text) <= BUDGET) { best = text; lo = mid + 1; } else { hi = mid - 1; }
}
const tDone = performance.now();

const out = Bun.argv.includes("--emit");
if (out) { console.log(best); process.exit(0); }

console.error(`repo             ${repo}`);
console.error(`files-parsed     ${files.length}  (${(parsedBytes / 1048576).toFixed(1)} MB)`);
console.error(`files-no-grammar ${skippedNoGrammar}`);
console.error(`parse-errors     ${parseErrors}`);
console.error(`symbols          ${defs.size}`);
console.error(`graph-nodes      ${N}  edges ${outEdges.reduce((a, e) => a + e.size, 0)}`);
console.error(`--- wall clock ---`);
console.error(`init             ${(performance.now() - performance.now() + (tWalk - t0)).toFixed(0)}ms (init+walk)`);
console.error(`parse            ${(tParse - tWalk).toFixed(0)}ms`);
console.error(`graph            ${(tGraph - tParse).toFixed(0)}ms`);
console.error(`pagerank         ${(tRank - tGraph).toFixed(0)}ms`);
console.error(`budget-search    ${(tDone - tRank).toFixed(0)}ms`);
console.error(`TOTAL            ${(tDone - t0).toFixed(0)}ms`);
console.error(`--- output ---`);
console.error(`map-chars        ${best.length}   est-tokens ${estTokens(best)} / budget ${BUDGET}`);
console.error(`map-files        ${best.split("\n").filter((l) => l.endsWith(":")).length}`);
