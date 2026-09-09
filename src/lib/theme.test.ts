import { afterEach, beforeEach, expect, it } from "vitest";
import { editorColor, themeColor } from "./theme";
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as {
  readFileSync: (path: string, encoding: string) => string;
};
const css = fs.readFileSync("src/index.css", "utf8");
const tokens = (section: string) => [...section.matchAll(/--color-([\w-]+):\s*([^;]+);/g)];
const colors = tokens(css.match(/@theme static \{([\s\S]*?)\n\}/)![1]);
const lightColors = tokens(css.match(/:root\.light \{([\s\S]*?)\n\}/)![1]);
beforeEach(() => {
  for (const [, name, value] of colors)
    document.documentElement.style.setProperty(`--color-${name}`, value);
});
afterEach(() => {
  for (const [, name] of colors)
    document.documentElement.style.removeProperty(`--color-${name}`);
});
it("reads the specified surfaces and neutral selected state from CSS", () => {
  expect(themeColor("canvas")).toBe("#181818");
  expect(themeColor("sidebar")).toBe("#202020");
  expect(themeColor("elevated")).toBe("#2b2b2b");
  expect(themeColor("input")).toBe("#2a2a2a");
  expect(themeColor("input-shell")).toBe("#1f1f1f");
  expect(themeColor("text")).toBe("#e3e3e3");
  expect(themeColor("warn")).toBe("#ef8c57");
  expect(editorColor("selected")).toBe("#ffffff14");
  expect(editorColor("hover")).toBe("#ffffff0d");
});
it("follows the CSS value instead of maintaining a second editor palette", () => {
  document.documentElement.style.setProperty("--color-canvas", "#202020");
  expect(editorColor("canvas")).toBe("#202020");
});
it("reports missing tokens rather than silently using a hardcoded fallback", () => {
  document.documentElement.style.removeProperty("--color-canvas");
  expect(() => themeColor("canvas")).toThrow("Missing theme token: canvas");
});

it("provides matching light semantic tokens for composer surfaces and canvas renderers", () => {
  for (const [,name,value] of lightColors) document.documentElement.style.setProperty(`--color-${name}`,value);
  expect(themeColor("canvas")).toBe("#f7f7f5");
  expect(themeColor("input")).toBe("#f0f0ee");
  expect(themeColor("text")).toBe("#242424");
  expect(editorColor("selected")).toBe("#00000014");
  expect(new Set(lightColors.map(([,name])=>name))).toEqual(new Set(colors.map(([,name])=>name)));
});
