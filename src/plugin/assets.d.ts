// SPDX-License-Identifier: Apache-2.0
/**
 * The shipped asset is FILES, and the binary carries their bytes.
 *
 * `assets/plugin/**` is the single source of truth for what `brigadier install`
 * writes, and `src/plugin/asset.ts` imports each file with Bun's
 * `with { type: "text" }` so `bun build --compile` inlines it. That is the whole
 * reason this declaration exists: TypeScript has no resolution for a `.md` or a
 * `.json` imported as text, and without it `tsc --noEmit` fails on a construct
 * `bun` handles natively.
 *
 * The alternative was a generated `src/generated/plugin-asset.ts` beside the
 * files, and it was refused for the reason ruling 47 refuses hand-written
 * attribution: two copies of the same bytes drift, and the copy that drifts is
 * invisible. Here there is one copy, and the compiler reads it.
 *
 * Deliberately narrow in effect rather than in syntax. A wildcard module
 * declaration is global, so this was checked rather than assumed: MEASURED on
 * 2026-08-18 that nothing else in `src/`, `test/`, `scripts/` or `bar/` imports
 * a `.md` specifier, so nothing else is shadowed by it.
 *
 * There is deliberately NO `*.json` declaration here. `tsc` resolves `.json`
 * itself under `module: "Preserve"` and would shadow one anyway; `asset.ts`
 * explains why the JSON assets are imported as values instead.
 */

declare module "*.md" {
  const text: string;
  export default text;
}
