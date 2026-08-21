// SPDX-License-Identifier: Apache-2.0
/**
 * The launcher shim, and the one line brigadier will not write for you.
 *
 * Ruling 77. Ruling 26 said *"there is no separate PATH install"* and ruling 42
 * measured why it could not have one: **no `bin/`-on-PATH equivalent exists
 * outside Claude Code**, checked on Codex and Cursor. Both were right while
 * brigadier was a skill nobody launched. Under ruling 75 a person types
 * `brigadier claude` and the session that opens is wearing brigadier, so
 * `brigadier` has to be a word the shell can resolve.
 *
 * **`claude --brigadier` cannot exist.** MEASURED against `claude 2.1.238` on
 * macOS 26.5.2 on 2026-08-21: it exits **1** with `error: unknown option
 * '--brigadier'`, against a `claude --help` control that exits 0. The vendor
 * owns its argv and no work on our side changes that.
 *
 * WHY A LAUNCHER AND NOT THE BINARY'S OWN DIRECTORY. The operator's binary
 * lives wherever they put it, which is often a downloads directory. Adding
 * *that* to `PATH` puts whatever else is in it on `PATH` too. So `PATH` gets
 * one stable entry brigadier owns — `<root>/bin` — and the file inside it
 * execs the real binary wherever it is. Replacing the binary does not change
 * the `PATH` entry, and nothing else ever appears in that directory.
 *
 * **Not a symlink.** Ruling 12 designs symlinks out from the start, for
 * Windows. A three-line script works identically on all three platforms and
 * fails legibly when its target is gone, where a dangling symlink fails as
 * `ENOENT` on a path the operator never typed.
 *
 * WHY SETUP DOES NOT EDIT YOUR SHELL PROFILE BY DEFAULT — ruling 77's ruled
 * position, and it rests on four measurements taken 2026-08-21:
 *
 *   1. There is no zero-edit route on macOS. `/etc/paths` is `/usr/local/bin`,
 *      `/System/Cryptexes/App/usr/bin`, `/usr/bin`, `/bin`, `/usr/sbin`,
 *      `/sbin`. **`~/.local/bin` is not in the system default**; where it is on
 *      `PATH` it is because a shell profile put it there.
 *   2. `/etc/paths.d/` is root-owned, needs `sudo`, and is outside every
 *      directory brigadier owns.
 *   3. **The profile edit has more silent failure modes than a missing shim.**
 *      Which file — `.zshrc`, `.zprofile`, `.zshenv`, `.bash_profile`, fish,
 *      nushell — is a guess, and on macOS `.zshenv` and `.zprofile` differ in
 *      priority. A guess that writes to a file sourced too early, or never, is
 *      a foreign edit that buys nothing **and reports success**. A shim that is
 *      not on `PATH` fails as `command not found`: loud, immediate, and
 *      unambiguous. Given a silent wrong write or a loud absence, this
 *      repository takes the loud absence.
 *   4. The flag is the authorisation — ruling 37's *capability comes from the
 *      human, never from data*, pointed at the installer.
 *
 * Ruling 8 is not breached on either path: its subject is *a file another
 * product owns*, and its own examples are `AGENTS.md`, `hooks.json` and MCP
 * config. A shell profile belongs to the operator. What `--modify-path` does
 * break is ruling 26's *uninstall is deleting the directory*, and that is
 * stated at the call site rather than here.
 */

import { delimiter, join } from "node:path";

/** The directory `PATH` gets, and the only one brigadier ever asks for. */
export function shimDirectory(root: string): string {
  return join(root, "bin");
}

export function shimPath(root: string, platform: NodeJS.Platform = process.platform): string {
  return join(shimDirectory(root), platform === "win32" ? "brigadier.cmd" : "brigadier");
}

/**
 * The launcher's contents.
 *
 * `exec` on POSIX so no shell process survives the launch — the shim must not
 * appear in the process tree, because ruling 38's sweep matches on a
 * command-line marker and an extra `sh` in the chain is one more thing for it
 * to reason about.
 *
 * The target is quoted on both platforms. A home directory with a space in it
 * is ordinary on macOS and Windows, and an unquoted path is the kind of defect
 * that works on every developer's machine and fails on a user's.
 */
export function shimText(binary: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return ["@echo off", `"${binary}" %*`, ""].join("\r\n");
  }
  return ["#!/bin/sh", "# brigadier's launcher (ruling 77). Replaced by `brigadier setup`.", `exec "${binary}" "$@"`, ""].join("\n");
}

/** Is a directory already on this `PATH`? Compared entry by entry, never by substring. */
export function onPath(directory: string, pathValue: string | undefined): boolean {
  if (pathValue === undefined || pathValue.length === 0) return false;
  const wanted = normalise(directory);
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => normalise(entry) === wanted);
}

/**
 * Trailing separators removed, and case folded on Windows only.
 *
 * macOS's default filesystem is case-insensitive too, but its `PATH` is not
 * conventionally treated that way and folding it would make `/Users/Stephen`
 * and `/users/stephen` the same entry in a report the operator reads. Windows
 * is folded because `C:\Users` and `c:\users` genuinely are one directory and a
 * report claiming otherwise would send someone to fix a non-problem.
 */
function normalise(entry: string): string {
  const trimmed = entry.replace(/[/\\]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * The line an operator adds, in their shell's own syntax.
 *
 * fish is not POSIX and `export PATH="..."` is a syntax error there, so a
 * single line printed for every shell would be wrong for one of the three most
 * common ones — and wrong in the way that produces a broken shell on next
 * login rather than an error at paste time.
 */
export function pathLine(directory: string, shell: Shell): string {
  return shell === "fish"
    ? `fish_add_path ${directory}`
    : `export PATH="${directory}:$PATH"`;
}

export type Shell = "zsh" | "bash" | "fish" | "unknown";

/** Which shell, from `$SHELL`. A guess, and named as one wherever it is printed. */
export function shellFrom(env: Record<string, string | undefined>): Shell {
  const raw = env["SHELL"];
  if (raw === undefined) return "unknown";
  const base = raw.split("/").pop() ?? "";
  if (base.includes("zsh")) return "zsh";
  if (base.includes("bash")) return "bash";
  if (base.includes("fish")) return "fish";
  return "unknown";
}

/**
 * The profile file for a shell, or nothing when brigadier does not know.
 *
 * **zsh gets `.zshrc` and this is a measured choice, not the doc-recommended
 * one.** Guides prefer `.zprofile` for `PATH`, because a `PATH` set in
 * `.zshenv` has lower priority. But MEASURED on the owner's machine on
 * 2026-08-21, `~/.zshrc` already carries **seven** `PATH`-touching lines,
 * several inside installer-written delimited blocks (`# pnpm` … `# pnpm end`).
 * Writing to the file every other installer chose keeps one file to audit and
 * one file to clean; writing to a second one on doctrinal grounds would leave
 * the operator with `PATH` edits in two places and no reason they could see.
 *
 * `unknown` returns nothing on purpose. A shell brigadier cannot name gets the
 * line printed and no file guessed at, which is the honest end of the guess.
 */
export function profileFor(shell: Shell, home: string): string | undefined {
  switch (shell) {
    case "zsh":
      return join(home, ".zshrc");
    case "bash":
      return join(home, ".bashrc");
    case "fish":
      return join(home, ".config", "fish", "config.fish");
    case "unknown":
      return undefined;
  }
}

export const BLOCK_START = "# brigadier";
export const BLOCK_END = "# brigadier end";

/**
 * The delimited block `--modify-path` writes, in pnpm's shape.
 *
 * Delimited because an uninstall has to remove **exactly** what was added.
 * v1's worst defect was a write into a file another product owned, and the
 * lesson this repository took from it is that the dangerous half of a write is
 * the half you cannot reverse. A marker pair is reversible by string match; a
 * bare appended line is reversible only by guessing which line was ours.
 */
export function profileBlock(directory: string, shell: Shell): string {
  return `${BLOCK_START}\n${pathLine(directory, shell)}\n${BLOCK_END}\n`;
}

/**
 * A profile's text with brigadier's block added, or `undefined` when it is
 * already there.
 *
 * Idempotent by returning nothing rather than by appending a second block:
 * running `setup --modify-path` twice is an ordinary thing to do, and two
 * blocks would double the entry on `PATH` and make removal ambiguous.
 */
export function withBlock(existing: string, directory: string, shell: Shell): string | undefined {
  if (existing.includes(BLOCK_START)) return undefined;
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  return `${existing}${separator}\n${profileBlock(directory, shell)}`;
}

/**
 * A profile's text with brigadier's block removed, or `undefined` when there
 * was none.
 *
 * **Removes only between the markers, and refuses a file where they do not
 * pair.** An unpaired marker means somebody edited inside the block, and
 * deleting from a start marker to end-of-file on that assumption is exactly the
 * *"delete a user's file by walking a computed path"* failure ruling 51 keeps
 * structurally impossible everywhere else.
 */
export function withoutBlock(existing: string): string | undefined | "unpaired" {
  const start = existing.indexOf(BLOCK_START);
  if (start === -1) return undefined;
  const end = existing.indexOf(BLOCK_END, start);
  if (end === -1) return "unpaired";
  const after = end + BLOCK_END.length;
  const trailing = existing.startsWith("\n", after) ? after + 1 : after;
  const before = existing.slice(0, start).replace(/\n+$/, "\n");
  return `${before}${existing.slice(trailing)}`;
}
