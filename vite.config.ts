import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// `"type": "module"` makes this file ESM, where `__dirname` is a ReferenceError. Resolve the
// alias from the module's own URL instead; `shadcn add` writes a literal `@/` directory when
// the alias is missing (docs/research/frontend-stack.md §3.2).
const srcDir = fileURLToPath(new URL("./src", import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Diagnostic-only React renderer; excluded from ordinary acceptance builds.
// @ts-expect-error process is a nodejs global
const reactProfile = process.env.VITE_REACT_PROFILE === "1";

// https://vite.dev/config/
export default defineConfig(async () => ({
  // `@tailwindcss/vite` is build-time only and adds zero bytes to the JS bundle
  // (docs/research/frontend-stack.md §2.5). It is deliberately NOT in `vitest.config.ts`: no
  // test imports CSS, and one that did would be testing the wrong thing.
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: [
      ...(reactProfile ? [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] : []),
      { find: "@", replacement: srcDir },
    ],
  },
  // Keep VS Code service identifiers in one module graph and retain extension asset URLs.
  // Mixing prebundled overrides with unbundled themes creates duplicate service symbols.
  optimizeDeps: { exclude: readdirSync(new URL("./node_modules/@codingame", import.meta.url)).map(name => `@codingame/${name}`) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
