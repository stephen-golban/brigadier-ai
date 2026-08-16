/**
 * Probe — ticket #23, the blocking sub-question.
 *
 * Can a `bun build --compile`d binary embed and load a tree-sitter `.wasm`
 * grammar at runtime? Decision 22 (repo map) assumes yes and has never been
 * measured. A negative result reverses that ruling outright, so this runs
 * before any PageRank work.
 *
 * Embedding uses Bun's `with { type: "file" }` import attribute, which copies
 * the asset into the standalone binary and hands back a path at runtime.
 */

import { Language, Parser, Query } from "web-tree-sitter";

import runtimeWasm from "./node_modules/web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import tsGrammar from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import pyGrammar from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" with { type: "file" };

const t0 = performance.now();

await Parser.init({ locateFile: () => runtimeWasm });

const tInit = performance.now();

const results: string[] = [];

const cases = [
  {
    name: "typescript",
    path: tsGrammar,
    source:
      "export function alpha(a: number): number { return a + 1 }\nexport class Beta { gamma() {} }\n",
    query: "(function_declaration name: (identifier) @name)",
  },
  {
    name: "python",
    path: pyGrammar,
    source: "def alpha(a):\n    return a + 1\n\nclass Beta:\n    def gamma(self):\n        pass\n",
    query: "(function_definition name: (identifier) @name)",
  },
];

for (const c of cases) {
  const bytes = await Bun.file(c.path).arrayBuffer();
  const lang = await Language.load(new Uint8Array(bytes));
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(c.source);
  if (!tree) throw new Error(`${c.name}: parse returned null`);

  // Extracting a symbol is the real workload; a root node alone proves nothing.
  const captured = new Query(lang, c.query).captures(tree.rootNode).map((x) => x.node.text);

  results.push(
    `${c.name}: wasm=${(bytes.byteLength / 1024).toFixed(0)}KB root=${tree.rootNode.type} ` +
      `children=${tree.rootNode.childCount} symbols=[${captured.join(",")}]`,
  );
}

const tDone = performance.now();

console.log(`INIT     ${(tInit - t0).toFixed(1)}ms`);
console.log(`PARSE    ${(tDone - tInit).toFixed(1)}ms`);
for (const r of results) console.log(`OK       ${r}`);
console.log("VERDICT  wasm grammars loaded and parsed");
