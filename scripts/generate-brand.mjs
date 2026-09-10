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
const source = readFileSync("public/brand/spark.svg", "utf8");
const mark = source.slice(source.indexOf("  <g"), source.lastIndexOf("</svg>"));
const theme = readFileSync("src/index.css", "utf8");
const color = (name) => {
  const value = theme.match(new RegExp(`--color-${name}: (#[0-9a-f]{6});`))?.[1];
  if (!value) throw Error(`Missing icon color: ${name}`);
  return value;
};
writeFileSync(
  "public/brand/app-icon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="${color("elevated")}"/><stop offset="1" stop-color="${color("canvas")}"/></linearGradient></defs><rect x="16" y="16" width="992" height="992" rx="218" fill="url(#bg)"/><g transform="translate(184 184) scale(2.5625)">${mark}</g></svg>`,
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
console.log("Generated platform icons from public/brand/spark.svg and the app palette");
