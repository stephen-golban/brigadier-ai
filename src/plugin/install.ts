// SPDX-License-Identifier: Apache-2.0
/**
 * Where the asset goes, what is true about each place, and how it is removed.
 *
 * Ruling 26 is the frame: **nothing is installed, so uninstall is deleting the
 * directory.** There is no registry entry, no manifest of ours in a shared file,
 * no PATH edit and no marketplace record — which means the removal path cannot
 * leave a dangling reference, because there was never a reference.
 *
 * Ruling 8 is the constraint that produces that frame: **brigadier never writes
 * into a file another product owns.** No hooks in a shared settings file, no
 * `AGENTS.md` merge, no `~/.codex/config.toml` write — and therefore no
 * `~/.agents/plugins/marketplace.json` entry, since ruling 42 measured that its
 * install path is exactly that `config.toml` write.
 *
 * Ruling 42 is what makes the roots below two rather than one. Its measurements,
 * and the two this file adds, are recorded on each root's `discovery` line so a
 * reader meets the evidence beside the path rather than in a changelog.
 *
 * The honest shape of the result, which the printed output states rather than
 * implies:
 *
 *   **Hooks exist in exactly one place.** Claude Code is today the only host
 *   that reads hooks out of a directory brigadier owns. Everywhere else the
 *   asset is a skill and the trigger is MODEL DISCRETION — brigadier is reached
 *   when the agent reading `SKILL.md` decides it matches the task, which is not
 *   a guarantee and is never printed as one.
 *
 *   **There is no `bin/`.** Ruling 42 checked Codex, Cursor and three GUI
 *   clients for a `bin/`-on-`PATH` equivalent and found none, so the binary
 *   needs its own PATH story everywhere except Claude Code — and shipping a
 *   Claude-Code-only `bin/` would put a second copy of a 60 MB binary in a
 *   directory five other hosts ignore. brigadier prints the sentence instead.
 *
 *   **This is not six uniform clients.** Qwen is a MEASURED counterexample to
 *   `~/.agents/skills/` discovery, and ChatGPT is a permanent blank — a hosted
 *   surface has no filesystem for any of this to land on.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { assetFiles, binPaths, PLUGIN_NAME, type AssetFile, type AssetShape } from "./asset.ts";
import { REGISTERED_HOOK_EVENTS } from "./hooks.ts";

export interface InstallRoot {
  readonly id: "claude-code" | "cross-vendor";
  /** How a human names it. Item 10 and the operator both read this form. */
  readonly display: string;
  readonly shape: AssetShape;
  /** What was measured about discovery here, with the tool and the date. */
  readonly discovery: string;
  /** What actually causes brigadier to be reached from here. */
  readonly trigger: string;
}

export const INSTALL_ROOTS: readonly InstallRoot[] = [
  {
    id: "cross-vendor",
    display: `~/.agents/skills/${PLUGIN_NAME}/`,
    shape: { hooks: false, nestedSkill: false },
    discovery:
      "auto-discovered with no manifest and no install command — MEASURED on Codex, opencode, Gemini CLI, Copilot and Cursor. " +
      "Qwen is a MEASURED counterexample, so this is a broad convention and NOT a universal one. " +
      "ChatGPT is a permanent blank: a hosted surface has no filesystem.",
    trigger:
      "no hook is registered here, and none can be — the trigger is MODEL DISCRETION: brigadier is reached when " +
      "the agent reading SKILL.md decides it matches the task. That is not a guarantee.",
  },
  {
    id: "claude-code",
    display: `~/.claude/skills/${PLUGIN_NAME}/`,
    shape: { hooks: true, nestedSkill: true },
    discovery:
      "MEASURED against `claude 2.1.234` on macOS 26.5.2 on 2026-08-18: a plugin here loads as `<name>@skills-dir`, " +
      "and the SAME directory planted under ~/.agents/skills/ was NOT found at all. Honours CLAUDE_CONFIG_DIR.",
    trigger:
      `hooks are registered here, because this directory is brigadier's own — ruling 8. One event: ${REGISTERED_HOOK_EVENTS.join(", ")}.`,
  },
];

/**
 * The home directory, preferring `HOME` over the platform's own answer.
 *
 * `HOME` first on EVERY platform, deliberately. On Windows `os.homedir()` reads
 * `USERPROFILE`, and a harness that plants a scratch `HOME` while the real
 * `USERPROFILE` is still in the environment would silently install into the
 * operator's actual profile — `bar/lib/proc.ts` passes exactly that
 * environment. Ruling 12 makes Windows first class, so the fallback order is a
 * property of the product rather than of the harness.
 */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const home = env["HOME"];
  if (home !== undefined && home.length > 0) return home;
  const profile = env["USERPROFILE"];
  if (profile !== undefined && profile.length > 0) return profile;
  return homedir();
}

/** Claude Code's config root. `CLAUDE_CONFIG_DIR` is its own documented lever. */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env, home = resolveHome(env)): string {
  const configured = env["CLAUDE_CONFIG_DIR"];
  return configured !== undefined && configured.length > 0 ? configured : join(home, ".claude");
}

/** The absolute directory this root installs into. */
export function rootDirectory(
  root: InstallRoot,
  env: Record<string, string | undefined> = process.env,
  home = resolveHome(env),
): string {
  return root.id === "claude-code"
    ? join(claudeConfigDir(env, home), "skills", PLUGIN_NAME)
    : join(home, ".agents", "skills", PLUGIN_NAME);
}

export interface PlannedFile {
  readonly root: InstallRoot;
  readonly directory: string;
  readonly absolute: string;
  readonly file: AssetFile;
}

/**
 * Every file the install would write, computed before anything is created.
 *
 * Ruling 53's shape applied one level down: a plan that can be printed without
 * touching the disk is a plan someone can disagree with before it runs, and
 * `--dry-run` below is that plan and nothing else.
 */
export function planInstall(
  env: Record<string, string | undefined> = process.env,
  home = resolveHome(env),
): PlannedFile[] {
  const planned: PlannedFile[] = [];
  for (const root of INSTALL_ROOTS) {
    const directory = rootDirectory(root, env, home);
    for (const file of assetFiles(root.shape)) {
      planned.push({ root, directory, absolute: join(directory, ...file.path.split("/")), file });
    }
  }
  return planned;
}

/**
 * The `bin/` guard, run against the PLAN rather than asserted in a comment.
 *
 * Ruling 62b: every guard needs a demonstrated negative, and this one has one in
 * `test/plugin-install.test.ts` — a synthetic asset carrying `bin/brigadier` is
 * caught. Without that the guard and a `return []` are indistinguishable.
 */
export function plannedBinPaths(planned: readonly PlannedFile[]): string[] {
  return planned.filter((p) => binPaths([p.file]).length > 0).map((p) => p.absolute);
}

export interface InstallResult {
  readonly written: string[];
  readonly directories: string[];
  readonly refusal: string | undefined;
}

/** Write the asset. Idempotent: an existing install is overwritten in place. */
export function install(
  env: Record<string, string | undefined> = process.env,
  home = resolveHome(env),
): InstallResult {
  const planned = planInstall(env, home);
  const offending = plannedBinPaths(planned);
  if (offending.length > 0) {
    return {
      written: [],
      directories: [],
      refusal:
        `refused — the asset would write ${offending.join(", ")}, and ruling 42 measured that no ` +
        "`bin/`-on-PATH equivalent exists outside Claude Code. Nothing was written.",
    };
  }
  const written: string[] = [];
  for (const entry of planned) {
    mkdirSync(dirname(entry.absolute), { recursive: true });
    writeFileSync(entry.absolute, entry.file.contents);
    written.push(entry.absolute);
  }
  return {
    written,
    directories: [...new Set(planned.map((p) => p.directory))],
    refusal: undefined,
  };
}

export interface RemovedRoot {
  readonly root: InstallRoot;
  readonly directory: string;
  /** Files that were there when it was removed. Evidence, not a count. */
  readonly files: string[];
  readonly existed: boolean;
}

/**
 * Ruling 26: uninstall is deleting the directory, because nothing was installed.
 *
 * The listing is taken BEFORE the removal on purpose. "Removed 9 files" printed
 * after the fact is a number nobody can check; the paths are what a reader
 * compares against what they expected to be there.
 */
export function uninstall(
  env: Record<string, string | undefined> = process.env,
  home = resolveHome(env),
): RemovedRoot[] {
  const removed: RemovedRoot[] = [];
  for (const root of INSTALL_ROOTS) {
    const directory = rootDirectory(root, env, home);
    const existed = existsSync(directory);
    const files = existed ? listFiles(directory) : [];
    if (existed) rmSync(directory, { recursive: true, force: true });
    removed.push({ root, directory, files, existed });
  }
  return removed;
}

/** Every file under a directory, as forward-slash paths relative to it. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path);
      else out.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * What the operator reads. Ruling 71's discipline: state the things that cannot
 * be learned anywhere else, at the moment they become true.
 */
export function describeInstall(result: InstallResult, planned: readonly PlannedFile[], dryRun: boolean): string[] {
  const lines: string[] = [];
  if (result.refusal !== undefined) return [result.refusal];

  lines.push(dryRun ? "brigadier install --dry-run — nothing was written." : "brigadier installed.");
  lines.push("");
  for (const root of INSTALL_ROOTS) {
    const mine = planned.filter((p) => p.root.id === root.id);
    const directory = mine[0]?.directory ?? "";
    lines.push(`${root.display}`);
    lines.push(`  path      ${directory}`);
    for (const entry of mine) lines.push(`  ${(dryRun ? "would write" : "wrote").padEnd(11)} ${entry.file.path}`);
    lines.push(`  discovery ${root.discovery}`);
    lines.push(`  trigger   ${root.trigger}`);
    lines.push("");
  }
  lines.push(
    "No `bin/` was written anywhere, and none can be: ruling 42 checked Codex, Cursor and three GUI",
    "  clients for a `bin/`-on-PATH equivalent and found none. Put the `brigadier` binary on your PATH",
    "  yourself — installing this skill does not and cannot do it for you.",
    "Nothing outside the two directories above was touched. No shared settings file, no AGENTS.md merge,",
    "  no ~/.codex/config.toml, no marketplace entry (ruling 8).",
    "To remove it: delete those directories, or run `brigadier uninstall`. Nothing was registered",
    "  anywhere else, so there is nothing else to undo (ruling 26).",
  );
  return lines;
}

export function describeUninstall(removed: readonly RemovedRoot[]): string[] {
  const lines: string[] = ["brigadier uninstalled — the directories were deleted, which is the whole of it.", ""];
  for (const entry of removed) {
    lines.push(`${entry.root.display}`);
    lines.push(`  path      ${entry.directory}`);
    if (!entry.existed) {
      lines.push("  absent    nothing was there — reported rather than passed over in silence");
      lines.push("");
      continue;
    }
    for (const file of entry.files) lines.push(`  removed   ${file}`);
    lines.push("");
  }
  lines.push(
    "Nothing else was undone because nothing else was ever done: no registry entry, no PATH edit, no",
    "  line in a file another product owns (rulings 26 and 8).",
  );
  return lines;
}
