// SPDX-License-Identifier: Apache-2.0
/**
 * The vendored grammars, and the two ways they can go quietly wrong.
 *
 * They are committed BLOBS. A blob cannot be reviewed in a diff, so the only
 * thing standing between `vendor/grammars/` and a stale or wrong grammar is a
 * check that decompresses each one and compares it to the package it claims to
 * be a copy of. MEASURED against `bun 1.3.14` on 2026-08-18: raw, the seven
 * grammars plus the runtime cost 5,515,008 bytes of binary against 2,449,054
 * bytes of headroom; gzipped they cost 660,480, which is why copies exist here
 * at all rather than an import from `node_modules`.
 *
 * Ruling 62b: each check below is shown failing on a deliberately wrong input,
 * because a comparison that never disagrees looks exactly like one that cannot.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { GRAMMARS, extensionOf, grammarFor, loadGrammar } from "../src/repomap/grammars.ts";
import { VENDORED, sha256 } from "../vendor/grammars/regenerate.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

describe("every vendored blob is the package it claims to be", () => {
  test("each file gunzips to the exact bytes of its npm source", () => {
    for (const entry of VENDORED) {
      const packed = new Uint8Array(readFileSync(join(REPO, "vendor", "grammars", entry.file)));
      const unpacked = Bun.gunzipSync(packed);
      const original = new Uint8Array(readFileSync(join(REPO, entry.source)));
      expect(`${entry.file} ${sha256(unpacked)}`).toBe(`${entry.file} ${sha256(original)}`);
    }
  });

  test("and the comparison notices a single flipped byte", () => {
    // Demonstrated negative. Without this the assertion above would pass just
    // as happily if `sha256` returned a constant.
    const original = new Uint8Array(readFileSync(join(REPO, VENDORED[0]!.source)));
    const tampered = new Uint8Array(original);
    const middle = Math.floor(tampered.length / 2);
    tampered.set([(tampered[middle] ?? 0) ^ 0xff], middle);
    expect(sha256(tampered)).not.toBe(sha256(original));
    expect(sha256(Bun.gunzipSync(Bun.gzipSync(original)))).toBe(sha256(original));
  });

  test("nothing is vendored that no grammar refers to, and nothing referred to is missing", () => {
    const onDisk = readdirSync(join(REPO, "vendor", "grammars"))
      .filter((f) => f.endsWith(".wasm.gz"))
      .sort();
    expect(onDisk).toEqual([...VENDORED].map((v) => v.file).sort());
    // Seven grammars plus the tree-sitter runtime.
    expect(GRAMMARS.length).toBe(7);
    expect(VENDORED.length).toBe(GRAMMARS.length + 1);
  });

  test("the shipped set is the one the size arithmetic was done for", () => {
    // cpp, c-sharp and ruby are absent ON PURPOSE — see src/repomap/grammars.ts.
    // If someone adds one, this fails before the binary-size guard does, and the
    // failure names the decision rather than a number of bytes.
    expect([...GRAMMARS].map((g) => g.name).sort()).toEqual([
      "go",
      "java",
      "javascript",
      "python",
      "rust",
      "tsx",
      "typescript",
    ]);
  });
});

describe("extensions map to the grammar that can read them", () => {
  test("the ones that are shipped", () => {
    expect(grammarFor("src/repomap/map.ts")?.name).toBe("typescript");
    expect(grammarFor("app/Button.tsx")?.name).toBe("tsx");
    expect(grammarFor("lib/index.mjs")?.name).toBe("javascript");
    expect(grammarFor("tool.py")?.name).toBe("python");
    expect(grammarFor("main.go")?.name).toBe("go");
    expect(grammarFor("src/lib.rs")?.name).toBe("rust");
    expect(grammarFor("Main.java")?.name).toBe("java");
    expect(grammarFor("SRC/MAP.TS")?.name).toBe("typescript");
  });

  test("and the ones that are not — undefined rather than a wrong grammar", () => {
    // Demonstrated negative for the mapping. A lookup that fell back to
    // TypeScript would parse a Ruby file into nonsense and report symbols that
    // do not exist, which is worse than reporting nothing.
    expect(grammarFor("app/models/user.rb")).toBeUndefined();
    expect(grammarFor("src/main.cpp")).toBeUndefined();
    expect(grammarFor("Program.cs")).toBeUndefined();
    expect(grammarFor("README.md")).toBeUndefined();
    expect(grammarFor("Makefile")).toBeUndefined();
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });
});

describe("each grammar really parses its language", () => {
  const sources: Record<string, string> = {
    typescript: "export function alphaOne(): number { return 1; }",
    tsx: "export const AlphaTwo = () => <div>hi</div>;",
    javascript: "export function alphaThree() { return 3; }",
    python: "def alpha_four():\n    return 4\n",
    go: "package main\nfunc AlphaFive() int { return 5 }\n",
    rust: "pub fn alpha_six() -> i32 { 6 }\n",
    java: "public class AlphaSeven { }\n",
  };

  test("loading it, parsing it, and finding the declaration the query names", async () => {
    const { Query } = await import("web-tree-sitter");
    const { Parser } = await import("web-tree-sitter");
    for (const grammar of GRAMMARS) {
      const language = await loadGrammar(grammar);
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(sources[grammar.name] ?? "");
      expect(tree).not.toBeNull();
      const captured = new Query(language, grammar.query)
        .captures(tree!.rootNode)
        .map((c) => c.node.text);
      expect(`${grammar.name}: ${captured.join(",")}`).not.toBe(`${grammar.name}: `);
      tree!.delete();
      parser.delete();
    }
  });

  test("and finds nothing in a file that declares nothing public", async () => {
    // Demonstrated negative: the queries capture a public surface, not every
    // identifier. #23 recorded what happens when they do not — every local
    // `const result =` becomes a definition, the graph reaches 1.34M edges and
    // the map ranks test files listing `result, data, row`.
    const { Parser, Query } = await import("web-tree-sitter");
    const grammar = GRAMMARS.find((g) => g.name === "typescript")!;
    const language = await loadGrammar(grammar);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse("function hidden() { const result = 1; return result; }");
    expect(new Query(language, grammar.query).captures(tree!.rootNode)).toEqual([]);
    tree!.delete();
    parser.delete();
  });
});
