// SPDX-License-Identifier: Apache-2.0
/**
 * Rebuild the compressed grammars in this directory from the installed packages.
 *
 * `bun run vendor/grammars/regenerate.ts`
 *
 * Why compressed copies exist at all, rather than importing the `.wasm` straight
 * out of `node_modules`: MEASURED against `bun 1.3.14` on 2026-08-18, `bun
 * build --compile` embeds an imported file VERBATIM. The seven grammars
 * `src/repomap/grammars.ts` needs cost **5,515,008 bytes** of binary that way,
 * against **2,449,054 bytes** of headroom under the 63 MiB budget. The same
 * seven plus the runtime cost **660,480 bytes** gzipped — 8.3x less — because a
 * tree-sitter parse table is mostly zero padding.
 *
 * `src/repomap/grammars.ts` gunzips them at load time, and
 * `test/repomap-grammars.test.ts` asserts every file here still decompresses to
 * the exact bytes of the package it came from, so a stale blob cannot sit here
 * pretending to be a grammar nobody has rebuilt.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface VendoredGrammar {
  /** File in this directory. */
  readonly file: string;
  /** Path inside the installed package the bytes come from, relative to the repo root. */
  readonly source: string;
}

/**
 * Every compressed file in this directory, with the exact npm path it is a copy
 * of. Both packages are MIT and are declared production dependencies in
 * `package.json`, so `scripts/inventory.ts` attributes them from the manifest —
 * vendoring the bytes here does not put anything in the binary that
 * `THIRD-PARTY.md` has not heard of.
 */
export const VENDORED: readonly VendoredGrammar[] = [
  { file: "tree-sitter-runtime.wasm.gz", source: "node_modules/web-tree-sitter/tree-sitter.wasm" },
  { file: "typescript.wasm.gz", source: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm" },
  { file: "tsx.wasm.gz", source: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm" },
  { file: "javascript.wasm.gz", source: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm" },
  { file: "python.wasm.gz", source: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm" },
  { file: "go.wasm.gz", source: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm" },
  { file: "rust.wasm.gz", source: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm" },
  { file: "java.wasm.gz", source: "node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm" },
] as const;

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const VENDOR_DIR = join(REPO_ROOT, "vendor", "grammars");

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

if (import.meta.main) {
  mkdirSync(VENDOR_DIR, { recursive: true });
  let raw = 0;
  let packed = 0;
  for (const entry of VENDORED) {
    const source = new Uint8Array(await Bun.file(join(REPO_ROOT, entry.source)).arrayBuffer());
    const gz = Bun.gzipSync(source, { level: 9 });
    await Bun.write(join(VENDOR_DIR, entry.file), gz);
    raw += source.byteLength;
    packed += gz.byteLength;
    console.log(`${entry.file.padEnd(32)} ${String(source.byteLength).padStart(8)} -> ${String(gz.byteLength).padStart(7)}  ${sha256(source).slice(0, 16)}`);
  }
  console.log(`TOTAL ${raw} -> ${packed} bytes`);
}
