// SPDX-License-Identifier: Apache-2.0
/**
 * The repo map — one per RUN, never one per item.
 *
 * Ruling 22 adopted a token-budgeted repo map on reasoning and required it to
 * prove it pays. Ruling 39 discharged that on 404 real work items across five
 * repositories: **the map pays and is kept**, with three amendments this module
 * implements rather than re-argues.
 *
 *   The budget is ~2K tokens, not ~1K. See `DEFAULT_BUDGET_TOKENS`.
 *
 *   It is built PER RUN. Aider's item-aware ranking fires on only 7–48% of
 *   items, moves the hit rate +0–2.5 points on four of five repositories, and
 *   costs ~11 s PER ITEM. Rejected. `buildRepoMap` takes a repository and a
 *   budget and nothing else — there is no parameter an item's text could enter
 *   through, and `RepoMapOptions` is checked at run time as well as by the type
 *   checker so a JavaScript caller cannot smuggle one in either.
 *
 *   The framing is ruling 70's, and it is a FIELD on the result rather than a
 *   line in this comment, because a caller that reports the map is required to
 *   carry it. See `REPO_MAP_FRAMING`.
 *
 * What it costs when it misses is the whole argument. #23's "the map makes it
 * worse" result did not reproduce and is withdrawn, so a miss costs only the
 * map's own ~1,003 tokens — a cheap lottery ticket, not a retrieval system.
 *
 * MEASURED on this repository against `bun 1.3.14` on 2026-08-18, by #44's own
 * method — every non-merge commit is one work item, the files it touched are
 * that item's target, items touching more than 8 source files are dropped as
 * sweeps rather than items:
 *
 *     162 mappable files, 36 items from 60 commits
 *     budget   files in map   target in map   mean coverage
 *       ~1K       28 of 162       27.8%           13.2%
 *       ~2K       54 of 162       41.7%           23.1%
 *       ~4K      162 of 162      100.0%          100.0%
 *
 * Two things to say about that plainly. The direction agrees with ruling 39 —
 * doubling 1K to 2K bought +13.9 points, the largest single step available, and
 * ~4K is past the knee only because this repository is small enough to fit
 * entirely. The LEVEL disagrees: ruling 39 records 56–59% for small
 * repositories and this one, at 162 mappable files, returned 41.7%. It is a
 * weak disagreement — 36 items against #44's 404, on a repository three days
 * old whose commits are mostly documentation — but it is recorded rather than
 * rounded towards the ruling, and the number a reporter should quote for THIS
 * repository is 41.7%, not 56–59%.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Language } from "web-tree-sitter";
import { Parser, Query } from "web-tree-sitter";

import type { GrammarSpec, LanguageName } from "./grammars.ts";
import { extensionOf, grammarFor, loadGrammar } from "./grammars.ts";
import type { FileFacts } from "./rank.ts";
import { rankFiles } from "./rank.ts";
import { fitToBudget, truncateToBudget } from "./render.ts";
import { DEFAULT_BUDGET_TOKENS, estimateTokens } from "./tokens.ts";

/**
 * Ruling 70, as a string a reporter cannot paraphrase away.
 *
 * The rule it exists to enforce: **8.1% on a 2,014-file repository is the
 * number**, and quoting only the 56–59% small-repository figure would be
 * selecting the flattering half. Both halves are here.
 */
export const REPO_MAP_FRAMING =
  "The repo map is a cheap lottery ticket with a large payout, not a retrieval system. " +
  "MEASURED across 404 real work items on five repositories at #44: at ~1K tokens the item's target is in " +
  "the map 8.1% of the time on a 2,014-file repository and 25.8% on a 2,425-file one, and 56-59% on small " +
  "ones; ruling 39's doubling to ~2K adds +9.3 and +16.7 points on the two large ones, reaching 17.4% and " +
  "42.5%. A hit removed every tool call on both measured vendors; a miss costs only the map's own ~1,003 " +
  "tokens, because #23's \"the map makes it worse\" result did not reproduce and is withdrawn.";

/** Directories that are never a repository's public surface. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

/**
 * Extensions that are source code in SOME language.
 *
 * This list exists so "brigadier cannot read this repository" is DISTINGUISHED
 * from "this repository is mostly JSON". Without it a Ruby project and a
 * documentation site both return an empty map and look identical, which is the
 * silent-failure shape ruling 62 exists to stop.
 */
const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".cxx", ".dart", ".elm", ".erl", ".ex", ".exs", ".fs", ".h", ".hpp",
  ".hs", ".java", ".jl", ".kt", ".kts", ".lua", ".m", ".ml", ".php", ".pl", ".r", ".rb", ".rs",
  ".scala", ".sh", ".sql", ".swift", ".vb", ".zig",
]);

/** Bigger than this is a generated bundle, not a public surface. */
const MAX_FILE_BYTES = 512 * 1024;

/** Identifiers shorter than this are noise: `i`, `id`, `x`. */
const MIN_IDENTIFIER_LENGTH = 3;

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;

export interface UnmappedLanguage {
  /** Extension, leading dot included. */
  readonly extension: string;
  readonly files: number;
}

export interface RepoMapCoverage {
  /** Files walked that a shipped grammar could read. */
  readonly filesParsed: number;
  /** Source files in a language no shipped grammar covers. */
  readonly filesSkippedNoGrammar: number;
  /** Files a grammar covers but that failed to parse or read. */
  readonly filesFailed: number;
  /** Files that reached the map, of `filesParsed`. */
  readonly filesInMap: number;
  /** The languages that were skipped, commonest first. Never silently empty. */
  readonly unmappedLanguages: readonly UnmappedLanguage[];
}

export interface RepoMap {
  /** The brief itself — ruling 16, byte-identical for every worker. */
  readonly text: string;
  /** Files in the map, in rank order. */
  readonly files: readonly string[];
  readonly budgetTokens: number;
  /** Corrected estimate. See `src/repomap/tokens.ts` — `chars / 4` under-counts. */
  readonly estimatedTokens: number;
  /** Raw length, so a caller with a real tokenizer can check the estimate. */
  readonly characters: number;
  readonly coverage: RepoMapCoverage;
  /**
   * Why this map is thinner than the repository, in one sentence, or `null`.
   *
   * Never `null` when the map is empty. A repository in a language with no
   * shipped grammar must fail LOUDLY here rather than return `text: ""`.
   */
  readonly degraded: string | null;
  readonly buildMs: number;
  /** Ruling 70's framing. Report it with the map or do not report the map. */
  readonly framing: string;
}

export interface RepoMapOptions {
  /** Ruling 39's knee. Defaults to `DEFAULT_BUDGET_TOKENS`. */
  readonly budgetTokens?: number;
}

/**
 * The only keys `buildRepoMap` will accept.
 *
 * Ruling 39 rejected per-item ranking on measurement, and a rejection that only
 * the type checker holds is a rejection that survives exactly until someone
 * calls this from JavaScript. An unknown key is a thrown error, not an ignored
 * field.
 */
const ALLOWED_OPTIONS: readonly string[] = ["budgetTokens"];

/**
 * One compiled `Query` per language, not one per file.
 *
 * #23 measured 97% of a 2,425-file map going into parsing, and recompiling the
 * same query a few thousand times is the cheapest part of that to not do.
 */
const queries = new Map<LanguageName, Query>();
function surfaceQuery(grammar: GrammarSpec, language: Language): Query {
  // Keyed on the GRAMMAR, not on the query text. `typescript` and `tsx` share a
  // query string and do not share node type ids, so a cache keyed on the text
  // would run a query compiled against one grammar over the other's tree and
  // silently capture nothing.
  let query = queries.get(grammar.name);
  if (!query) {
    query = new Query(language, grammar.query);
    queries.set(grammar.name, query);
  }
  return query;
}

interface Walked {
  readonly parsable: string[];
  readonly unmapped: Map<string, number>;
}

function walk(root: string): Walked {
  const parsable: string[] = [];
  const unmapped = new Map<string, number>();
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (grammarFor(entry.name)) {
        parsable.push(path);
        continue;
      }
      const extension = extensionOf(entry.name);
      if (SOURCE_EXTENSIONS.has(extension)) unmapped.set(extension, (unmapped.get(extension) ?? 0) + 1);
    }
  }
  parsable.sort();
  return { parsable, unmapped };
}

function describeDegradation(coverage: RepoMapCoverage): string | null {
  const languages = coverage.unmappedLanguages.map((l) => `${l.extension} (${l.files})`).join(", ");
  if (coverage.filesInMap === 0) {
    if (coverage.filesSkippedNoGrammar > 0) {
      return (
        `No map: ${coverage.filesSkippedNoGrammar} source files were found and brigadier ships no ` +
        `grammar for any of them — ${languages}. Nothing here was read.`
      );
    }
    if (coverage.filesParsed === 0) return "No map: no source files were found under this directory.";
    return "No map: every file parsed, but none fitted the token budget.";
  }
  if (coverage.filesSkippedNoGrammar > 0) {
    return (
      `Partial map: ${coverage.filesSkippedNoGrammar} source files are in languages with no shipped ` +
      `grammar and cannot appear — ${languages}.`
    );
  }
  if (coverage.filesFailed > 0) {
    return `Partial map: ${coverage.filesFailed} files a grammar covers could not be read or parsed.`;
  }
  if (coverage.filesInMap < coverage.filesParsed) {
    return (
      `Partial map: ${coverage.filesInMap} of ${coverage.filesParsed} readable files fitted the budget. ` +
      "This is the normal case and is what the budget buys."
    );
  }
  return null;
}

/**
 * Build the run's repo map.
 *
 * One repository, one budget, one map. #23 measured a 2,425-file repository at
 * ~11 s, **97% of it tree-sitter parsing** — which is the cost ruling 39
 * refused to pay per item and is affordable once per run.
 */
export async function buildRepoMap(repoDir: string, options: RepoMapOptions = {}): Promise<RepoMap> {
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) {
      throw new Error(
        `buildRepoMap does not take "${key}". Ruling 39 settled that the repo map is built PER RUN, ` +
          "not per item: item-aware ranking fired on 7-48% of items, moved the hit rate +0-2.5 points " +
          `on four of five repositories, and cost ~11 s per item. Options are: ${ALLOWED_OPTIONS.join(", ")}.`,
      );
    }
  }
  const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  if (!Number.isFinite(budgetTokens) || budgetTokens < 0) {
    throw new Error(`buildRepoMap needs a non-negative budget, got ${String(budgetTokens)}`);
  }

  const started = performance.now();
  const { parsable, unmapped } = walk(repoDir);

  const facts: FileFacts[] = [];
  const symbolsByFile = new Map<string, string[]>();
  let failed = 0;

  for (const absolute of parsable) {
    const grammar = grammarFor(absolute);
    if (!grammar) continue;
    let source: string;
    try {
      if (statSync(absolute).size > MAX_FILE_BYTES) continue;
      source = readFileSync(absolute, "utf8");
    } catch {
      failed++;
      continue;
    }
    // Forward slashes on every platform: ruling 12 makes Windows first class,
    // and a map that renders `src\repomap\map.ts` on one host and
    // `src/repomap/map.ts` on another is not ruling 16's byte-identical brief.
    const path = relative(repoDir, absolute).split(sep).join("/");
    try {
      const language = await loadGrammar(grammar);
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(source);
      if (!tree) {
        failed++;
        parser.delete();
        continue;
      }
      const declares: string[] = [];
      for (const capture of surfaceQuery(grammar, language).captures(tree.rootNode)) {
        const name = capture.node.text;
        if (name.length < MIN_IDENTIFIER_LENGTH) continue;
        declares.push(name);
      }
      tree.delete();
      parser.delete();
      facts.push({ path, declares, mentions: source.match(IDENTIFIER) ?? [] });
      if (declares.length > 0) symbolsByFile.set(path, [...new Set(declares)]);
    } catch {
      failed++;
    }
  }

  const ranked = rankFiles(facts).map((r) => r.path);
  const fitted = fitToBudget(ranked, symbolsByFile, budgetTokens);

  const unmappedLanguages = [...unmapped]
    .map(([extension, files]) => ({ extension, files }))
    .sort((a, b) => (b.files - a.files !== 0 ? b.files - a.files : a.extension.localeCompare(b.extension)));
  const skipped = unmappedLanguages.reduce((total, l) => total + l.files, 0);

  const coverage: RepoMapCoverage = {
    filesParsed: facts.length,
    filesSkippedNoGrammar: skipped,
    filesFailed: failed,
    filesInMap: fitted.files.length,
    unmappedLanguages,
  };
  const degraded = describeDegradation(coverage);

  // An empty map is reported as a SENTENCE, not as an empty string. A caller
  // that prints `text` must not be able to render "nothing here" and "this
  // repository is in a language I cannot read" identically.
  const text =
    fitted.files.length > 0 ? fitted.text : truncateToBudget(degraded ?? "", budgetTokens);

  return {
    text,
    files: fitted.files,
    budgetTokens,
    estimatedTokens: estimateTokens(text),
    characters: text.length,
    coverage,
    degraded,
    buildMs: performance.now() - started,
    framing: REPO_MAP_FRAMING,
  };
}
