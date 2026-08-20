// Throwaway. Drives ONE bar item against the honest fixture with logging on, so
// the in-flight scan's own `did` lines are visible. Not product code.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ITEMS } from "../bar/items/index.ts";
import { writeScript } from "../bar/lib/fs.ts";
import { runBar } from "../bar/run.ts";

const want = Number(process.argv[2] ?? "2");
const HONEST = fileURLToPath(new URL("../bar/fakes/honest.ts", import.meta.url));
const root = join(homedir(), ".brigadier-bar-tests", `probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(join(root, "bin"), { recursive: true });
const binary = writeScript(
  join(root, "bin", "brigadier-honest"),
  `#!/bin/sh\nexec "${process.execPath}" "${HONEST}" "$@"\n`,
  `@echo off\r\n"${process.execPath}" "${HONEST}" %*\r\n`,
);
const records = await runBar(ITEMS.filter((i) => i.id === want), {
  binary,
  live: true,
  json: false,
  workroot: root,
  log: (line: string) => console.log(line),
});
for (const r of records) console.log(`\n=== item ${r.id}: ${r.outcome} ${r.reason ?? ""}`);
