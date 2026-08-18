// SPDX-License-Identifier: Apache-2.0
/**
 * Does the repo map still work once it is a compiled binary?
 *
 * This exists because #23 measured the exact failure mode: `bun --compile`
 * embeds the tree-sitter WASM, but the loader resolves it through a path, and
 * inside `/$bunfs/` a path that worked under `bun run` is a path that does not
 * exist. The failure surfaces as a bare `Error` from Emscripten's dylink
 * loader, from a directory with no `node_modules` — which is every directory a
 * user runs the shipped binary from and no directory the test suite runs in.
 *
 * So `test/repomap-binary.test.ts` compiles this file, runs the artifact from a
 * temporary directory with no `node_modules` above it, and reads the JSON. A
 * test that only ran under `bun test` would pass on a binary that cannot load a
 * single grammar.
 *
 * It prints JSON on stdout and nothing else, so the test can assert on
 * structure rather than on a message.
 */

import { GRAMMARS, grammarFor, loadGrammar } from "./grammars.ts";
import { buildRepoMap } from "./map.ts";

const repoDir = Bun.argv[2];

const report: Record<string, unknown> = {};

try {
  const loadedGrammars: string[] = [];
  for (const grammar of GRAMMARS) {
    const language = await loadGrammar(grammar);
    // `abiVersion` comes from the loaded WASM module, so it is only readable if
    // the grammar really was decompressed, instantiated and linked.
    loadedGrammars.push(`${grammar.name}@abi${String(language.abiVersion)}`);
  }
  report["grammars"] = loadedGrammars;
  report["mapsTypescript"] = grammarFor("a.ts")?.name ?? null;

  if (repoDir !== undefined) {
    const map = await buildRepoMap(repoDir);
    report["map"] = {
      filesInMap: map.files.length,
      filesParsed: map.coverage.filesParsed,
      estimatedTokens: map.estimatedTokens,
      budgetTokens: map.budgetTokens,
      degraded: map.degraded,
      firstFile: map.files[0] ?? null,
      symbolsSample: map.text.split("\n").slice(0, 4).join("\n"),
    };
  }
  report["ok"] = true;
} catch (error) {
  report["ok"] = false;
  report["error"] = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

process.stdout.write(JSON.stringify(report));
