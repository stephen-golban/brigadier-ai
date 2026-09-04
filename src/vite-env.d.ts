/// <reference types="vite/client" />

/**
 * The one `VITE_`-prefixed variable this app reads, declared so it is typed as `string |
 * undefined` rather than falling through `ImportMetaEnv`'s index signature to `any`.
 *
 * `VITE_BURN=1` ships the dev burn panel into a **release** bundle, which is what makes the Rust
 * side's `--features burn` reachable at all (`src/App.tsx`, `BURN_UI`). Vite substitutes
 * `import.meta.env.VITE_BURN` at build time, so an unset variable folds the gate to `false` and
 * the panel is tree-shaken out.
 */
interface ImportMetaEnv {
  readonly VITE_BURN?: string;
}
