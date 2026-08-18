// SPDX-License-Identifier: Apache-2.0
/**
 * Install, run, remove — driven against a scratch home rather than described.
 *
 * Ruling 26's claim is that **uninstall is deleting the directory, because
 * nothing was installed**, and the only way that claim can be checked is by
 * listing the filesystem afterwards. So every assertion here is about paths that
 * exist or do not exist, never about a sentence the product printed — the same
 * standard `bar/lib/fs.ts` sets for the release bar, applied one level down.
 *
 * The `bin/` assertion is written in the bar's own form on purpose: item 10
 * checks `!installedPaths.some((p) => /(^|[/\\])bin[/\\]/.test(p))` over a real
 * scratch `HOME`, and a unit test that checked something adjacent instead would
 * pass while the bar failed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CLAUDE_SKILL_PATH, HOOKS_PATH, PLUGIN_NAME, SKILL_PATH } from "../src/plugin/asset.ts";
import {
  claudeConfigDir,
  describeInstall,
  describeUninstall,
  install,
  INSTALL_ROOTS,
  listFiles,
  planInstall,
  plannedBinPaths,
  resolveHome,
  rootDirectory,
  uninstall,
  type PlannedFile,
} from "../src/plugin/install.ts";

let home: string;
/** `install()` takes the environment explicitly, so nothing here mutates the real one. */
const envFor = (h: string): Record<string, string | undefined> => ({ HOME: h });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "brigadier-install-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Every file under the scratch home, in the bar's own forward-slash form. */
function underHome(): string[] {
  return listFiles(home);
}

const crossVendor = (path: string) => join(home, ".agents", "skills", PLUGIN_NAME, ...path.split("/"));
const claudeCode = (path: string) => join(home, ".claude", "skills", PLUGIN_NAME, ...path.split("/"));

describe("where the asset lands", () => {
  test("both roots are written, and they are the two ruling 42 measured", () => {
    const result = install(envFor(home), home);
    expect(result.refusal).toBeUndefined();
    expect(result.directories.sort()).toEqual(
      [join(home, ".agents", "skills", PLUGIN_NAME), join(home, ".claude", "skills", PLUGIN_NAME)].sort(),
    );
    expect(existsSync(crossVendor(SKILL_PATH))).toBe(true);
    expect(existsSync(claudeCode(SKILL_PATH))).toBe(true);
  });

  test("ruling 42's cross-vendor path really appears under HOME", () => {
    install(envFor(home), home);
    // Item 10 asserts exactly this, over the listing rather than the output.
    expect(underHome().some((p) => /\.agents[/\\]skills/.test(p))).toBe(true);
  });

  test("hooks are written ONLY where a host reads them (ruling 8)", () => {
    install(envFor(home), home);
    expect(existsSync(claudeCode(HOOKS_PATH))).toBe(true);
    expect(existsSync(crossVendor(HOOKS_PATH))).toBe(false);
  });

  test("the MEASURED nested skill is written only under the Claude Code root", () => {
    install(envFor(home), home);
    expect(existsSync(claudeCode(CLAUDE_SKILL_PATH))).toBe(true);
    expect(existsSync(crossVendor(CLAUDE_SKILL_PATH))).toBe(false);
  });

  test("no `bin/` anywhere under HOME — item 10's own predicate", () => {
    install(envFor(home), home);
    const paths = underHome();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => /(^|[/\\])bin[/\\]/.test(p))).toBe(false);
  });

  test("nothing outside the two directories is created", () => {
    install(envFor(home), home);
    const strays = underHome().filter(
      (p) => !p.startsWith(`.agents/skills/${PLUGIN_NAME}/`) && !p.startsWith(`.claude/skills/${PLUGIN_NAME}/`),
    );
    expect(strays).toEqual([]);
  });

  test("installing twice changes nothing — it is idempotent", () => {
    install(envFor(home), home);
    const first = underHome();
    install(envFor(home), home);
    expect(underHome()).toEqual(first);
  });

  test("an existing foreign file beside the roots survives (ruling 8)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), '{"theirs":true}\n');
    install(envFor(home), home);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(Bun.file(join(home, ".claude", "settings.json")).size).toBeGreaterThan(0);
  });
});

describe("ruling 26: uninstall is deleting the directory", () => {
  test("the directories go, and the files that went are named", () => {
    install(envFor(home), home);
    const removed = uninstall(envFor(home), home);
    expect(removed).toHaveLength(2);
    for (const entry of removed) {
      expect(entry.existed).toBe(true);
      expect(entry.files.length).toBeGreaterThan(0);
      expect(existsSync(entry.directory)).toBe(false);
    }
    // The whole claim: nothing of brigadier's is left anywhere under the home.
    expect(underHome().filter((p) => p.includes(PLUGIN_NAME))).toEqual([]);
  });

  test("the listing is taken BEFORE the removal, so it is evidence", () => {
    install(envFor(home), home);
    const removed = uninstall(envFor(home), home);
    const claude = removed.find((r) => r.root.id === "claude-code");
    expect(claude?.files).toContain(HOOKS_PATH);
    expect(claude?.files).toContain(SKILL_PATH);
  });

  test("NEGATIVE CONTROL: uninstalling what was never installed says so", () => {
    // Ruling 52: a check with an outcome, not a silent nothing.
    const removed = uninstall(envFor(home), home);
    for (const entry of removed) {
      expect(entry.existed).toBe(false);
      expect(entry.files).toEqual([]);
    }
    expect(describeUninstall(removed).join("\n")).toContain("nothing was there");
  });

  test("a foreign file beside the roots is not deleted", () => {
    install(envFor(home), home);
    writeFileSync(join(home, ".claude", "settings.json"), '{"theirs":true}\n');
    uninstall(envFor(home), home);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
  });
});

describe("which home, and which config directory", () => {
  test("HOME wins over USERPROFILE on every platform (ruling 12)", () => {
    // bar/lib/proc.ts plants a scratch HOME while keeping the real USERPROFILE.
    // os.homedir() reads USERPROFILE on Windows, so preferring it would install
    // into the operator's real profile during a bar run.
    expect(resolveHome({ HOME: "/scratch", USERPROFILE: "C:\\Users\\real" })).toBe("/scratch");
    expect(resolveHome({ USERPROFILE: "C:\\Users\\real" })).toBe("C:\\Users\\real");
    expect(resolveHome({ HOME: "" , USERPROFILE: "C:\\Users\\real" })).toBe("C:\\Users\\real");
  });

  test("CLAUDE_CONFIG_DIR is honoured — it is Claude Code's own lever", () => {
    const elsewhere = join(home, "elsewhere");
    expect(claudeConfigDir({ HOME: home, CLAUDE_CONFIG_DIR: elsewhere }, home)).toBe(elsewhere);
    expect(claudeConfigDir({ HOME: home }, home)).toBe(join(home, ".claude"));
    const root = INSTALL_ROOTS.find((r) => r.id === "claude-code")!;
    expect(rootDirectory(root, { HOME: home, CLAUDE_CONFIG_DIR: elsewhere }, home)).toBe(
      join(elsewhere, "skills", PLUGIN_NAME),
    );
  });
});

describe("the `bin/` guard, and its demonstrated negative", () => {
  test("the real plan carries none", () => {
    expect(plannedBinPaths(planInstall(envFor(home), home))).toEqual([]);
  });

  test("NEGATIVE CONTROL: a plan that would write one is caught and refused", () => {
    const root = INSTALL_ROOTS[0]!;
    const directory = rootDirectory(root, envFor(home), home);
    const poisoned: PlannedFile[] = [
      {
        root,
        directory,
        absolute: join(directory, "bin", "brigadier"),
        file: { path: "bin/brigadier", contents: "" },
      },
    ];
    expect(plannedBinPaths(poisoned)).toEqual([join(directory, "bin", "brigadier")]);
    const refused = describeInstall(
      { written: [], directories: [], refusal: "refused — the asset would write bin/brigadier" },
      poisoned,
      false,
    );
    expect(refused.join("\n")).toContain("refused");
  });
});

describe("what the operator is told, which is the whole of the PATH story", () => {
  const lines = () => describeInstall(install(envFor(home), home), planInstall(envFor(home), home), false).join("\n");

  test("the cross-vendor path is named in the form a human recognises", () => {
    expect(lines()).toContain(`~/.agents/skills/${PLUGIN_NAME}/`);
  });

  test("no `bin/` is promised, and the PATH is handed back to the operator", () => {
    expect(lines()).toContain("No `bin/` was written anywhere");
    expect(lines()).toContain("PATH");
  });

  test("model discretion is stated plainly for every non-Claude host", () => {
    expect(lines()).toContain("MODEL DISCRETION");
  });

  test("it is not six uniform clients: Qwen and ChatGPT are named", () => {
    expect(lines()).toContain("Qwen is a MEASURED counterexample");
    expect(lines()).toContain("ChatGPT is a permanent blank");
  });

  test("ruling 8's untouched neighbours are listed, not implied", () => {
    const text = lines();
    expect(text).toContain("~/.codex/config.toml");
    expect(text).toContain("no marketplace entry");
  });

  test("removal is stated as deleting the directory", () => {
    expect(lines()).toContain("delete those directories");
  });

  test("--dry-run writes nothing", () => {
    const planned = planInstall(envFor(home), home);
    const text = describeInstall({ written: [], directories: [], refusal: undefined }, planned, true).join("\n");
    expect(text).toContain("nothing was written");
    expect(text).toContain("would write");
    expect(underHome()).toEqual([]);
  });
});

describe("the path separator is not assumed", () => {
  test("listFiles reports forward slashes whatever the platform uses", () => {
    // Ruling 12 makes Windows first class, and `sep` there is a backslash. The
    // assertion is unconditional on purpose: a platform-conditional expectation
    // is how a listing comparison passes on the machine that wrote it and fails
    // on the one CI runs, which `HOOKS_PATH` below would do silently.
    install(envFor(home), home);
    const nested = listFiles(join(home, ".claude", "skills", PLUGIN_NAME));
    expect(nested).toContain(HOOKS_PATH);
    expect(nested.every((p) => !p.includes("\\"))).toBe(true);
    expect(sep === "/" || sep === "\\").toBe(true);
  });
});
