// SPDX-License-Identifier: Apache-2.0
/**
 * The distribution asset: one directory of files, and every name a host looks for.
 *
 * Ruling 26 settled the shape — ONE plugin directory carrying BOTH manifest
 * formats — and ruling 42 corrected three of its guesses by measuring the hosts.
 * What survives measurement is this:
 *
 *   The cross-vendor user-global unit is `~/.agents/skills/<name>/SKILL.md`,
 *   auto-discovered with NO manifest and NO install command. MEASURED on Codex,
 *   opencode, Gemini CLI, Copilot and Cursor — with **Qwen a measured
 *   counterexample**, which is why nothing brigadier prints calls it universal.
 *
 *   `~/.agents/plugins/` holds only a `marketplace.json`, whose install path
 *   writes `~/.codex/config.toml`. Ruling 8 bars that outright, so the asset
 *   has no marketplace entry and brigadier never offers to write one.
 *
 *   The manifest name is NOT uniform. #26 measured Codex reading the
 *   vendor-namespaced `.codex-plugin/plugin.json`; #39 measured VS Code reading
 *   a BARE `plugin.json`; Claude Code reads its own `.claude-plugin/plugin.json`.
 *   So the same manifest bytes are written under all three names. Three names,
 *   one file on disk here, and therefore nothing to keep in sync.
 *
 * Two shapes were MEASURED against `claude 2.1.234` on macOS 26.5.2 on
 * 2026-08-18, and both contradict what a reader would reasonably assume:
 *
 *   Claude Code does NOT discover `~/.agents/skills/`. A complete plugin planted
 *   there reported `Plugin "probeplug" not found` and `claude plugin list` said
 *   `No plugins installed`. The same directory under `~/.claude/skills/` loaded
 *   as `probeplug@skills-dir`. The two roots are genuinely different places and
 *   the asset goes to both.
 *
 *   Inside a Claude Code skills-directory plugin the skill must live at
 *   `skills/<name>/SKILL.md`. A `SKILL.md` at the plugin ROOT reported
 *   `Skills (0)`; adding `skills/probeplug/SKILL.md` reported `Skills (1)
 *   probeplug`. Ruling 42's cross-vendor path wants the root copy and Claude
 *   Code wants the nested one, so under that root the asset ships BOTH — the
 *   same bytes, so a reader comparing them finds no second version to be wrong.
 *
 * The bytes come from `assets/plugin/**` through Bun's text imports, so the
 * files a maintainer edits are exactly the files a user receives. See
 * `assets.d.ts` for why that is an import rather than a generated module.
 */

import hooksJson from "../../assets/plugin/hooks/hooks.json";
import manifestJson from "../../assets/plugin/plugin.json";
import skillMarkdown from "../../assets/plugin/SKILL.md" with { type: "text" };

/** The directory name under each root, and the name inside every manifest. */
export const PLUGIN_NAME = "brigadier";

export const SKILL_TEXT: string = skillMarkdown;

/**
 * The two JSON assets are imported as VALUES and re-serialised, while the skill
 * is imported as text. That asymmetry is not an oversight and it is worth a
 * sentence, because the obvious uniform version does not typecheck:
 *
 *   `tsc` resolves a `.json` specifier itself and types it as the PARSED object,
 *   and `module: "Preserve"` turns `resolveJsonModule` on, so a wildcard
 *   `declare module "*.json"` is shadowed rather than consulted. Importing JSON
 *   `with { type: "text" }` therefore compiles to an object type while Bun hands
 *   the program a string — types and runtime disagreeing silently, which is the
 *   one failure mode nothing here would catch.
 *
 * Re-serialising removes the disagreement instead of casting it away, and it
 * removes a second one for free: the bytes written to disk are canonical, so
 * whitespace in `assets/plugin/*.json` cannot drift away from what a user
 * receives. `test/plugin-asset.test.ts` asserts the round trip.
 */
export const MANIFEST_TEXT = `${JSON.stringify(manifestJson, null, 2)}\n`;
export const HOOKS_TEXT = `${JSON.stringify(hooksJson, null, 2)}\n`;

/**
 * Every name the same manifest bytes are written under.
 *
 * Ruling 26's "ship both", widened to three by #39's bare-`plugin.json`
 * measurement. Ordered vendor-neutral first so a listing reads as one asset with
 * aliases rather than as three vendors' files.
 */
export const MANIFEST_NAMES: readonly string[] = [
  "plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];

/** Ruling 42's cross-vendor unit: the file every measured host discovers. */
export const SKILL_PATH = "SKILL.md";

/** MEASURED: where Claude Code counts a skill inside a skills-directory plugin. */
export const CLAUDE_SKILL_PATH = `skills/${PLUGIN_NAME}/SKILL.md`;

/** Ruling 60's one-event file. Written only where its host reads it. */
export const HOOKS_PATH = "hooks/hooks.json";

/** One file the asset writes: a path relative to the plugin directory, and its bytes. */
export interface AssetFile {
  /** Forward slashes, always, so a listing compares equal across platforms. */
  readonly path: string;
  readonly contents: string;
}

export interface AssetShape {
  /**
   * Write `hooks/hooks.json`.
   *
   * Ruling 8: hooks are registered ONLY inside a directory brigadier owns whose
   * host actually reads hooks from it — today that is Claude Code alone. Writing
   * the file into a root where nothing reads it would not be a violation, but it
   * would be a file claiming a capability that does not exist there, and the
   * install output would then have to explain it away.
   */
  readonly hooks: boolean;
  /** Write the MEASURED nested `skills/<name>/SKILL.md` as well as the root one. */
  readonly nestedSkill: boolean;
}

/**
 * The files this shape writes, in a stable order.
 *
 * Sorted by path so two installs are comparable and a test can assert on the
 * listing rather than on the order a loop happened to take.
 */
export function assetFiles(shape: AssetShape): AssetFile[] {
  const files: AssetFile[] = [{ path: SKILL_PATH, contents: SKILL_TEXT }];
  for (const name of MANIFEST_NAMES) files.push({ path: name, contents: MANIFEST_TEXT });
  if (shape.nestedSkill) files.push({ path: CLAUDE_SKILL_PATH, contents: SKILL_TEXT });
  if (shape.hooks) files.push({ path: HOOKS_PATH, contents: HOOKS_TEXT });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The asset carries no executable and no `bin/`, and this proves it rather than
 * asserting it in prose.
 *
 * Ruling 42 checked for a `bin/`-on-`PATH` equivalent on Codex, Cursor and three
 * GUI clients and found none, so a `bin/` would be a Claude-Code-only convention
 * shipped to five hosts that ignore it — and a second copy of a 60 MB binary in
 * every one of them. The PATH story is a sentence brigadier prints instead.
 */
export function binPaths(files: readonly AssetFile[]): string[] {
  return files.map((f) => f.path).filter((p) => /(^|\/)bin(\/|$)/.test(p));
}

/**
 * Names of repository-level instruction files. `SKILL.md` may not mention one.
 *
 * Ruling 59 settles #34: a repository's own instruction file is finding 114's
 * THIRD route to a worker that orchestrates instead of working, and brigadier's
 * documentation must never suggest putting delegation doctrine in one — that
 * would be manufacturing the route ourselves. `AGENTS.md` obeys this by saying
 * nothing about delegation; `SKILL.md` cannot, because delegation is its whole
 * subject, so it obeys it by never naming a file that lives in a repository.
 *
 * A blanket ban on the NAMES rather than a search for imperatives, and that is
 * the deliberate choice: "add this to your AGENTS.md" and "your AGENTS.md is a
 * fine place for this" are the same suggestion, and a guard that looks for verbs
 * catches the first and not the second.
 */
export const REPOSITORY_DOCTRINE_FILES: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "QWEN.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  "CONVENTIONS.md",
];

/**
 * Ruling 62b: a demonstrated negative, so this cannot be a guard that always
 * passes. `test/plugin-asset.test.ts` feeds it a text that names one.
 */
export function repositoryDoctrineRisks(text: string = SKILL_TEXT): string[] {
  return REPOSITORY_DOCTRINE_FILES.filter((name) => text.includes(name));
}
