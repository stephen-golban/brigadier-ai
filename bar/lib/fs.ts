// SPDX-License-Identifier: Apache-2.0
/**
 * Filesystem evidence: hashes, listings, and canaries.
 *
 * These exist to satisfy one rule, which is ruling 62's evidence standard turned
 * into code: **assert on the escaped bytes, never on a flag the product printed
 * about itself.** v1's finding 41 is that a flag assertion survives a refactor
 * that removes the property it was standing in for — the boolean kept being
 * `false` after nothing was left to set it `true`.
 *
 * So an item proving containment plants a canary OUTSIDE the boundary and
 * asserts the file does not exist, or hashes a tree before and after and asserts
 * the digest is unchanged. Both are statements about the world rather than about
 * the product's opinion of itself, and neither can be satisfied by a refactor.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Remove a directory only if nothing is in it. Never recursive, never forced. */
export function pruneEmpty(path: string): void {
  try {
    if (readdirSync(path).length === 0) rmdirSync(path);
  } catch {
    // Absent, non-empty, or someone else's — all three mean leave it alone.
  }
}

/** Every file under `root`, as repository-style forward-slash relative paths. */
export function listTree(root: string, skip: (name: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (skip(entry)) continue;
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
 * One digest over a whole tree: path, size and contents of every file.
 *
 * Paths are included, not just contents, so that a file MOVED inside the tree
 * changes the digest. "Nothing was touched" has to mean the listing too, or a
 * rename reads as identical.
 */
export function hashTree(root: string, skip?: (name: string) => boolean): string {
  const hash = createHash("sha256");
  for (const rel of listTree(root, skip)) {
    hash.update(rel);
    hash.update("\0");
    try {
      hash.update(readFileSync(join(root, rel)));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Digest of one file, or `absent` — the two are different observations. */
export function hashFile(path: string): string {
  if (!existsSync(path)) return "absent";
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface CanaryReport {
  path: string;
  escaped: boolean;
  detail: string;
}

/**
 * Did anything reach a path outside the boundary?
 *
 * The canary is asserted by ABSENCE, which is the only form that cannot be
 * faked by the thing under test: there is no flag to read, and a product that
 * escaped leaves the bytes behind whether or not it noticed.
 */
export function canary(path: string): CanaryReport {
  if (!existsSync(path)) return { path, escaped: false, detail: "does not exist" };
  let contents = "";
  try {
    contents = readFileSync(path, "utf8").slice(0, 200);
  } catch {
    contents = "<unreadable>";
  }
  return { path, escaped: true, detail: `EXISTS, ${contents.length} bytes: ${JSON.stringify(contents)}` };
}

/**
 * Write an executable script, with the platform's calling convention.
 *
 * Synchronous on purpose: the file has to exist before the next line plants a
 * `PATH` that points at it, and an un-awaited `Bun.write` is exactly the kind of
 * race that makes an item flaky and then disabled.
 */
export function writeScript(path: string, posixBody: string, windowsBody: string): string {
  if (process.platform === "win32") {
    const target = path.endsWith(".cmd") ? path : `${path}.cmd`;
    writeFileSync(target, windowsBody);
    return target;
  }
  writeFileSync(path, posixBody);
  chmodSync(path, 0o755);
  return path;
}
