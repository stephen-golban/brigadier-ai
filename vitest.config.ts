/**
 * The test runner. Deliberately a separate file rather than a `test` block inside
 * `vite.config.ts`: that config is an async factory reading `TAURI_DEV_HOST` and is owned by
 * `tsconfig.node.json`. Vitest reads `vitest.config.ts` in preference to `vite.config.ts`.
 *
 * Measured choices (`docs/research/frontend-stack.md` §1.2, §1.5, §1.8):
 *   - `environment: "jsdom"` with no options. Vitest overrides jsdom's own
 *     `pretendToBeVisual: false` to `true`, so `requestAnimationFrame` exists and is a
 *     `setInterval(…, 1000/60)` underneath — which is why plain `vi.useFakeTimers()` drives the
 *     `feedStore` drain loop. `environment: "node"` throws on line 1 of `start()`.
 *   - no `toFake` list: Vitest's default already fakes `requestAnimationFrame` and
 *     `performance`, an explicit list measured identical, and an explicit list silently drops
 *     everything it does not name.
 *   - `globals: false`: every test imports `describe`/`it`/`expect`/`vi` from "vitest", which is
 *     what keeps `npx tsc --noEmit` green on the stock `tsconfig.json` with no `types` entry.
 *   - the setup file lives under `src/` so `include: ["src"]` already covers it; outside `src/`
 *     the type gate fails with `TS2339: toBeInTheDocument`.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// This config does not inherit `vite.config.ts`, so the `@/` alias is repeated here or every
// test importing `@/…` fails to resolve. `"type": "module"` makes `__dirname` a ReferenceError.
const srcDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": srcDir },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
