// SPDX-License-Identifier: Apache-2.0
/**
 * The compressed grammars are imported with `with { type: "file" }`, which Bun
 * resolves to a path — inside `/$bunfs/` once the binary is compiled. TypeScript
 * has no opinion about a `.wasm.gz` module, so it is declared here.
 */
declare module "*.wasm.gz" {
  /** Path to the embedded file, valid both under `bun run` and inside `/$bunfs/`. */
  const path: string;
  export default path;
}
