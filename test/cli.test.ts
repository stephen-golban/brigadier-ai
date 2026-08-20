// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal surface, driven as a process.
 *
 * Everything else about drift and competence is unit-tested against the
 * functions. This file exists for the one property those cannot show: that the
 * functions are actually REACHED. `driftFor`, `laneFailureBlocks` and
 * `overrideWarning` were a complete, on-spec implementation of ruling 69 with
 * zero call sites outside their own module, and every unit test passed the
 * whole time. A test that spawns the CLI is the only kind that would have
 * failed.
 *
 * A fake ACP agent is planted from the bar's harness rather than a second one
 * written here, so that the thing this file drives is the thing the release bar
 * drives.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plantAgent } from "../bar/lib/fake-agent.ts";
import { isLineAnchor } from "../bar/items/05-review-is-cross-vendor.ts";
import { PROFILES } from "../src/agent/profiles.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function brigadier(args: string[], env?: Record<string, string>) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    ...(env ? { env } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("brigadier competence (ruling 68)", () => {
  const result = brigadier(["competence"]);
  const rows = result.stdout.split("\n").filter((l) => l.trim().length > 0 && !/^\s*#/.test(l));

  test("the subcommand exists and prints the table from inside the binary", () => {
    expect(result.code).toBe(0);
    expect(rows.length).toBeGreaterThan(0);
  });

  test("every printed row carries its evidence class and a citation", () => {
    for (const row of rows) expect(row).toMatch(/\((measured|benchmark|vendor|editorial): \S/);
  });

  test("no printed row carries a line anchor", () => {
    expect(rows.filter(isLineAnchor)).toEqual([]);
  });

  test("a model the table has not heard of is named rather than silently excluded", () => {
    expect(rows.some((r) => /unranked/.test(r))).toBe(true);
  });

  test("it is discoverable — `--help` names it", () => {
    expect(brigadier(["--help"]).stdout).toContain("brigadier competence");
  });
});

describe("a per-machine bridge override is read and announced (ruling 69)", () => {
  const dir = mkdtempSync(join(tmpdir(), "brigadier-override-"));
  const configHome = join(dir, "config");
  const env = { PATH: process.env["PATH"] ?? "", HOME: dir, XDG_CONFIG_HOME: configHome };

  test("NEGATIVE CONTROL: with no config file, the table is the shipped coordinate", () => {
    const before = brigadier(["agents"], env);
    expect(before.stdout).toContain(`command    ${PROFILES.codex.command} ${PROFILES.codex.args.join(" ")}`);
    expect(before.stderr).toBe("");
  });

  test("the overridden coordinate is what the table describes, and the warning is loud", () => {
    mkdirSync(join(configHome, "brigadier"), { recursive: true });
    writeFileSync(
      join(configHome, "brigadier", "bridges.json"),
      JSON.stringify([{ agent: "codex", command: "/opt/fixed-codex-acp", args: ["--acp"] }]),
    );
    const after = brigadier(["agents"], env);
    // A table that described the shipped coordinate while another one ran is
    // exactly the staleness ruling 69 exists to catch.
    expect(after.stdout).toContain("command    /opt/fixed-codex-acp --acp");
    expect(after.stderr).toContain("every measured fact in its launch profile is now unverified");
  });

  test("a malformed file is reported rather than silently ignored", () => {
    writeFileSync(join(configHome, "brigadier", "bridges.json"), "{ not json");
    const broken = brigadier(["agents"], env);
    expect(broken.stderr).toContain("not valid JSON");
    // and the shipped coordinate is still what runs
    expect(broken.stdout).toContain(`command    ${PROFILES.codex.command} ${PROFILES.codex.args.join(" ")}`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("brigadier detect reports drift (ruling 69)", () => {
  /**
   * qwen is planted rather than a bridged agent because a bridged one runs
   * through `npx` and cannot be put on a PATH this test controls. Its profile
   * declares NO lane assertion, which makes it the harder case rather than the
   * easier one: the output still has to say what a drift would have blocked.
   */
  const dir = mkdtempSync(join(tmpdir(), "brigadier-cli-"));
  const bin = join(dir, "bin");
  const env = { PATH: bin, HOME: dir };
  const measured = PROFILES.qwen.measuredVersion;

  test("a version that moved is reported, and graded by what it can silently break", () => {
    plantAgent(bin, "qwen", { name: "qwen", version: "99.0.0-moved" });
    const human = brigadier(["detect", "qwen", "--timeout", "10000"], env);
    expect(human.stdout).toContain("99.0.0-moved");
    expect(human.stdout).toContain("drift");
    expect(human.stdout).toContain(`measured against ${measured}`);
    // Recorded, never pinned: still usable, because agents auto-update and a
    // product that stops after every vendor release is not a product.
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("usable");
    // Capabilities warn — a stale one costs finding 71's visible empty diff.
    expect(human.stdout).toMatch(/warn\s+capabilities/);
    // And what did NOT block is said, rather than left to be inferred.
    expect(human.stdout).toContain("lane assertion");
    expect(human.stdout).toContain("BLOCKS");

    const json = brigadier(["detect", "qwen", "--timeout", "10000", "--json"], env);
    const parsed = JSON.parse(json.stdout) as Array<{ drift?: Array<{ field: string; severity: string }> }>;
    expect(parsed[0]?.drift?.map((d) => [d.field, d.severity])).toEqual([["capabilities", "warn"]]);
  });

  test("NEGATIVE CONTROL: at the version the profile was measured against, nothing drifts", () => {
    // The check that keeps the one above honest. A binary that printed the
    // drift block unconditionally would satisfy every assertion above and this
    // is the only thing that would catch it.
    plantAgent(bin, "qwen", { name: "qwen", version: measured });
    const human = brigadier(["detect", "qwen", "--timeout", "10000"], env);
    expect(human.stdout).toContain("usable");
    expect(human.stdout).not.toContain("drift");
    expect(human.stdout).not.toContain("lane assertion");

    const json = brigadier(["detect", "qwen", "--timeout", "10000", "--json"], env);
    expect(JSON.parse(json.stdout)[0].drift).toBeUndefined();
  });

  test("an agent that never answered is not accused of drifting", () => {
    // An unknown is not a change. `absent` carries no version, so there is
    // nothing to compare and nothing is invented to stand in for it.
    const human = brigadier(["detect", "qwen", "--timeout", "10000"], { PATH: join(dir, "empty"), HOME: dir });
    expect(human.stdout).toContain("absent");
    expect(human.stdout).not.toContain("drift");
    rmSync(dir, { recursive: true, force: true });
  });
});
