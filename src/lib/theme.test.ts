import { afterEach, beforeEach, expect, it } from "vitest";
import { editorColor, themeColor } from "./theme";
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as {
  readFileSync: (path: string, encoding: string) => string;
};
const css = fs.readFileSync("src/index.css", "utf8");
const colors = [...css.matchAll(/--color-([\w-]+):\s*([^;]+);/g)];
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
