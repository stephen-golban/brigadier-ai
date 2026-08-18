// SPDX-License-Identifier: Apache-2.0
/**
 * Which languages the repo map can see, and what they cost.
 *
 * Ruling 39 keeps the map and settles its budget; it says nothing about how
 * many grammars ship, and the grammar set is decided here by arithmetic that
 * was MEASURED rather than by preference.
 *
 * #23 measured ten grammars costing **+17.6 MB**, with `cpp` and `c-sharp`
 * alone 60% of it, against a binary already at 60.66 MiB of a 63 MiB budget —
 * **2,449,054 bytes of headroom**. On those numbers not even five languages
 * fit. Two further measurements changed the arithmetic:
 *
 *   MEASURED against `bun 1.3.14` on 2026-08-18: `bun build --compile` embeds
 *   an imported file VERBATIM — it does not compress. The seven grammars below
 *   cost **5,515,008 bytes** imported raw from `node_modules`, which is 2.25x
 *   the whole headroom.
 *
 *   MEASURED against `bun 1.3.14` on 2026-08-18: the same seven plus the
 *   tree-sitter runtime, gzipped into `vendor/grammars/` and gunzipped at load
 *   time, cost **660,480 bytes** — 8.3x less, because a tree-sitter parse table
 *   is mostly zero padding.
 *
 * So the constraint that decided #23's "ten do not fit" was the packaging, not
 * the grammars. Gzipped, all ten of #23's set would fit (~1.94 MB of 2.34 MiB).
 * They are still not all shipped: seven cost ~0.78 MB and leave ~1.6 MiB for
 * the rest of the product, and spending two thirds of the remaining headroom on
 * C++, C# and Ruby is not a trade this project's measured item population
 * supports. `cpp`, `c-sharp` and `ruby` are therefore ABSENT ON PURPOSE, and
 * `buildRepoMap` reports what it could not read rather than omitting it —
 * see `RepoMapCoverage`.
 *
 * The queries are #23's, unchanged, and the reason they are narrow is recorded
 * there: an earlier version also captured `variable_declarator`, every local
 * `const result =` became a definition, the graph blew up to 1.34M edges and
 * the top-ranked output was test files listing `result, data, row`. A bad map
 * would have reversed ruling 22 on the strength of a bug.
 */

import { Language, Parser } from "web-tree-sitter";

import runtimeGz from "../../vendor/grammars/tree-sitter-runtime.wasm.gz" with { type: "file" };
import typescriptGz from "../../vendor/grammars/typescript.wasm.gz" with { type: "file" };
import tsxGz from "../../vendor/grammars/tsx.wasm.gz" with { type: "file" };
import javascriptGz from "../../vendor/grammars/javascript.wasm.gz" with { type: "file" };
import pythonGz from "../../vendor/grammars/python.wasm.gz" with { type: "file" };
import goGz from "../../vendor/grammars/go.wasm.gz" with { type: "file" };
import rustGz from "../../vendor/grammars/rust.wasm.gz" with { type: "file" };
import javaGz from "../../vendor/grammars/java.wasm.gz" with { type: "file" };

export type LanguageName = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "java";

/**
 * Ruling 16's brief is IDENTIFIERS, NOT CONTENTS, so every query captures a
 * declaration name and nothing else. Module level only: an inner `def` is not
 * the file's public surface, and a map of inner helpers is a map of noise.
 */
const TYPESCRIPT_SURFACE = `
  (export_statement declaration: (function_declaration name:(identifier) @d))
  (export_statement declaration: (class_declaration name:(type_identifier) @d))
  (export_statement declaration: (interface_declaration name:(type_identifier) @d))
  (export_statement declaration: (type_alias_declaration name:(type_identifier) @d))
  (export_statement declaration: (lexical_declaration (variable_declarator name:(identifier) @d)))
  (export_statement declaration: (variable_declaration (variable_declarator name:(identifier) @d)))`;

const JAVASCRIPT_SURFACE = `
  (export_statement declaration: (function_declaration name:(identifier) @d))
  (export_statement declaration: (class_declaration name:(identifier) @d))
  (export_statement declaration: (lexical_declaration (variable_declarator name:(identifier) @d)))
  (export_statement declaration: (variable_declaration (variable_declarator name:(identifier) @d)))`;

export interface GrammarSpec {
  readonly name: LanguageName;
  /** Lower-case file extensions, leading dot included. */
  readonly extensions: readonly string[];
  /** Path to the embedded gzipped grammar. Inside `/$bunfs/` once compiled. */
  readonly asset: string;
  /** tree-sitter query naming the file's public surface. */
  readonly query: string;
}

export const GRAMMARS: readonly GrammarSpec[] = [
  { name: "typescript", extensions: [".ts", ".mts", ".cts"], asset: typescriptGz, query: TYPESCRIPT_SURFACE },
  // `.jsx` is parsed by the tsx grammar rather than the javascript one, which
  // is what #23 measured; the numbers in ruling 39 are that pipeline's.
  { name: "tsx", extensions: [".tsx", ".jsx"], asset: tsxGz, query: TYPESCRIPT_SURFACE },
  { name: "javascript", extensions: [".js", ".mjs", ".cjs"], asset: javascriptGz, query: JAVASCRIPT_SURFACE },
  {
    name: "python",
    extensions: [".py", ".pyi"],
    asset: pythonGz,
    query: `(module (function_definition name:(identifier) @d)) (module (class_definition name:(identifier) @d))`,
  },
  {
    name: "go",
    extensions: [".go"],
    asset: goGz,
    query: `(source_file (function_declaration name:(identifier) @d))
            (source_file (type_declaration (type_spec name:(type_identifier) @d)))`,
  },
  {
    name: "rust",
    extensions: [".rs"],
    asset: rustGz,
    query: `(source_file (function_item name:(identifier) @d))
            (source_file (struct_item name:(type_identifier) @d))
            (source_file (enum_item name:(type_identifier) @d))
            (source_file (trait_item name:(type_identifier) @d))`,
  },
  {
    name: "java",
    extensions: [".java"],
    asset: javaGz,
    query: `(program (class_declaration name:(identifier) @d))
            (program (interface_declaration name:(identifier) @d))
            (program (enum_declaration name:(identifier) @d))
            (program (record_declaration name:(identifier) @d))`,
  },
];

const BY_EXTENSION = new Map<string, GrammarSpec>();
for (const grammar of GRAMMARS) {
  for (const extension of grammar.extensions) BY_EXTENSION.set(extension, grammar);
}

/** The extension of a path, lower-cased, or `""` where there is none. */
export function extensionOf(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** The grammar that can read this path, or `undefined` — which is a reported outcome, not an error. */
export function grammarFor(path: string): GrammarSpec | undefined {
  return BY_EXTENSION.get(extensionOf(path));
}

async function embedded(asset: string): Promise<Uint8Array> {
  // Bun.file resolves `/$bunfs/` paths inside a compiled binary. #23 measured
  // that this is the exact thing that breaks when an asset is reached for by
  // `import.meta.resolve` instead, so the path always comes from an import
  // attribute and never from the filesystem layout.
  return Bun.gunzipSync(new Uint8Array(await Bun.file(asset).arrayBuffer()));
}

let runtime: Promise<void> | undefined;

/**
 * Bring up the tree-sitter runtime, once per process.
 *
 * The runtime wasm is handed over as BYTES rather than as a path.
 * `Parser.init`'s default is Emscripten's `locateFile`, which resolves a
 * sibling `tree-sitter.wasm` relative to the script — a lookup that has no
 * answer inside `/$bunfs/` and none at all from a directory with no
 * `node_modules`. Passing `wasmBinary` removes the lookup rather than
 * configuring it.
 */
export function initRuntime(): Promise<void> {
  runtime ??= (async () => {
    await Parser.init({ wasmBinary: await embedded(runtimeGz) } as never);
  })();
  return runtime;
}

const loaded = new Map<LanguageName, Promise<Language>>();

/** Load a grammar, once per process. Roughly 10 ms each, gunzip included. */
export function loadGrammar(spec: GrammarSpec): Promise<Language> {
  let language = loaded.get(spec.name);
  if (!language) {
    language = (async () => {
      await initRuntime();
      return Language.load(await embedded(spec.asset));
    })();
    loaded.set(spec.name, language);
  }
  return language;
}
