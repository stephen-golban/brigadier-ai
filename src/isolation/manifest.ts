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
 * That ordering is ENFORCED here rather than asserted and checked later.
 * `recordClone` writes the entry, creates the directory itself with an
 * exclusive `mkdir`, and stores the inode `mkdir` allocated. What a later sweep
 * checks is then an identity — "this directory is the one that entry created" —
 * instead of a chronology reconstructed from timestamps after the fact. The
 * chronology was only ever a proxy for the identity, and it was a proxy that
 * read two different clocks: see `createdAt` below and `src/run/reclaim.ts`.
 *
 * None of that makes the manifest unforgeable, and the paragraph above is not
 * to be read as saying so. Whoever can write this file can write an entry with
 * an inode they read off the directory themselves. `src/run/reclaim.ts`'s
 * header states the reach of each of ruling 15's three proofs and names the
 * forgery that gets through; the honest boundary is (a), containment by
 * `realpath`, and it is the only one of the three that is not file contents.
 *
 * Honest about its reach: an agent that can write anywhere in the operator's
 * home directory can delete this file too. It is not a boundary against an
 * agent that has already escaped its sandbox. It is the record that survives
 * the things an agent does INSIDE the directory it was given, which is the case
 * the erased signature failed at.
 */

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeRegularFile } from "./safe-fs.ts";

export const MANIFEST_NAME = "manifest.json";

/**
 * The inode brigadier's own `mkdir` allocated for a clone directory.
 *
 * STRINGS, not numbers, and that is not fussiness: an inode number is 64 bits
 * and JSON's number type is a double, so `4611686018427387904 + 1` does not
 * survive a round trip. `lstatSync(dir, { bigint: true })` reads dev and ino
 * exactly — MEASURED against `bun 1.3.14` on macOS 26.5.2 on 2026-08-20, the
 * fields come back as `bigint` — and `toString()` carries them through the file
 * without rounding. An identity that silently rounds is an identity that
 * silently matches the wrong directory.
 *
 * `ino` is what gets compared; `dev` is carried for the refusal to print. See
 * `sameInode` for why comparing `dev` refuses legitimate clones, and
 * `usableIdentity` for the volumes whose inode numbers identify nothing.
 */
export interface CloneIdentity {
  dev: string;
  ino: string;
}

export interface ManifestClone {
  item: number;
  /** The clone directory, by `realpath`, as it will be created. */
  dir: string;
  /**
   * Wall clock at the moment of recording. A RECORD, never a proof.
   *
   * `src/run/reclaim.ts` used to compare this against `statSync(dir).birthtimeMs`
   * and refuse when it was the larger. That is a comparison between two
   * different clocks: `Date.now()` reads the fine-grained system clock and an
   * inode timestamp comes from the kernel's coarse clock, which on Linux lags
   * it. Do not reintroduce any comparison between this field and a filesystem
   * timestamp; `identity` below is what ownership is proved with.
   */
  createdAt: number;
  /**
   * The inode `recordClone` created for this entry, read back from the
   * filesystem immediately afterwards.
   *
   * In an entry brigadier wrote it is absent only where the process died
   * between the record and the creation — but the field is JSON like everything
   * else here, so an entry that was not written by brigadier carries whatever
   * its author put there. `proveDeletableDirectory` treats an absent or unusable
   * identity as unproven and retains the directory; it does not treat a present
   * one as proof of authorship.
   */
  identity?: CloneIdentity;
  /**
   * A random token generated when this entry was recorded, and written into the
   * clone's own marker file.
   *
   * RULED 2026-08-20 (the owner having delegated the round's rulings), because
   * `identity` above is VACUOUS on the ordinary Linux filesystem. MEASURED on
   * `ubuntu:24.04` on 2026-08-20, 300 delete-then-recreate trials at one path
   * per filesystem: ext4 returned the SAME inode 300/300 and overlayfs 300/300,
   * against 0/300 on tmpfs and 0/300 on APFS. Birth time was measured dead as a
   * replacement the same day — `birthtimeNs` identical in 194/200 ext4 trials —
   * and is not to be proposed again.
   *
   * So the third of ruling 15's proofs held on the owner's machine and held
   * nothing on the platform ruling 12 makes first class. Every other byte of
   * that proof is derivable from the path: a directory that takes a clone's
   * address can reconstruct the marker's claim and, on ext4, be handed the same
   * inode. A random token is derivable from nothing.
   *
   * Absent in an entry written by a brigadier from before this date.
   * `proveDeletableDirectory` treats an absent or unusable nonce as UNPROVEN and
   * retains the directory — see its refusal for the decision and its cost.
   */
  nonce?: string;
}

/**
 * A fresh clone nonce. 128 bits, hex, from the CSPRNG.
 *
 * The length is not about brute force — a forger who can read the run root
 * reads the token rather than guessing it, and that boundary is stated in
 * `src/run/reclaim.ts`'s header. It is about COLLISION: this token has to be
 * different from every other clone's on the machine, including clones of runs
 * that are already gone, so that a stale entry can never match a live directory.
 */
export function newCloneNonce(): string {
  return randomBytes(16).toString("hex");
}

/** A nonce that actually discriminates: 32 hex digits, and not all zeroes. */
export function usableNonce(nonce: unknown): nonce is string {
  return typeof nonce === "string" && /^[0-9a-f]{32}$/.test(nonce) && !/^0+$/.test(nonce);
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
 * Record a clone before it exists, CREATE it, and record which inode that was.
 *
 * The record and the creation are one indivisible claim, and splitting them is
 * what let the two disagree. "Written BEFORE anything was created" used to be
 * an assertion nobody enforced, checked long afterwards by comparing a
 * `Date.now()` in the file against a filesystem timestamp — two clocks that
 * disagree on Linux, in both directions. Here the ordering is a property of the
 * code path instead: the entry is written, the directory is created by a
 * NON-RECURSIVE `mkdir` that fails if anything is already there, and the entry
 * is rewritten with the inode that `mkdir` allocated.
 *
 * Three writes in a fixed order, and each one is load-bearing:
 *
 *   1. the entry WITHOUT its identity — the ruling 15 (b) record, on disk
 *      before the directory exists, so a crash here leaves a claim that grants
 *      nothing rather than a directory nothing claims;
 *   2. `mkdirSync(dir)`, exclusive: EEXIST is the answer this wants, because a
 *      manifest entry is an authorisation to CREATE and never a description of
 *      something already standing;
 *   3. the entry WITH its identity, truncating the same file in place —
 *      `writeRegularFile` opens `O_TRUNC` rather than renaming, so the manifest
 *      keeps the inode and the birth time it had at step 1.
 *
 * Read-modify-write rather than append-only, because a run has several items
 * and they share one file. Written with the symlink-refusing writer for the
 * same reason everything else in this module is.
 */
export function recordClone(path: string, manifest: RunManifest, clone: ManifestClone): void {
  writeEntry(path, manifest, clone);
  const identity = createRecordedDirectory(clone.dir);
  writeEntry(path, manifest, { ...clone, identity });
}

function writeEntry(path: string, manifest: RunManifest, clone: ManifestClone): void {
  const existing = readManifest(path);
  const merged: RunManifest =
    existing === null ? manifest : { ...existing, clones: [...existing.clones] };
  merged.clones = merged.clones.filter((entry) => entry.item !== clone.item);
  merged.clones.push(clone);
  writeRegularFile(path, `${JSON.stringify(merged, null, 2)}\n`);
}

/** `mkdir` the recorded directory, refusing to adopt one, and read back its inode. */
function createRecordedDirectory(dir: string): CloneIdentity {
  try {
    mkdirSync(dir);
  } catch (error) {
    throw new Error(
      `ruling 15 (b): refusing to record ${dir} — brigadier could not create it as a new, empty ` +
        `directory (${(error as Error).message}). A manifest entry is an AUTHORISATION TO CREATE ` +
        "rather than a description of something that already stands: an occupied path is not " +
        "brigadier's to claim and later delete, and a missing parent means the run root was " +
        "never prepared.",
    );
  }
  const identity = directoryIdentity(dir);
  if (identity === null) {
    throw new Error(
      `ruling 15 (b): created ${dir} and then could not read its inode back. Without that, the ` +
        "entry cannot say WHICH directory it authorised, and a record that cannot be matched to " +
        "a directory is a record that must never authorise a delete.",
    );
  }
  return identity;
}

/**
 * The inode at `dir`, as the filesystem reports it now, or `null`.
 *
 * `lstat`, never `stat`: if something replaced the directory with a symlink,
 * the identity that matters is the link's own, which will not match what was
 * recorded. Following it would report the target's inode instead and hand back
 * a match for a directory brigadier never created.
 *
 * One reader for both sides — the record and the check — on purpose. Two
 * readers is how the two ends of a comparison come to mean different things.
 */
export function directoryIdentity(dir: string): CloneIdentity | null {
  try {
    const stat = lstatSync(dir, { bigint: true });
    if (!stat.isDirectory()) return null;
    return { dev: stat.dev.toString(), ino: stat.ino.toString() };
  } catch {
    return null;
  }
}

/**
 * The INODE only. `dev` is recorded and never compared.
 *
 * btrfs, ZFS, overlayfs and tmpfs are given an ANONYMOUS BDEV allocated when
 * they are mounted, so the same filesystem reports a different `st_dev` after a
 * remount or a reboot. `sweepAtStart` exists to read runs an EARLIER process
 * recorded, which makes a later boot the ordinary path rather than an edge
 * case, so comparing `dev` refuses legitimate clones on four common Linux
 * filesystems. It stays in the file because a refusal that prints where the
 * directory used to live is a better report than one that does not.
 */
export function sameInode(a: CloneIdentity, b: CloneIdentity): boolean {
  return a.ino === b.ino;
}

/**
 * An inode number that actually identifies something.
 *
 * Digits, and not zero. A volume that keeps no inode numbers reports 0 for
 * every file on it — Windows volumes without a file index do, and libuv hands
 * that 0 straight through — and an identity of 0 matches EVERY directory
 * equally, which is a guard that has silently stopped guarding. Refusing it
 * costs a retained directory on such a volume and says why.
 */
export function usableInode(ino: unknown): boolean {
  return typeof ino === "string" && /^[0-9]+$/.test(ino) && !/^0+$/.test(ino);
}

/** The same rule, applied to a recorded entry that may not have one at all. */
export function usableIdentity(identity: CloneIdentity | undefined): identity is CloneIdentity {
  return identity !== undefined && identity !== null && usableInode(identity.ino);
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
