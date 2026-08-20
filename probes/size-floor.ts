// Throwaway. What does an empty bun binary cost on this platform, and what does
// brigadier add to it? Not product code.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const ws = mkdtempSync(join(tmpdir(), "sizefloor-"));
function compile(entry: string, out: string): number {
  const r = Bun.spawnSync(["bun", "build", "--compile", entry, "--outfile", out], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
  for (const candidate of [out, `${out}.exe`]) { try { return statSync(candidate).size; } catch {} }
  throw new Error(`no artifact for ${out}`);
}
const emptyEntry = join(ws, "empty.ts");
writeFileSync(emptyEntry, "process.exit(0);\n");
const floor = compile(emptyEntry, join(ws, "empty"));
const cliOnly = compile(join(REPO, "src", "cli.ts"), join(ws, "cli-only"));
const mapEntry = join(ws, "cli-plus-map.ts");
writeFileSync(mapEntry, [
  `import { buildRepoMap } from "${REPO}/src/repomap/index.ts";`,
  'if (process.env["BRIGADIER_NEVER"] === "1") console.log(await buildRepoMap("."));',
  `await import("${REPO}/src/cli.ts");`,
  "",
].join("\n"));
const withMap = compile(mapEntry, join(ws, "cli-plus-map"));
console.log(JSON.stringify({
  platform: process.platform, arch: process.arch, bun: Bun.version,
  emptyFloor: floor, cliOnly, cliPlusMap: withMap,
  cliContribution: cliOnly - floor,
  cliPlusMapContribution: withMap - floor,
  repomapMarginal: withMap - cliOnly,
}, null, 2));
rmSync(ws, { recursive: true, force: true });
