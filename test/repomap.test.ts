// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 39, and ruling 62b's rule that every guard needs a demonstrated
 * negative. Four properties, each asserted from both directions:
 *
 *   the budget is respected AS THE MAP GROWS — and the repositories it is
 *   asserted on are ones whose full rendering really does overflow, so the
 *   check cannot pass by never being tested;
 *
 *   a repository in a language with no shipped grammar DEGRADES VISIBLY — and
 *   the same assertion run on a repository brigadier can read comes back
 *   clean, so "degraded" is not a field that is always set;
 *
 *   the map is PER RUN — an option an item could ride in on is rejected at run
 *   time as well as by the type checker, and the option that is allowed is
 *   accepted;
 *
 *   ruling 70's framing carries the UNFLATTERING number — checked with a
 *   predicate that is shown rejecting a framing which quotes only the
 *   small-repository figure.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  DEFAULT_BUDGET_TOKENS,
  REPO_MAP_FRAMING,
  UNDERCOUNT_CORRECTION,
  buildRepoMap,
  estimateTokens,
} from "../src/repomap/index.ts";
import { fitToBudget, renderMap } from "../src/repomap/render.ts";
import { rankFiles } from "../src/repomap/rank.ts";

const REPO = new URL("..", import.meta.url).pathname;
const scratch: string[] = [];

function temporaryRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `brigadier-repomap-${prefix}-`));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * A synthetic TypeScript repository of `count` files, each exporting symbols
 * the next file imports, so PageRank has a real graph rather than a heap of
 * unrelated nodes.
 */
function typescriptRepo(count: number): string {
  const dir = temporaryRepo("ts");
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < count; i++) {
    const exported = [`alpha${i}`, `beta${i}`, `gamma${i}`, `delta${i}`];
    const uses = i > 0 ? `import { alpha${i - 1} } from "./module${i - 1}.ts";\nvoid alpha${i - 1};\n` : "";
    writeFileSync(
      join(dir, "src", `module${i}.ts`),
      `${uses}${exported.map((name) => `export function ${name}(): number { return ${i}; }`).join("\n")}\n`,
    );
  }
  return dir;
}

describe("the interface is a repository and a budget, and nothing else", () => {
  test("buildRepoMap defaults to ruling 39's knee", async () => {
    const map = await buildRepoMap(typescriptRepo(40));
    expect(map.budgetTokens).toBe(DEFAULT_BUDGET_TOKENS);
    expect(DEFAULT_BUDGET_TOKENS).toBe(2_000);
  });

  test("an option an item could ride in on is refused at run time", async () => {
    // Ruling 39 rejected item-aware ranking on measurement. The type checker
    // holds that for TypeScript callers; this holds it for everyone else.
    await expect(
      buildRepoMap(REPO, { item: "fix the sweep" } as unknown as { budgetTokens: number }),
    ).rejects.toThrow(/does not take "item"/);
  });

  test("and the type checker refuses it too", async () => {
    // @ts-expect-error — ruling 39: there is no per-item door. If this ever
    // stops being an error, `tsc --noEmit` fails here rather than silently
    // letting the option through.
    const rejected = buildRepoMap(REPO, { item: "fix the sweep" });
    await expect(rejected).rejects.toThrow();
  });

  test("the allowed option is accepted — the guard is not refusing everything", async () => {
    const map = await buildRepoMap(typescriptRepo(20), { budgetTokens: 500 });
    expect(map.budgetTokens).toBe(500);
  });

  test("a negative budget is refused", async () => {
    await expect(buildRepoMap(REPO, { budgetTokens: -1 })).rejects.toThrow(/non-negative/);
  });

  test("the same repository maps to the same bytes twice running", async () => {
    // Ruling 16: byte-identical for every worker. A map that reshuffles between
    // two identical runs is indistinguishable from one that noticed a change.
    const dir = typescriptRepo(60);
    const first = await buildRepoMap(dir);
    const second = await buildRepoMap(dir);
    expect(second.text).toBe(first.text);
    expect(second.files).toEqual(first.files);
  });
});

describe("the budget is respected as the map grows", () => {
  test("across four budgets on this repository, which really does overflow all of them", async () => {
    for (const budgetTokens of [250, 500, 1_000, 2_000]) {
      const map = await buildRepoMap(REPO, { budgetTokens });
      expect(map.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
      // The negative half: prove there was something to cut. If the whole
      // repository fitted, the assertion above would pass on an empty budget.
      expect(map.coverage.filesInMap).toBeLessThan(map.coverage.filesParsed);
    }
  });

  test("and as the repository grows under a fixed budget", async () => {
    const budgetTokens = 400;
    let previousParsed = 0;
    let sawOverflow = false;
    for (const count of [5, 25, 100]) {
      const map = await buildRepoMap(typescriptRepo(count), { budgetTokens });
      expect(map.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
      expect(map.coverage.filesParsed).toBeGreaterThan(previousParsed);
      previousParsed = map.coverage.filesParsed;
      if (map.coverage.filesInMap < map.coverage.filesParsed) sawOverflow = true;
    }
    // Demonstrated negative: at least one of those repositories was too big for
    // the budget, so "respected" was tested rather than assumed.
    expect(sawOverflow).toBe(true);
  });

  test("the fitter's own negative — one more file than it admitted does not fit", () => {
    const symbols = new Map<string, string[]>();
    const ordered: string[] = [];
    for (let i = 0; i < 200; i++) {
      const path = `src/module${String(i).padStart(3, "0")}.ts`;
      ordered.push(path);
      symbols.set(path, ["alpha", "beta", "gamma", "delta", "epsilon"]);
    }
    const fitted = fitToBudget(ordered, symbols, 300);
    expect(fitted.files.length).toBeGreaterThan(0);
    expect(fitted.files.length).toBeLessThan(ordered.length);
    expect(estimateTokens(fitted.text)).toBeLessThanOrEqual(300);
    // One more would have blown it. Without this the binary search could be
    // returning any prefix at all and the test above would still pass.
    expect(estimateTokens(renderMap(ordered, symbols, fitted.files.length + 1))).toBeGreaterThan(300);
  });

  test("the estimator corrects chars/4 upward rather than trusting it", () => {
    const text = "a".repeat(4_000);
    expect(estimateTokens(text)).toBeGreaterThan(1_000);
    expect(estimateTokens(text)).toBe(Math.ceil(1_000 * UNDERCOUNT_CORRECTION));
  });
});

describe("a language with no grammar degrades visibly", () => {
  test("a Ruby repository says so instead of returning an empty map", async () => {
    const dir = temporaryRepo("ruby");
    mkdirSync(join(dir, "lib"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(dir, "lib", `thing${i}.rb`), `class Thing${i}\n  def call\n    ${i}\n  end\nend\n`);
    }
    writeFileSync(join(dir, "lib", "helper.swift"), "func helper() -> Int { return 1 }\n");

    const map = await buildRepoMap(dir);
    expect(map.files).toEqual([]);
    expect(map.coverage.filesParsed).toBe(0);
    expect(map.coverage.filesSkippedNoGrammar).toBe(13);
    expect(map.coverage.unmappedLanguages).toEqual([
      { extension: ".rb", files: 12 },
      { extension: ".swift", files: 1 },
    ]);
    expect(map.degraded).toContain(".rb");
    // The point of the whole check: the caller cannot print nothing.
    expect(map.text.length).toBeGreaterThan(0);
    expect(map.text).toContain("no grammar");
  });

  test("an empty directory is a different sentence, not the same silence", async () => {
    const map = await buildRepoMap(temporaryRepo("empty"));
    expect(map.degraded).toContain("no source files");
    expect(map.degraded).not.toContain("grammar");
  });

  test("and a repository brigadier can read does NOT claim it was unreadable", async () => {
    // Demonstrated negative for the guard above: `degraded` is not a field that
    // is always set to something alarming.
    const map = await buildRepoMap(typescriptRepo(8), { budgetTokens: 4_000 });
    expect(map.coverage.filesSkippedNoGrammar).toBe(0);
    expect(map.coverage.unmappedLanguages).toEqual([]);
    expect(map.degraded).toBeNull();
    expect(map.files.length).toBe(8);
  });

  test("a mixed repository names what it could not read while still mapping the rest", async () => {
    const dir = typescriptRepo(10);
    writeFileSync(join(dir, "src", "legacy.rb"), "class Legacy\nend\n");
    const map = await buildRepoMap(dir, { budgetTokens: 4_000 });
    expect(map.files.length).toBeGreaterThan(0);
    expect(map.degraded).toContain(".rb (1)");
  });
});

describe("two grammars that share a query do not share a compiled query", () => {
  test("a repository of .ts and .tsx shows symbols from both", async () => {
    // Regression guard. `typescript` and `tsx` use the same query TEXT and do
    // not share node type ids, so caching the compiled query on the text ran a
    // typescript-compiled query over tsx trees and captured nothing from them —
    // a whole language silently missing from the map with every test green.
    const dir = temporaryRepo("mixed");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "plain.ts"), "export function plainSymbol(): number { return 1; }\n");
    writeFileSync(
      join(dir, "src", "widget.tsx"),
      'import { plainSymbol } from "./plain.ts";\nexport function widgetSymbol() { return <div>{plainSymbol()}</div>; }\n',
    );
    const map = await buildRepoMap(dir, { budgetTokens: 4_000 });
    expect(map.text).toContain("plainSymbol");
    expect(map.text).toContain("widgetSymbol");
  });

  test("and the order the files are read in does not change that", async () => {
    // The bug was order-dependent: whichever grammar compiled the query first
    // won. The walk is sorted, so this fixture puts the tsx file first.
    const dir = temporaryRepo("mixed-reversed");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "aaa.tsx"), "export function firstSymbol() { return <div />; }\n");
    writeFileSync(join(dir, "src", "zzz.ts"), "export function lastSymbol(): number { return 1; }\n");
    const map = await buildRepoMap(dir, { budgetTokens: 4_000 });
    expect(map.text).toContain("firstSymbol");
    expect(map.text).toContain("lastSymbol");
  });
});

describe("ruling 70: the framing quotes the unflattering half", () => {
  /**
   * The property, as a predicate so it can be shown failing: a framing that
   * names only the small-repository hit rate is selecting the flattering half.
   */
  const namesALargeRepository = (framing: string): boolean =>
    /8\.1%/.test(framing) && /2,014-file/.test(framing);

  test("REPO_MAP_FRAMING passes it", () => {
    expect(namesALargeRepository(REPO_MAP_FRAMING)).toBe(true);
    expect(REPO_MAP_FRAMING).toContain("lottery ticket");
    expect(REPO_MAP_FRAMING).toContain("not a retrieval system");
    expect(REPO_MAP_FRAMING).toContain("56-59%");
  });

  test("and a framing that quotes only the small repositories fails it", () => {
    expect(namesALargeRepository("The repo map hits 56-59% of the time.")).toBe(false);
  });

  test("every map carries the framing, so a reporter cannot omit it by forgetting", async () => {
    const map = await buildRepoMap(typescriptRepo(5));
    expect(map.framing).toBe(REPO_MAP_FRAMING);
  });
});

describe("the ranking is a graph, not an alphabet", () => {
  test("the file everything depends on outranks the file nothing does", () => {
    const ranked = rankFiles([
      { path: "src/core.ts", declares: ["coreThing"], mentions: ["coreThing"] },
      { path: "src/a.ts", declares: ["aThing"], mentions: ["coreThing", "coreThing"] },
      { path: "src/b.ts", declares: ["bThing"], mentions: ["coreThing"] },
      { path: "src/lonely.ts", declares: ["lonelyThing"], mentions: ["nothingAtAll"] },
    ]);
    expect(ranked[0]?.path).toBe("src/core.ts");
    const lonely = ranked.findIndex((r) => r.path === "src/lonely.ts");
    expect(lonely).toBeGreaterThan(0);
    // Demonstrated negative: it is not simply returning the input order, and it
    // is not simply sorting by path — either would put "src/a.ts" first.
    expect(ranked.map((r) => r.path)[0]).not.toBe("src/a.ts");
  });

  test("an empty repository ranks nothing rather than dividing by zero", () => {
    expect(rankFiles([])).toEqual([]);
  });
});
