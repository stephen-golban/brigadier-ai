// SPDX-License-Identifier: Apache-2.0
/**
 * Drive the shipped asset against a REAL `claude`, and print what it saw.
 *
 * Not a gate, and deliberately not a test. `bun run test-gate` fails on any
 * skipped test, so a test that needs a `claude` on the machine would either
 * block every machine without one or be dressed as a skip — and ruling 62 makes
 * a skipped test not a passing test. So the host-dependent half lives here,
 * runnable on demand:
 *
 *   bun run scripts/plugin-verify.ts
 *
 * What it proves that the unit tests cannot: that the directory brigadier writes
 * is a directory `claude` actually LOADS, that the hook is registered under its
 * NAME, and that ruling 60's total discard is real rather than remembered — the
 * same file with one extra key reports `Hooks (0)`.
 *
 * Everything runs under a scratch `HOME` and a scratch `CLAUDE_CONFIG_DIR`, so
 * the operator's own `~/.claude` is never touched. That is ruling 8's rule
 * applied to our own tooling: a verification script that edited the config
 * directory it was verifying would be the violation it is checking for.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS_PATH, PLUGIN_NAME } from "../src/plugin/asset.ts";
import { missingHooks, REGISTERED_HOOK_EVENTS } from "../src/plugin/hooks.ts";
import { hooksCheckCommand, installCommand, uninstallCommand } from "../src/plugin/index.ts";
import { listFiles } from "../src/plugin/install.ts";

const found = Bun.which("claude");
if (found === null) {
  console.error("no `claude` on PATH — this script has nothing to drive. Nothing was checked.");
  process.exit(2);
}
/** Narrowed once, so the closures below do not each have to re-prove it. */
const claude: string = found;

const home = mkdtempSync(join(tmpdir(), "brigadier-verify-"));
const hooksFile = join(home, ".claude", "skills", PLUGIN_NAME, ...HOOKS_PATH.split("/"));
let failures = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        ${detail.replace(/\n/g, "\n        ")}`);
}

/** `claude plugin details brigadier`, under the scratch config directory. */
function details(): string {
  const proc = Bun.spawnSync([claude, "plugin", "details", PLUGIN_NAME], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const decode = new TextDecoder();
  return `${decode.decode(proc.stdout)}${decode.decode(proc.stderr)}`;
}

function inventoryLine(output: string, label: string): string {
  return output.split("\n").find((line) => line.trim().startsWith(`${label} (`))?.trim() ?? "<no line>";
}

try {
  const version = Bun.spawnSync([claude, "--version"], { stdout: "pipe" });
  console.log(`=== claude ${new TextDecoder().decode(version.stdout).trim()} — scratch HOME ${home} ===\n`);

  installCommand(["--home", home]);
  console.log("");

  const installed = listFiles(home);
  check("no `bin/` anywhere under HOME", !installed.some((p) => /(^|[/\\])bin[/\\]/.test(p)), installed.join(", "));
  check(
    "ruling 42's cross-vendor path appears",
    installed.some((p) => /\.agents[/\\]skills/.test(p)),
    installed.filter((p) => p.startsWith(".agents")).join(", "),
  );

  const healthy = details();
  check("claude loads the directory brigadier wrote", /skills-dir/.test(healthy), inventoryLine(healthy, "Skills"));
  check(
    `the hook is registered under its NAME (${REGISTERED_HOOK_EVENTS.join(", ")})`,
    missingHooks(healthy).length === 0,
    inventoryLine(healthy, "Hooks"),
  );

  // Ruling 60's negative, against the real binary rather than a fixture.
  const original = await Bun.file(hooksFile).text();
  const poisoned = JSON.parse(original);
  poisoned.hooks["NotARealEvent"] = [{ hooks: [{ type: "command", command: "true" }] }];
  writeFileSync(hooksFile, JSON.stringify(poisoned, null, 2));

  const discarded = details();
  check(
    "NEGATIVE CONTROL: one unrecognised event discards EVERY hook, silently",
    missingHooks(discarded).length === 1,
    `${inventoryLine(discarded, "Hooks")} — claude printed no warning about it`,
  );
  console.log("\n--- and this is brigadier saying what claude did not ---\n");
  const checkCode = hooksCheckCommand(["--home", home, "--host"]);
  check("`plugin hooks --check` names the key and blocks", checkCode === 1, `exit ${checkCode}`);

  writeFileSync(hooksFile, original);
  console.log("");
  uninstallCommand(["--home", home]);
  console.log("");
  // Not "the home is empty": running `claude` under a scratch HOME makes
  // `claude`'s OWN files there — `.claude/.claude.json` and a backup of it — and
  // an assertion that counted those would be asserting that another product
  // wrote nothing, which is neither true nor brigadier's business. Ruling 26's
  // claim is about brigadier's directories, so that is what is asserted.
  const left = listFiles(home).filter((p) => p.includes(PLUGIN_NAME));
  check(
    "uninstall is deleting the directory: nothing of brigadier's is left",
    left.length === 0,
    left.join(", ") || `<none — ${listFiles(home).length} unrelated file(s) claude itself created remain>`,
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n=== ${failures === 0 ? "all checks passed" : `${failures} FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
