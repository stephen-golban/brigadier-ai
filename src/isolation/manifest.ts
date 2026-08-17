// SPDX-License-Identifier: Apache-2.0
/**
 * The run manifest: brigadier's record of which directories are worker clones,
 * written BEFORE the directory it records exists.
 *
 * Ruling 15's ownership proofs are three, and a manifest is one of them. This
 * module exists because the other two were not enough on their own, and the way
 * that was found is worth keeping: a blind critic observed that the worker-clone
 * signature lived inside `.git`, where an agent owns every byte. Deleting
 * `.git/brigadier-clone` takes one command, and `refs/heads/brigadier-base`
 * disappears without any hostile intent at all — MEASURED against `git 2.50.1`
 * on 2026-08-17, `git pack-refs --all` moves it into `packed-refs` and removes
 * the loose file, and ordinary `git gc` runs `pack-refs`. A signature that a
 * routine maintenance command erases is not a durable record of anything.
 *
 * So the durable half moved OUT of the clone. The manifest sits beside the
 * clones rather than inside one, at
 * `<run root>/r/<run id>/manifest.json`, and it is written before the first
 * clone directory is created — which is also the ordering ruling 50's ref rule
 * requires of it, so the two uses agree.
 *
 * Honest about its reach: an agent that can write anywhere in the operator's
 * home directory can delete this file too. It is not a boundary against an
 * agent that has already escaped its sandbox. It is the record that survives
 * the things an agent does INSIDE the directory it was given, which is the case
 * the erased signature failed at.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeRegularFile } from "./safe-fs.ts";

export const MANIFEST_NAME = "manifest.json";

export interface ManifestClone {
  item: number;
  /** The clone directory, by `realpath`, as it will be created. */
  dir: string;
  createdAt: number;
}

export interface RunManifest {
  runId: string;
  runRoot: string;
  createdAt: number;
  clones: ManifestClone[];
}

export function manifestPath(runRoot: string, runDirName: string, runId: string): string {
  return join(runRoot, runDirName, runId, MANIFEST_NAME);
}

export function readManifest(path: string): RunManifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const manifest = parsed as RunManifest;
    return Array.isArray(manifest.clones) ? manifest : null;
  } catch {
    // A manifest brigadier cannot read is not a manifest that grants anything.
    // The caller treats null as "no record", which fails toward refusing.
    return null;
  }
}

/**
 * Record a clone before it exists.
 *
 * Read-modify-write rather than append-only, because a run has several items
 * and they share one file. Written with the symlink-refusing writer for the
 * same reason everything else in this module is.
 */
export function recordClone(path: string, manifest: RunManifest, clone: ManifestClone): void {
  const existing = readManifest(path);
  const merged: RunManifest =
    existing === null ? manifest : { ...existing, clones: [...existing.clones] };
  merged.clones = merged.clones.filter((entry) => entry.item !== clone.item);
  merged.clones.push(clone);
  writeRegularFile(path, `${JSON.stringify(merged, null, 2)}\n`);
}

/**
 * Is this path inside a directory some run manifest claims as a worker clone?
 *
 * Walks up from the candidate, because a git command's cwd can be any
 * subdirectory of the clone. Returns the manifest that made the claim, so the
 * refusal can name it.
 */
export function claimedByManifest(candidate: string): string | null {
  let current = candidate;
  for (;;) {
    const path = join(dirname(current), MANIFEST_NAME);
    const manifest = readManifest(path);
    if (manifest !== null && manifest.clones.some((clone) => clone.dir === current)) return path;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
