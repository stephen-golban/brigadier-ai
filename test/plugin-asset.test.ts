// SPDX-License-Identifier: Apache-2.0
/**
 * The asset itself: what is in it, what every host looks for, and the two traps
 * that would be invisible if nothing asserted them.
 *
 * Ruling 26 ships ONE directory carrying BOTH manifest formats, ruling 42
 * corrected which names those are, and ruling 59 makes one sentence in
 * `SKILL.md` a defect. None of the three shows up as a failing test on its own —
 * a wrong manifest name is a plugin that silently never loads, and a stray
 * `AGENTS.md` in the skill text is a route to finding 114 that reads as helpful
 * documentation.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetFiles,
  binPaths,
  CLAUDE_SKILL_PATH,
  HOOKS_PATH,
  HOOKS_TEXT,
  MANIFEST_NAMES,
  MANIFEST_TEXT,
  PLUGIN_NAME,
  repositoryDoctrineRisks,
  SKILL_PATH,
  SKILL_TEXT,
} from "../src/plugin/asset.ts";
import { REGISTERED_HOOK_EVENTS } from "../src/plugin/hooks.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const claudeShape = { hooks: true, nestedSkill: true } as const;
const crossVendorShape = { hooks: false, nestedSkill: false } as const;

describe("the bytes come from assets/plugin/, and nowhere else", () => {
  test("SKILL.md is the file on disk, verbatim", () => {
    expect(SKILL_TEXT).toBe(readFileSync(join(ROOT, "assets/plugin/SKILL.md"), "utf8"));
  });

  test("the JSON assets round-trip to exactly the same object", () => {
    // The compiled asset is re-serialised rather than copied, so the assertion
    // that matters is semantic identity, not byte identity. See asset.ts.
    for (const [source, shipped] of [
      ["assets/plugin/plugin.json", MANIFEST_TEXT],
      ["assets/plugin/hooks/hooks.json", HOOKS_TEXT],
    ] as const) {
      expect(JSON.parse(shipped)).toEqual(JSON.parse(readFileSync(join(ROOT, source), "utf8")));
    }
  });

  test("both JSON assets are parseable — malformed JSON is a silent zero", () => {
    expect(() => JSON.parse(MANIFEST_TEXT)).not.toThrow();
    expect(() => JSON.parse(HOOKS_TEXT)).not.toThrow();
  });
});

describe("ruling 26: one asset, all the manifest names", () => {
  test("three names, one manifest", () => {
    // #39 measured VS Code reading a BARE plugin.json; #26 measured Codex
    // reading .codex-plugin/plugin.json; Claude Code reads .claude-plugin/.
    expect(MANIFEST_NAMES).toEqual([
      "plugin.json",
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
    ]);
    const files = assetFiles(claudeShape);
    const manifests = files.filter((f) => MANIFEST_NAMES.includes(f.path));
    expect(manifests).toHaveLength(3);
    for (const manifest of manifests) expect(manifest.contents).toBe(MANIFEST_TEXT);
  });

  test("the manifest names the plugin, and the name is the directory name", () => {
    expect(JSON.parse(MANIFEST_TEXT).name).toBe(PLUGIN_NAME);
  });
});

describe("ruling 42: the shapes differ, because the hosts were measured to differ", () => {
  test("the cross-vendor root is a skill and nothing else", () => {
    const paths = assetFiles(crossVendorShape).map((f) => f.path);
    expect(paths).toContain(SKILL_PATH);
    expect(paths).not.toContain(HOOKS_PATH);
    expect(paths).not.toContain(CLAUDE_SKILL_PATH);
  });

  test("the Claude Code root carries the hook and the MEASURED nested skill", () => {
    const paths = assetFiles(claudeShape).map((f) => f.path);
    expect(paths).toContain(HOOKS_PATH);
    // MEASURED against `claude 2.1.234` on 2026-08-18: a SKILL.md at the plugin
    // ROOT reports `Skills (0)`; skills/<name>/SKILL.md reports `Skills (1)`.
    expect(paths).toContain(CLAUDE_SKILL_PATH);
    expect(paths).toContain(SKILL_PATH);
  });

  test("the two skill copies are the same bytes, so neither can be the stale one", () => {
    const files = assetFiles(claudeShape);
    const root = files.find((f) => f.path === SKILL_PATH);
    const nested = files.find((f) => f.path === CLAUDE_SKILL_PATH);
    expect(root?.contents).toBe(nested?.contents);
  });

  test("no `bin/` in either shape", () => {
    expect(binPaths(assetFiles(claudeShape))).toEqual([]);
    expect(binPaths(assetFiles(crossVendorShape))).toEqual([]);
  });

  test("NEGATIVE CONTROL: a `bin/` in the asset is caught", () => {
    // Without this the guard and `return []` are indistinguishable (ruling 62b).
    expect(binPaths([{ path: "bin/brigadier", contents: "" }])).toEqual(["bin/brigadier"]);
    expect(binPaths([{ path: "hooks/bin/wrapper.sh", contents: "" }])).toEqual(["hooks/bin/wrapper.sh"]);
    expect(binPaths([{ path: "binary-notes.md", contents: "" }])).toEqual([]);
  });
});

describe("ruling 60: the shipped hooks.json carries exactly one event", () => {
  test("one event, and it is PreCompact", () => {
    const events = Object.keys(JSON.parse(HOOKS_TEXT).hooks);
    expect(events).toEqual(["PreCompact"]);
    expect(events).toEqual([...REGISTERED_HOOK_EVENTS]);
  });

  test("the shape is the MEASURED one — a `hooks` wrapper of event arrays", () => {
    const parsed = JSON.parse(HOOKS_TEXT);
    expect(Array.isArray(parsed.hooks.PreCompact)).toBe(true);
    expect(parsed.hooks.PreCompact[0].hooks[0].type).toBe("command");
  });
});

describe("ruling 59: the skill text must not manufacture finding 114's third route", () => {
  test("SKILL.md names no repository instruction file at all", () => {
    expect(repositoryDoctrineRisks()).toEqual([]);
  });

  test("NEGATIVE CONTROL: a text that names one is caught", () => {
    expect(repositoryDoctrineRisks("Add this to your AGENTS.md and workers will delegate.")).toEqual([
      "AGENTS.md",
    ]);
    expect(repositoryDoctrineRisks("Your CLAUDE.md is a fine place for this.")).toEqual(["CLAUDE.md"]);
  });

  test("and it states the prohibition rather than merely omitting it", () => {
    expect(SKILL_TEXT).toContain("Do not copy it into a repository");
  });
});

describe("SKILL.md says the things that cannot be learned anywhere else", () => {
  test("frontmatter carries the name and a description", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(SKILL_TEXT)?.[1] ?? "";
    expect(frontmatter).toContain(`name: ${PLUGIN_NAME}`);
    expect(/^description: \S/m.test(frontmatter)).toBe(true);
  });

  test("the trigger outside Claude Code is stated as model discretion", () => {
    expect(SKILL_TEXT).toContain("model discretion");
  });

  test("the PATH story is stated, because no host provides one", () => {
    // Ruling 77 changed what that story IS. Until 2026-08-21 this asserted
    // "Put the `brigadier` binary wherever you keep binaries" — correct while
    // ruling 26 said there was no PATH install. `brigadier setup` now installs
    // a launcher, so the skill has to name the command instead of telling a
    // reader to do it themselves.
    expect(SKILL_TEXT).toContain("PATH");
    expect(SKILL_TEXT).toContain("brigadier setup");
    // And the default is still that brigadier does not edit your shell profile.
    // If this text ever stops saying so, ruling 77's default has been reversed
    // in the asset a model reads without being reversed in a ruling.
    expect(SKILL_TEXT).toContain("--modify-path");
  });

  test("the worker refusal is stated, because a worker may be reading it", () => {
    expect(SKILL_TEXT).toContain("A worker cannot orchestrate");
  });
});
