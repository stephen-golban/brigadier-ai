// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 83. Decision 17's suppression, per vendor, and the shim that carries it
 * on Claude.
 *
 * **THE FAILURE THIS FILE EXISTS FOR IS SILENT**, and that is what makes it
 * different from the lever it replaces. A config-root redirect that stops
 * working fails loudly — the vendor refuses the metered call and the run stops.
 * An argv rewrite that stops working fails by *succeeding*: the worker runs, the
 * turn completes, the bill is paid, and the operator's user-global instruction
 * files are in its context. Nothing goes red. So the rewrite is asserted here
 * against the argv MEASURED coming out of the real bridge, and the generated
 * shim is executed rather than read.
 *
 * Every assertion has its opposite beside it, so a guard that always passes
 * cannot look like a working one.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AMBIENT_KEEP_SOURCES,
  ambientDecision,
  ambientShimPath,
  ambientShimScript,
  planAmbient,
  rewriteSettingSources,
  writeAmbientShim,
} from "../src/agent/ambient.ts";
import { PROFILES, buildEnvironment } from "../src/agent/profiles.ts";

/**
 * The argv `@agentclientprotocol/claude-agent-acp` 0.70.0 was MEASURED passing
 * to `claude` on 2026-08-21, captured from a shim rather than transcribed from a
 * document.
 *
 * Kept whole rather than trimmed to the interesting flag: the rewrite has to
 * leave the other fourteen arguments exactly where they were, and a fixture that
 * held only the flag could not show that.
 */
const BRIDGE_ARGV = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  "--permission-prompt-tool",
  "stdio",
  "--disallowedTools",
  "AskUserQuestion",
  "--tools",
  "default",
  "--setting-sources=user,project,local",
  "--permission-mode",
  "bypassPermissions",
  "--allow-dangerously-skip-permissions",
  "--include-partial-messages",
  "--session-id=48284109-fb1c-49be-b824-27d1562f23de",
  "--replay-user-messages",
];

describe("the rewrite drops the user source and nothing else", () => {
  test("the measured bridge argv comes back with `user` gone and its length unchanged", () => {
    const rewritten = rewriteSettingSources(BRIDGE_ARGV);
    expect(rewritten).toHaveLength(BRIDGE_ARGV.length);
    expect(rewritten).toContain(`--setting-sources=${AMBIENT_KEEP_SOURCES}`);
    expect(rewritten).not.toContain("--setting-sources=user,project,local");
    // The negative control for "it rewrote the right one": every other argument
    // survives, in order.
    expect(rewritten.filter((arg) => !arg.startsWith("--setting-sources"))).toEqual(
      BRIDGE_ARGV.filter((arg) => !arg.startsWith("--setting-sources")),
    );
  });

  test("APPEND-IF-ABSENT: a bridge that stops passing the flag still gets suppression", () => {
    const without = BRIDGE_ARGV.filter((arg) => !arg.startsWith("--setting-sources"));
    const rewritten = rewriteSettingSources(without);
    // This is the one that matters. A rewrite-only implementation would return
    // the input unchanged here and suppression would be off with nothing red.
    expect(rewritten).toHaveLength(without.length + 1);
    expect(rewritten.at(-1)).toBe(`--setting-sources=${AMBIENT_KEEP_SOURCES}`);
  });

  test("the space form is replaced together with its value", () => {
    const rewritten = rewriteSettingSources(["--verbose", "--setting-sources", "user,project", "--tools", "default"]);
    expect(rewritten).toEqual(["--verbose", `--setting-sources=${AMBIENT_KEEP_SOURCES}`, "--tools", "default"]);
    expect(rewritten).not.toContain("user,project");
  });

  test("`user` is what is being dropped, and project and local are what is kept", () => {
    expect(AMBIENT_KEEP_SOURCES).toBe("project,local");
    expect(AMBIENT_KEEP_SOURCES).not.toContain("user");
  });
});

describe("the generated shim does what the rewrite does — executed, not read", () => {
  test("it rewrites the measured bridge argv when run as a real program", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brigadier-shim-"));
    // The shim's target is a program that prints its own argv, so what comes
    // back IS what the vendor binary would have received.
    const echo = join(dir, "echo-argv.sh");
    writeFileSync(echo, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
    chmodSync(echo, 0o700);
    const shim = writeAmbientShim(join(dir, "shim.sh"), echo);

    const ran = Bun.spawnSync([shim, ...BRIDGE_ARGV]);
    expect(ran.exitCode).toBe(0);
    const seen = new TextDecoder().decode(ran.stdout).trim().split("\n");
    expect(seen).toContain(`--setting-sources=${AMBIENT_KEEP_SOURCES}`);
    expect(seen).not.toContain("--setting-sources=user,project,local");
    // Order and content of everything else, through a real `exec`.
    expect(seen.filter((arg) => !arg.startsWith("--setting-sources"))).toEqual(
      BRIDGE_ARGV.filter((arg) => !arg.startsWith("--setting-sources")),
    );

    // And the append half, through the same real program.
    const without = BRIDGE_ARGV.filter((arg) => !arg.startsWith("--setting-sources"));
    const appended = Bun.spawnSync([shim, ...without]);
    expect(appended.exitCode).toBe(0);
    expect(new TextDecoder().decode(appended.stdout).trim().split("\n")).toContain(
      `--setting-sources=${AMBIENT_KEEP_SOURCES}`,
    );
  });

  test("it is written executable by its owner and by nobody else", () => {
    const dir = mkdtempSync(join(tmpdir(), "brigadier-shim-"));
    const shim = writeAmbientShim(join(dir, "shim.sh"), "/bin/echo");
    expect(Bun.file(shim).size).toBeGreaterThan(0);
    // A file that decides what a metered process runs. Read through `statSync`
    // rather than a `stat` binary, whose flags differ between BSD and GNU — and
    // asserted only where the platform has POSIX modes at all, without skipping
    // the test, because ruling 62 makes a skipped test a failed gate.
    const mode = statSync(shim).mode & 0o777;
    if (process.platform === "win32") expect(mode & 0o400).not.toBe(0);
    else expect(mode).toBe(0o700);
  });

  test("the target is embedded, so the shim does not depend on what else is set", () => {
    const script = ambientShimScript("/some/where/claude");
    expect(script).toContain('exec "/some/where/claude"');
    expect(script.startsWith("#!/bin/sh")).toBe(true);
  });
});

describe("which lever each vendor gets", () => {
  const conditions = { suppress: true, platform: "darwin" as NodeJS.Platform, hasTarget: true };

  test("claude gets the argv shim and NOT the config-root redirect", () => {
    const decided = ambientDecision(PROFILES.claude, conditions);
    expect(decided.lever).toBe("argv-shim");
    expect(decided.note).toContain("--setting-sources=project,local");
    // The whole of ruling 83: this vendor's config root is left alone.
    expect(decided.note).toContain("config root is NOT redirected");
  });

  test("every other vendor with a config-root variable keeps the redirect", () => {
    for (const id of ["codex", "copilot", "qwen", "opencode"] as const) {
      const decided = ambientDecision(PROFILES[id], conditions);
      expect(decided.lever).toBe("config-root");
    }
  });

  test("a vendor with no lever at all says so rather than claiming suppression", () => {
    // Gemini declares no config-root variable — #42 could not even establish its
    // root — so nothing is suppressed there and the record has to say it.
    const decided = ambientDecision(PROFILES.gemini, conditions);
    expect(decided.lever).toBe("none");
    expect(decided.note).toContain("NO ambient lever exists");
    expect(decided.note).not.toContain("redirected");
  });

  test("the operator's override pulls no lever on any vendor", () => {
    for (const profile of Object.values(PROFILES)) {
      const decided = ambientDecision(profile, { ...conditions, suppress: false });
      expect(decided.lever).toBe("none");
      expect(decided.note).toContain("ambientSuppression: false");
    }
  });

  test("win32 and a missing binary both fall back to the redirect, and say which", () => {
    const onWindows = ambientDecision(PROFILES.claude, { ...conditions, platform: "win32" });
    expect(onWindows.lever).toBe("config-root");
    expect(onWindows.note).toContain("UNMEASURED on win32");

    const noBinary = ambientDecision(PROFILES.claude, { ...conditions, hasTarget: false });
    expect(noBinary.lever).toBe("config-root");
    expect(noBinary.note).toContain("no claude binary");
    // The fallback is not silently better: it is the lever measured to cost the
    // credential, and the note has to say so or an operator reads a refusal
    // with no cause.
    expect(noBinary.note).toContain("cost this vendor its credential");
  });
});

describe("what a spawn actually gets", () => {
  const inputs = {
    suppress: true,
    ownedDir: "/run/owned",
    shimPath: "/run/shim.sh",
    platform: "darwin" as NodeJS.Platform,
    resolveTarget: () => "/usr/local/bin/claude",
    write: (path: string) => path,
  };

  test("claude gets CLAUDE_CODE_EXECUTABLE and no config root", () => {
    const plan = planAmbient(PROFILES.claude, inputs);
    expect(plan.env["CLAUDE_CODE_EXECUTABLE"]).toBe("/run/shim.sh");
    expect(plan.configRoot).toBeUndefined();
    // And the environment built from it carries no CLAUDE_CONFIG_DIR, which is
    // the property the credential depends on.
    const env = buildEnvironment(PROFILES.claude, { kind: "read-only", extra: plan.env });
    expect(env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(env["CLAUDE_CODE_EXECUTABLE"]).toBe("/run/shim.sh");
  });

  test("codex gets a config root and no shim", () => {
    const plan = planAmbient(PROFILES.codex, inputs);
    expect(plan.configRoot).toBe("/run/owned");
    expect(plan.env).toEqual({});
    const env = buildEnvironment(PROFILES.codex, { kind: "write", configRoot: plan.configRoot ?? "" });
    expect(env["CODEX_HOME"]).toBe("/run/owned");
  });

  test("the override leaves both levers alone", () => {
    const plan = planAmbient(PROFILES.claude, { ...inputs, suppress: false });
    expect(plan.configRoot).toBeUndefined();
    expect(plan.env).toEqual({});
  });

  test("the shim lives beside the item directories and never inside a clone", () => {
    const path = ambientShimPath("/root", "r7");
    expect(path).toBe(join("/root", "r", "r7", "claude-exec-shim.sh"));
    // A `write` item's clone is diffed and merged; a brigadier file inside one
    // would reach the operator's repository.
    expect(path).not.toContain(join("r", "r7", "1"));
  });
});

describe("the profile row is the measurement", () => {
  test("claude declares the argv lever and still declares its config root", () => {
    // Both, deliberately: the redirect is still what win32 and a missing binary
    // fall back to, so deleting the variable would silently remove the fallback.
    expect(PROFILES.claude.ambientLever).toEqual({
      kind: "argv-shim",
      variable: "CLAUDE_CODE_EXECUTABLE",
      binary: "claude",
    });
    expect(PROFILES.claude.configRootEnv).toBe("CLAUDE_CONFIG_DIR");
  });

  test("no other profile declares one, so absence still means the redirect", () => {
    const declared = Object.values(PROFILES).filter((profile) => profile.ambientLever !== undefined);
    expect(declared.map((profile) => profile.id)).toEqual(["claude"]);
  });

  test("the source file carries the measurement rather than the assertion alone", () => {
    const source = readFileSync(new URL("../src/agent/ambient.ts", import.meta.url), "utf8");
    // The date and the control, because a table with no control is what ruling
    // 38's amendment had when it stopped at session/new.
    expect(source).toContain("MEASURED 2026-08-21");
    expect(source).toContain("session/prompt");
  });
});
