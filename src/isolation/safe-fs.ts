// SPDX-License-Identifier: Apache-2.0
/**
 * Filesystem writes that refuse to be redirected.
 *
 * Every write in this module lands on a path an agent can reach — `.git/config`
 * inside its own clone, the state directory beside it. `writeFileSync` and
 * `copyFileSync` both FOLLOW SYMLINKS at the destination, so a clone whose
 * `.git/config` is a symlink to a file outside the clone turns brigadier's
 * restore into an arbitrary overwrite of that file. MEASURED against
 * `bun 1.3.14` on 2026-08-17: the write lands on the target, the call exits 0,
 * nothing throws, and `.git/config` is still a symlink afterwards — so the
 * clone goes on reading its configuration from a path the agent chose.
 *
 * The rule here is REFUSE, NEVER REPAIR. Replacing the symlink with a regular
 * file would be a silent fix for a directory that has just demonstrated
 * something is wrong with it; ruling 15's shape is to stop and say so.
 */

import { closeSync, constants, lstatSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";

export class UnsafePath extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePath";
  }
}

/** `O_NOFOLLOW` where the platform has it. Windows does not, and the lstat below carries it there. */
const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

/**
 * Write `contents` to `path`, refusing anything that is not already a plain,
 * single-linked regular file.
 *
 * `nlink > 1` is refused as well as a symlink: a hard link to a file outside
 * the clone is the same write-through with no symlink to see, and truncating
 * through it hits the same inode.
 */
export function writeRegularFile(path: string, contents: string): void {
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(path);
  } catch {
    stat = null;
  }
  if (stat !== null) {
    if (stat.isSymbolicLink()) {
      throw new UnsafePath(
        `refusing to write through a symlink: ${path}. A write here would land wherever the ` +
          "link points, which is a path brigadier did not choose. This directory is not in a " +
          "state brigadier will repair.",
      );
    }
    if (!stat.isFile()) {
      throw new UnsafePath(`refusing to write to ${path}, which is not a regular file`);
    }
    if (stat.nlink > 1) {
      throw new UnsafePath(
        `refusing to write to ${path}, which has ${stat.nlink} links: truncating it would ` +
          "write through to whatever else shares the inode",
      );
    }
  }

  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

/**
 * Delete and recreate a directory, empty.
 *
 * `rmSync` with `recursive` removes a symlink rather than following it —
 * MEASURED against `bun 1.3.14` on 2026-08-17 with a link pointing at a
 * directory holding a file, which survived. The explicit lstat is here anyway,
 * because that behaviour is a property of the runtime rather than of this code,
 * and this is the line that would silently empty somebody's home directory if
 * it ever changed.
 */
export function resetDirectory(path: string): void {
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(path);
  } catch {
    stat = null;
  }
  if (stat !== null && !stat.isDirectory()) {
    // A symlink or a plain file standing where a directory belongs: unlink it
    // and only it.
    rmSync(path, { force: true });
  } else if (stat !== null) {
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(path, { recursive: true });
}
