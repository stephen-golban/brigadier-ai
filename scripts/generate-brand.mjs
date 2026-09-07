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
const source = readFileSync("public/brand/fold.svg", "utf8");
const mark = source.slice(source.indexOf("  <g"), source.lastIndexOf("</svg>"));
writeFileSync(
  "public/brand/app-icon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#17213f"/><stop offset="1" stop-color="#080c1b"/></linearGradient><radialGradient id="light"><stop stop-color="#535fe9" stop-opacity=".45"/><stop offset="1" stop-color="#535fe9" stop-opacity="0"/></radialGradient><clipPath id="icon"><rect x="16" y="16" width="992" height="992" rx="218"/></clipPath></defs><g clip-path="url(#icon)"><rect width="1024" height="1024" fill="url(#bg)"/><ellipse cx="330" cy="775" rx="650" ry="400" fill="url(#light)"/></g><g transform="translate(184 167) scale(2.55)" color="#f2f5ff">${mark}</g></svg>`,
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
console.log("Generated platform icons from public/brand/fold.svg");
