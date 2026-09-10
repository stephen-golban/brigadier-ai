import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  copyFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const source = readFileSync("public/brand/striped-disc.svg", "utf8");
const mark = source.slice(source.indexOf("  <g"), source.lastIndexOf("</svg>"));
const theme = readFileSync("src/index.css", "utf8");
// The palette is two layers deep since the design-kit port: `--color-canvas` and friends are
// aliases of the kit's own slots (`--background`, `--popover`, `--ring`), so a regex for a
// literal hex under the legacy name finds nothing. Collect every custom property in the file —
// first declaration wins, matching the old `String.match` — then follow `var()` to a literal.
const declarations = new Map();
for (const [, name, value] of theme.matchAll(/--([\w-]+):\s*([^;{}]+);/g))
  if (!declarations.has(name)) declarations.set(name, value.trim());
const LITERAL = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|color)\()/i;
const INDIRECTION = /^var\(\s*--([\w-]+)\s*\)$/;
const HOPS = 4;
const color = (name) => {
  let key = `color-${name}`;
  for (let hop = 0; hop <= HOPS; hop++) {
    const value = declarations.get(key);
    if (!value) break;
    if (LITERAL.test(value)) return value;
    const next = value.match(INDIRECTION)?.[1];
    if (!next) throw Error(`Icon color ${name} is not a colour literal: --${key}: ${value}`);
    key = next;
  }
  throw Error(`Missing icon color: ${name} (looked up --${key})`);
};
writeFileSync(
  "public/brand/app-icon.svg",
  // The plate is the app canvas, read from the theme; `#f2f5ff` is the striped disc's own ink,
  // a brand value with no token behind it (`docs/plans/striped-disc-intro-2026-09-11.md`).
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="16" y="16" width="992" height="992" rx="218" fill="${color("canvas")}"/><g transform="translate(184 167) scale(2.55)" color="#f2f5ff">${mark}</g></svg>`,
);
const output = mkdtempSync(join(tmpdir(), "brigadier-icons-"));
execFileSync(
  "node_modules/.bin/tauri",
  ["icon", "public/brand/app-icon.svg", "--output", output],
  { stdio: "ignore" },
);
// Replace the platform assets already owned by this desktop project, not mobile scaffolding.
for (const name of readdirSync("src-tauri/icons"))
  if (existsSync(join(output, name)))
    copyFileSync(join(output, name), join("src-tauri/icons", name));
console.log("Generated platform icons from public/brand/striped-disc.svg");
