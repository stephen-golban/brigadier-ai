import { afterEach, beforeEach, expect, it } from "vitest";
import { editorColor, themeColor } from "./theme";
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as {
  readFileSync: (path: string, encoding: string) => string;
};
const css = fs.readFileSync("src/index.css", "utf8");
const tokens = (section: string) => [...section.matchAll(/--color-([\w-]+):\s*([^;]+);/g)];
const colors = tokens(css.match(/@theme static \{([\s\S]*?)\n\}/)![1]);
// The `--color-*` names are aliases of the assistant-ui kit's tokens, so most of them read
// `var(--something)`. A browser substitutes that before `getComputedStyle` ever sees it (CSS
// Custom Properties §3: the computed value of a custom property is its specified value with
// variables substituted); jsdom does not, so the one hop is resolved here instead.
const kit = Object.fromEntries(
  [...css.match(/^:root \{([\s\S]*?)\n\}/m)![1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(
    ([, name, value]) => [name, value.trim()],
  ),
);
const resolve = (value: string) =>
  value.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => kit[name] ?? whole);
beforeEach(() => {
  for (const [, name, value] of colors)
    document.documentElement.style.setProperty(`--color-${name}`, resolve(value));
});
afterEach(() => {
  for (const [, name] of colors)
    document.documentElement.style.removeProperty(`--color-${name}`);
});
it("reads the specified surfaces and neutral selected state from CSS", () => {
  expect(themeColor("canvas")).toBe("#181818");
  // The sidebar surface became Codex's `--color-background-editor-opaque` on 2026-09-10
  // (`docs/research/codex-sidebar.md` §2a, measured; owner decision the same day). `themeColor`
  // returns the specified string, which is now an `rgb()` triple rather than a hex literal, so
  // the raw form is mirrored here and `editorColor` is asserted separately for Monaco's sake.
  expect(themeColor("sidebar")).toBe("rgb(40, 40, 40)");
  expect(editorColor("sidebar")).toBe("#282828");
  expect(themeColor("elevated")).toBe("#2b2b2b");
  expect(themeColor("input")).toBe("#2a2a2a");
  expect(themeColor("input-shell")).toBe("#1f1f1f");
  expect(themeColor("text")).toBe("#e3e3e3");
  expect(themeColor("warn")).toBe("#ef8c57");
  // Owner raised --accent/--color-selected 0.08->0.14 and --muted/--color-hover 0.05->0.2 on
  // 2026-09-10 (src/index.css); alpha 0.14 -> round(0.14*255)=36 -> 0x24, 0.2 -> round(51)=51 -> 0x33.
  expect(editorColor("selected")).toBe("#ffffff24");
  expect(editorColor("hover")).toBe("#ffffff33");
});
it("follows the CSS value instead of maintaining a second editor palette", () => {
  document.documentElement.style.setProperty("--color-canvas", "#202020");
  expect(editorColor("canvas")).toBe("#202020");
});
it("reports missing tokens rather than silently using a hardcoded fallback", () => {
  document.documentElement.style.removeProperty("--color-canvas");
  expect(() => themeColor("canvas")).toThrow("Missing theme token: canvas");
});
