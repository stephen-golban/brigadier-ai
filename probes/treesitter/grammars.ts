import { Language, Parser } from "web-tree-sitter";
import runtimeWasm from "./node_modules/web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import g0 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import g1 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import g2 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import g3 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" with { type: "file" };
import g4 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm" with { type: "file" };
import g5 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm" with { type: "file" };
import g6 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm" with { type: "file" };
import g7 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm" with { type: "file" };
import g8 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm" with { type: "file" };
import g9 from "./node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm" with { type: "file" };
const grammars = [["typescript", g0],["tsx", g1],["javascript", g2],["python", g3],["go", g4],["rust", g5],["java", g6],["c-sharp", g7],["cpp", g8],["ruby", g9]] as const;

const t0 = performance.now();
await Parser.init({ locateFile: () => runtimeWasm });
const tInit = performance.now();
let total = 0;
for (const [name, path] of grammars) {
  const bytes = await Bun.file(path).arrayBuffer();
  const lang = await Language.load(new Uint8Array(bytes));
  const p = new Parser();
  p.setLanguage(lang);
  total += bytes.byteLength;
  console.log(`OK ${name.padEnd(12)} ${(bytes.byteLength/1024).toFixed(0).padStart(5)}KB abi=${lang.abiVersion ?? "?"}`);
}
console.log(`INIT ${(tInit-t0).toFixed(1)}ms  LOAD-ALL ${(performance.now()-tInit).toFixed(1)}ms  WASM-BYTES ${(total/1048576).toFixed(2)}MB`);
