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
writeFileSync(
  "public/brand/app-icon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="16" y="16" width="992" height="992" rx="218" fill="#181818"/><g transform="translate(184 167) scale(2.55)" color="#f2f5ff">${mark}</g></svg>`,
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
