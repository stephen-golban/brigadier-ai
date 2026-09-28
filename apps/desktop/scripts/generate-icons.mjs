// Generates the app icon, the menu-bar icon and every platform raster from one vector master,
// src-tauri/icons/mark.svg (the striped disc, `currentColor` on a transparent 256-unit grid).
//
//   node scripts/generate-icons.mjs
//
// icon.svg puts the mark on the charcoal plate; tray.svg is the same mark in black for the
// macOS template image. The rasters come from the Tauri CLI, and only files this project
// already owns are replaced, not the mobile scaffolding `tauri icon` also writes.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const iconsDir = resolve(appDir, "src-tauri/icons");
const tauri = resolve(appDir, "node_modules/.bin/tauri");

const source = readFileSync(join(iconsDir, "mark.svg"), "utf8");
const mark = source.slice(source.indexOf("  <g"), source.lastIndexOf("</svg>"));

// `#181818` is the plate and `#f2f5ff` the disc's ink, brand values with no theme token behind them.
writeFileSync(
  join(iconsDir, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="16" y="16" width="992" height="992" rx="218" fill="#181818"/><g transform="translate(184 167) scale(2.55)" color="#f2f5ff">${mark}</g></svg>`,
);
writeFileSync(
  join(iconsDir, "tray.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" color="#000000">\n${mark}</svg>\n`,
);

const output = mkdtempSync(join(tmpdir(), "brigadier-icons-"));
try {
  execFileSync(tauri, ["icon", join(iconsDir, "icon.svg"), "--output", output], { stdio: "ignore" });
  for (const name of readdirSync(iconsDir))
    if (name !== "tray.png" && existsSync(join(output, name)))
      copyFileSync(join(output, name), join(iconsDir, name));

  const tray = join(output, "tray");
  execFileSync(tauri, ["icon", join(iconsDir, "tray.svg"), "--output", tray, "--png", "64"], {
    stdio: "ignore",
  });
  copyFileSync(join(tray, "64x64.png"), join(iconsDir, "tray.png"));
} finally {
  rmSync(output, { recursive: true, force: true });
}
console.log("Generated app and tray icons from src-tauri/icons/mark.svg");
