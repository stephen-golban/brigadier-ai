// SPDX-License-Identifier: Apache-2.0
/**
 * The plugin subcommands, driven as a process.
 *
 * `test/plugin-commands.test.ts` drives `installCommand`, `uninstallCommand` and
 * `pluginCommand` directly and asserts on what they do to a scratch home. Every
 * one of those tests passed while the three functions had ZERO call sites — the
 * same shape as `driftFor`, `laneFailureBlocks` and `overrideWarning`, which
 * were a complete, on-spec implementation of ruling 69 that nothing reached.
 * This file exists for the one property a unit test cannot show: that
 * `src/cli.ts` actually dispatches to them, that `--help` names them, and that
 * the refusals fire at the boundary an operator or a host model can see.
 *
 * Every assertion is on the exit code and the bytes, because that is the whole
 * of what a shell or a host session can observe.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_NAME } from "../src/plugin/asset.ts";
import { REGISTERED_HOOK_EVENTS } from "../src/plugin/hooks.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ROOT = mkdtempSync(join(homedir(), ".brigadier-cli-plugin-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function brigadier(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: {
      HOME: ROOT,
      USER: process.env["USER"] ?? "test",
      PATH: process.env["PATH"] ?? "",
      NO_COLOR: "1",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function scratchHome(name: string): string {
  const home = join(ROOT, name);
  mkdirSync(home, { recursive: true });
  return home;
}

/** The two directories brigadier owns, and nothing else on the machine. */
function owned(home: string): string[] {
  return [join(home, ".agents", "skills", PLUGIN_NAME), join(home, ".claude", "skills", PLUGIN_NAME)];
}

describe("the three subcommands are reachable from the CLI", () => {
  test("`--help` names install, uninstall and plugin hooks", () => {
    const help = brigadier(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("brigadier install");
    expect(help.stdout).toContain("brigadier uninstall");
    expect(help.stdout).toContain("brigadier plugin hooks");
    // Spliced BEFORE the agent list, so the usage text still ends with it.
    expect(help.stdout.indexOf("brigadier install")).toBeLessThan(help.stdout.indexOf("Agents:"));
  });

  test("`plugin hooks` prints the surface by NAME", () => {
    const result = brigadier(["plugin", "hooks", "--home", scratchHome("hooks")]);
    expect(result.code).toBe(0);
    for (const event of REGISTERED_HOOK_EVENTS) expect(result.stdout).toContain(event);
    // Ruling 60: no count anywhere, because `LSP servers (1)` was measured for
    // `{"notARealKey": 1}` and a healthy-looking count is not evidence.
    expect(result.stdout).toContain("by name:");
  });

  test("`plugin` with an unknown subcommand is a usage error, not a crash", () => {
    const result = brigadier(["plugin", "definitely-not-a-subcommand"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command: plugin definitely-not-a-subcommand");
  });

  test("NEGATIVE CONTROL: an unknown TOP-LEVEL command is still unknown", () => {
    // Without this, "plugin dispatches" would also be satisfied by a binary
    // that accepted every word it was given.
    const result = brigadier(["plugih"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command: plugih");
  });
});

describe("install and uninstall reach the filesystem through the CLI", () => {
  const home = scratchHome("install");

  test("--dry-run writes nothing", () => {
    const result = brigadier(["install", "--dry-run", "--home", home]);
    expect(result.code).toBe(0);
    for (const dir of owned(home)) expect(existsSync(dir)).toBe(false);
  });

  test("install writes the two directories brigadier owns", () => {
    const result = brigadier(["install", "--home", home]);
    expect(result.code).toBe(0);
    for (const dir of owned(home)) expect(existsSync(dir)).toBe(true);
    // The `bin/` guard is ruling 42's: no `bin/`-on-PATH equivalent was
    // measured outside Claude Code, so nothing may create one.
    for (const dir of owned(home)) expect(existsSync(join(dir, "bin"))).toBe(false);
  });

  test("uninstall takes them away again, and that is the whole of it", () => {
    const result = brigadier(["uninstall", "--home", home]);
    expect(result.code).toBe(0);
    for (const dir of owned(home)) expect(existsSync(dir)).toBe(false);
  });
});

describe("ruling 57's shape: the refusal lives in the module, not in the dispatcher", () => {
  const marked = { BRIGADIER_WORKER: "some-run/3" };

  test("`install` refuses inside a worker and says why", () => {
    const home = scratchHome("worker-install");
    const result = brigadier(["install", "--home", home], marked);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("this session IS a brigadier worker");
    // Refused BEFORE anything was written: a refusal that first creates the
    // thing it is refusing has already done the thing it exists to prevent.
    for (const dir of owned(home)) expect(existsSync(dir)).toBe(false);
  });

  test("`uninstall` refuses inside a worker too", () => {
    const result = brigadier(["uninstall", "--home", scratchHome("worker-uninstall")], marked);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("this session IS a brigadier worker");
  });

  test("NEGATIVE CONTROL: `plugin hooks` stays READABLE inside a worker", () => {
    // The refusal is deliberately not in `ORCHESTRATING`. Reading a file cannot
    // cause finding 114, and a refusal that looks arbitrary teaches a model
    // trying to understand its situation nothing at all.
    const result = brigadier(["plugin", "hooks", "--home", scratchHome("worker-hooks")], marked);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("brigadier worker");
    for (const event of REGISTERED_HOOK_EVENTS) expect(result.stdout).toContain(event);
  });

  test("NEGATIVE CONTROL: the same install without the marker is not refused", () => {
    const home = scratchHome("unmarked-install");
    const result = brigadier(["install", "--home", home]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("brigadier worker");
    for (const dir of owned(home)) expect(existsSync(dir)).toBe(true);
  });
});
