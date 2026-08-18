// SPDX-License-Identifier: Apache-2.0
/**
 * The three commands end to end, driven against a scratch home.
 *
 * `bar/items/10-the-artifact-ships.ts` drives the compiled binary and asserts on
 * what reaches stdout. These tests drive the same functions one layer in, on the
 * same predicates, so a failure lands here — where it names a line of code —
 * before it lands there, where it names a 60 MB file.
 *
 * The refusal in `installCommand` is the one thing here that is not about paths.
 * Finding 114 has three routes, and the installed plugin is the second of them
 * pointed backwards: a WORKER that installs brigadier's skill into the
 * operator's home has changed the operator's machine without being asked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_MARKER } from "../src/agent/marker.ts";
import { PLUGIN_NAME } from "../src/plugin/asset.ts";
import { REGISTERED_HOOK_EVENTS } from "../src/plugin/hooks.ts";
import {
  contextFrom,
  hooksCheckCommand,
  hooksSurface,
  installCommand,
  pluginCommand,
  uninstallCommand,
} from "../src/plugin/index.ts";
import { listFiles } from "../src/plugin/install.ts";

let home: string;

/**
 * Capture stdout without a subprocess.
 *
 * `AGENTS.md` forbids capturing multi-line output into a shell variable; there
 * is no shell here, and the lines are collected as an array rather than
 * re-parsed out of one string, which is the same rule's reason.
 */
function capture(run: () => number): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  try {
    return { code: run(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "brigadier-cmd-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env[WORKER_MARKER];
});

describe("install, run, remove — the whole of ruling 26's claim", () => {
  test("install exits 0 and the cross-vendor path really appears", () => {
    const { code, out } = capture(() => installCommand(["--home", home]));
    expect(code).toBe(0);
    expect(out).toContain(`~/.agents/skills/${PLUGIN_NAME}/`);
    expect(listFiles(home).some((p) => /\.agents[/\\]skills/.test(p))).toBe(true);
  });

  test("and no `bin/` appears anywhere — item 10's predicate, unchanged", () => {
    capture(() => installCommand(["--home", home]));
    expect(listFiles(home).some((p) => /(^|[/\\])bin[/\\]/.test(p))).toBe(false);
  });

  test("a fresh install then reports no problem", () => {
    capture(() => installCommand(["--home", home]));
    const { code, out } = capture(() => hooksCheckCommand(["--home", home]));
    expect(code).toBe(0);
    expect(out).toContain("no problem found");
  });

  test("uninstall removes both directories, and the home is clean afterwards", () => {
    capture(() => installCommand(["--home", home]));
    const { code, out } = capture(() => uninstallCommand(["--home", home]));
    expect(code).toBe(0);
    expect(out).toContain("removed");
    expect(existsSync(join(home, ".agents", "skills", PLUGIN_NAME))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", PLUGIN_NAME))).toBe(false);
    expect(listFiles(home)).toEqual([]);
  });

  test("--dry-run leaves the home untouched", () => {
    const { code, out } = capture(() => installCommand(["--home", home, "--dry-run"]));
    expect(code).toBe(0);
    expect(out).toContain("nothing was written");
    expect(listFiles(home)).toEqual([]);
  });
});

describe("NEGATIVE CONTROL: --check against poisoned and broken files", () => {
  test("the file item 10 plants is reported by name, and blocks", () => {
    capture(() => installCommand(["--home", home]));
    const poisonKey = "notARealEvent-a1b2c3";
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "hooks.json"),
      JSON.stringify({ PreCompact: [{ command: "echo ok" }], [poisonKey]: [{ command: "echo no" }] }, null, 2),
    );
    const { code, out } = capture(() => hooksCheckCommand(["--home", home]));
    expect(code).toBe(1);
    expect(out).toContain(poisonKey);
    expect(/(discard|ignored|unrecognis|unrecogniz|unknown event|invalid)/i.test(out)).toBe(true);
    expect(out).toContain("PROBLEMS ABOVE");
  });

  test("malformed JSON in brigadier's own file is reported", () => {
    capture(() => installCommand(["--home", home]));
    writeFileSync(join(home, ".claude", "skills", PLUGIN_NAME, "hooks", "hooks.json"), '{ "hooks": { oops\n');
    const { code, out } = capture(() => hooksCheckCommand(["--home", home]));
    expect(code).toBe(1);
    expect(out).toContain("MALFORMED");
  });

  test("a missing PreCompact is a run-level line (ruling 58)", () => {
    capture(() => installCommand(["--home", home]));
    writeFileSync(
      join(home, ".claude", "skills", PLUGIN_NAME, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "true" }] }] } }),
    );
    const { code, out } = capture(() => hooksCheckCommand(["--home", home]));
    expect(code).toBe(1);
    expect(out).toContain(`${REGISTERED_HOOK_EVENTS[0]} hook is not registered`);
  });

  test("checking a home with nothing installed says so rather than passing", () => {
    const { code, out } = capture(() => hooksCheckCommand(["--home", home]));
    expect(code).toBe(1);
    expect(out).toContain("not installed");
  });
});

describe("the hook surface prints NAMES", () => {
  const text = hooksSurface().join("\n");

  test("PreCompact is named", () => {
    expect(text).toContain("PreCompact");
  });

  test("every registered event gets its own line — a count alone would not do", () => {
    // Ruling 60: `.lsp.json` reported `LSP servers (1)` for `{"notARealKey": 1}`,
    // so a count is not evidence of anything. A surface that printed only "1
    // hook event" would satisfy a reader and tell them nothing, so the names are
    // asserted as LINES rather than as a substring of a paragraph.
    const lines = hooksSurface();
    for (const event of REGISTERED_HOOK_EVENTS) expect(lines).toContain(`  ${event}`);
  });

  test("the measured vocabulary is listed by name too, not summarised", () => {
    for (const event of ["Setup", "TeammateIdle", "PostCompact"]) expect(text).toContain(event);
  });

  test("the total-discard blast radius is stated", () => {
    expect(text).toContain("discards EVERY hook");
  });

  test("the file brigadier writes is shown, so the reader can compare it", () => {
    expect(text).toContain('"PreCompact"');
  });

  test("`plugin hooks` routes there and exits 0", () => {
    const { code, out } = capture(() => pluginCommand(["hooks"]));
    expect(code).toBe(0);
    expect(out).toContain("PreCompact");
  });

  test("an unknown plugin subcommand is a usage error, not a silent 0", () => {
    const { code, err } = capture(() => pluginCommand(["nonsense"]));
    expect(code).toBe(2);
    expect(err).toContain("unknown command");
  });
});

describe("finding 114's second route, pointed backwards", () => {
  test("a worker may not install, and is told why", () => {
    process.env[WORKER_MARKER] = "run-7/2";
    const { code, err } = capture(() => installCommand(["--home", home]));
    expect(code).toBe(3);
    expect(err).toContain("this session IS a brigadier worker");
    expect(listFiles(home)).toEqual([]);
  });

  test("a worker may not uninstall either", () => {
    process.env[WORKER_MARKER] = "run-7/2";
    expect(capture(() => uninstallCommand(["--home", home])).code).toBe(3);
  });

  test("but a worker MAY read the hook surface — reading causes no such failure", () => {
    process.env[WORKER_MARKER] = "run-7/2";
    const { code, out } = capture(() => pluginCommand(["hooks"]));
    expect(code).toBe(0);
    expect(out).toContain("PreCompact");
  });

  test("NEGATIVE CONTROL: outside a worker the same call installs", () => {
    delete process.env[WORKER_MARKER];
    expect(capture(() => installCommand(["--home", home])).code).toBe(0);
    expect(listFiles(home).length).toBeGreaterThan(0);
  });
});

describe("malformed argv does not become a directory", () => {
  test("NEGATIVE CONTROL: `--home --dry-run` does not resolve a home called --dry-run", () => {
    // The value is a path, so swallowing the next flag would create real
    // directories named `--dry-run` in the working directory, silently.
    expect(contextFrom(["--home", "--dry-run"]).home).not.toBe("--dry-run");
    expect(contextFrom(["--home"]).home).not.toBe("");
  });

  test("and a real value is still taken", () => {
    expect(contextFrom(["--home", "/scratch"]).home).toBe("/scratch");
  });
});
