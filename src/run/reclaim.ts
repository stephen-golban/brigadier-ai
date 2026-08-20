// SPDX-License-Identifier: Apache-2.0
/**
 * What may be deleted, and the proofs that have to be in hand first.
 *
 * RULING 15, EXTENDED BY RULING 50. A path is deletable only if it is
 *
 *   (a) inside brigadier's own root by **`realpath`**,
 *   (b) recorded in a manifest written BEFORE anything was created, and
 *   (c) carrying a marker file brigadier wrote.
 *
 * (b) AND (c) EACH GREW A TOKEN ON 2026-08-20, and the reason is a measurement
 * rather than a refinement. The identity half of (b) was the INODE, and the
 * inode identifies nothing on the ordinary Linux filesystem: MEASURED on
 * `ubuntu:24.04` that date, 300 delete-then-recreate trials at one path, ext4
 * returned the same inode **300/300** and overlayfs **300/300**, against 0/300
 * on tmpfs and 0/300 on APFS. Birth time was measured dead as a replacement the
 * same day (`birthtimeNs` identical in 194/200 ext4 trials). So brigadier now
 * generates a random token when it records a clone, stores it in the entry and
 * writes it into the marker, and the two must agree. Every other byte of (b) and
 * (c) is derivable from the clone's own address; the token is derivable from
 * nothing, which is the whole of what it adds. See `DirectoryProof.cloneNonce`
 * for the compatibility fork this raised, how it was ruled, and what that costs.
 *
 * All three, or refuse and report. There is no majority rule and no "two out of
 * three is close enough": each of the three fails in a different way and the
 * failures are not correlated. (a) alone is satisfied by the operator's own
 * files if they ever put something under the run root. (b) alone is satisfied by
 * a manifest an agent wrote. (c) alone is satisfied by a marker file an agent
 * copied. What makes the conjunction worth anything is that an attacker needs
 * all three and a mistake needs only one — and how much that is worth against
 * an attacker who can already write the run root is the next paragraph, which
 * is less than this one reads as.
 *
 * WHAT THE THREE CAN AND CANNOT DO. A comment in this area has already claimed
 * more than the mechanism gives, so the reach of each is written down here.
 *
 * (a) IS THE ONLY ONE AN ADVERSARY CANNOT WRITE. It is computed from the
 * configured run root and `realpath`, never from anything on disk an agent
 * could author, and it is what bounds the blast radius: brigadier deletes
 * inside `<run root>/r/` or it deletes nothing at all. Every safety claim in
 * this file rests there and nowhere else.
 *
 * (b) AND (c) ARE FILE CONTENTS, and file contents belong to whoever can write
 * them. Against an agent confined to its own clone they hold, which is the case
 * the manifest was built for: the marker sits inside the directory the agent
 * owns and the manifest sits outside it, so a confined agent can get at most
 * its OWN clone deleted, and erasing its marker only makes brigadier refuse.
 * Against anything that can write the run root they hold nothing. MEASURED
 * against `bun 1.3.14` on 2026-08-20, driven against this file by a blind
 * critic: a forger who CREATES the manifest file first, then makes the
 * directory, then rewrites the manifest in place — `writeFileSync` truncates
 * rather than replacing, so the file keeps its birth time — is reported
 * `deletable: true` with NO refusals, every byte of the manifest their own.
 * Nothing below detects that, and nothing below may claim to.
 *
 * THAT LOSS IS SMALLER THAN IT READS AS, and the reason is (a). To forge (b) an
 * adversary must write inside `<run root>/r/`, and everything (a) permits
 * deleting is inside `<run root>/r/` — so anything they can talk brigadier into
 * deleting, they could delete themselves. The forgery buys no reach it did not
 * already have. Closing it would take a secret brigadier holds and the forger
 * cannot read — an HMAC over the entry, keyed OUTSIDE the run root — and that
 * means a key and somewhere to keep it. That is a design decision with an
 * operator-visible cost, and it is deliberately not invented here.
 *
 * SO (b) IS A CHECK AGAINST CONFUSION, NOT AGAINST FORGERY. What it establishes
 * is that the manifest describes THIS directory rather than another directory
 * that happens to sit at the same path: a stale entry, a directory deleted and
 * remade by something else, a manifest belonging to another run root. It used
 * to reach that by comparing timestamps — and that proxy was wrong twice over,
 * because it read `Date.now()` on one side and an inode timestamp on the other,
 * and those are two clocks. See `DirectoryProof.manifestOlderThanDirectory` for
 * the measurement and for both of the errors that produced.
 *
 * REFS GET A FOURTH RULE OF THE SAME SHAPE rather than a generous reading of the
 * first three, because a ref lives inside the OPERATOR'S `.git`, which is
 * outside brigadier's root by construction — `src/repo/refs.ts` opens with that
 * argument. A ref is deletable only if it is under `refs/brigadier/<run-id>/`,
 * its `<run-id>` appears in a manifest written before the ref existed, and the
 * delete is the compare-and-swap form `git update-ref -d <ref> <expected-sha>`.
 * Never the two-argument form: a ref that moved under us means something we do
 * not understand is happening in the operator's repository, and the correct
 * response is to report rather than to win.
 *
 * WHAT IS DELIBERATELY NOT HERE: any decision about WHETHER a directory should
 * go. Ruling 63 splits that from ownership entirely — the sweep reclaims
 * processes always and directories only for runs that are complete — and it
 * lives in `start.ts`. This file answers "may brigadier delete this", never
 * "should it".
 */

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  claimedByManifest,
  intendedRealPath,
  readManifest,
  type RunManifest,
} from "../isolation/index.ts";
import { CLONE_SIGNATURE, parseCloneMarker, runGit } from "../isolation/internal-git.ts";
import { directoryIdentity, sameInode, usableIdentity, usableInode, usableNonce } from "../isolation/manifest.ts";
import { RUN_DIR } from "../repo/layout.ts";
import { REF_NAMESPACE, deleteRefArgv } from "../repo/refs.ts";

/**
 * Each of ruling 15's three conditions, separately, so that a refusal can name
 * the one that failed.
 *
 * A boolean would be the wrong return type here for the reason
 * `assertReclaimed` gives about its own refusals: "false" is not a report anyone
 * can act on, and the operator's remedy differs completely depending on which
 * condition was missing.
 */
export interface DirectoryProof {
  readonly candidate: string;
  readonly realPath: string;
  /** (a) Inside brigadier's own root, judged by `realpath` and never lexically. */
  readonly insideRunRoot: boolean;
  /** (b) The manifest that claims it, by path, or null. */
  readonly manifest: string | null;
  /** (c) The marker file brigadier wrote, by path, or null. */
  readonly markerFile: string | null;
  /**
   * (b): whether the directory standing here is the INODE the manifest entry
   * created — an identity, and not a chronology.
   *
   * WHAT IT CATCHES: confusion. A stale entry whose directory was deleted and
   * remade by something else at the same path; a run recorded by a brigadier
   * that no longer matches what is on disk; an entry written by a process that
   * died between recording and creating. Those are the failures that reach an
   * operator, and none of them involves an adversary.
   *
   * WHAT IT DOES NOT CATCH, stated plainly because the comment it replaced said
   * otherwise: a forgery. The inode is readable by anyone who can `stat` the
   * directory, so a forger writing the manifest copies it. MEASURED against
   * `bun 1.3.14` on 2026-08-20, driven by a blind critic against this file: with
   * the manifest file created BEFORE the directory and rewritten in place after
   * it, this returns `true` and the verdict carries no refusals. The reach of
   * that is bounded by (a) alone — see the header.
   *
   * INODE NUMBERS ARE REUSED. ext4 reallocates a freed inode number to a later
   * file, so a directory removed and recreated at this path can be handed the
   * same number and match. APFS does not — its counter only climbs. The check is
   * therefore weaker on ext4 than the test suite (which runs on APFS) can show.
   *
   * `null` only where no manifest entry names this path at all, which (b) has
   * already refused. An entry that names the path and records no usable inode is
   * `false`: unproven retains.
   */
  readonly directoryIdentity: boolean | null;
  /**
   * Whether the clone's marker carries the random token the manifest entry
   * recorded when it created the directory.
   *
   * RULED 2026-08-20. This is the third condition doing what `directoryIdentity`
   * above cannot do on the ordinary Linux filesystem. MEASURED on `ubuntu:24.04`
   * on 2026-08-20, 300 delete-then-recreate trials at one path per filesystem:
   * ext4 **300/300** and overlayfs **300/300** returned the SAME inode, against
   * 0/300 on tmpfs and 0/300 on APFS. So on `ubuntu-latest` a directory that
   * took a clone's path was indistinguishable from the clone, and the negative
   * control that says so — `test/run-reclaim.test.ts`'s *"same path, different
   * directory"* — failed there and passed here for that reason and no other.
   *
   * WHAT MAKES A TOKEN DIFFERENT FROM AN INODE. Everything else about a clone is
   * derivable from its address: the path, the run id, the item number, the
   * marker's claim, and — on ext4 — the inode the filesystem hands the next
   * directory created there. The token is derivable from nothing, so a directory
   * that merely OCCUPIES the path cannot produce it.
   *
   * WHAT IT STILL DOES NOT REACH, for the same reason nothing else here does: a
   * forger who can write inside `<run root>/r/` can also READ the marker before
   * deleting the directory, and copy the token exactly as they copy the inode.
   * This closes CONFUSION on every filesystem. It closes no forgery, and the
   * header's argument stands unchanged — the reach is bounded by (a).
   *
   * `null` only where no manifest entry names this path, which (b) has already
   * refused. An entry with no token, or a marker with no token, is `false`.
   */
  readonly cloneNonce: boolean | null;
  /**
   * Whether the manifest FILE was born before the directory, where the platform
   * can be shown to keep real birth times.
   *
   * Opportunistic, refuse-only, and never the grantor. Only CREATING a file
   * sets its birth time, so this catches a manifest whose file first appeared
   * after the directory it claims — an ordering mistake, or a lazy forgery.
   *
   * It does NOT catch a careful one, and the difference is one line of the
   * forger's code. MEASURED against `bun 1.3.14` on 2026-08-20 by a blind
   * critic: create the manifest file, then the directory, then rewrite the
   * manifest in place — `writeFileSync` truncates rather than replacing, the
   * birth time survives untouched, and this returns `true`. On a coarse-jiffy
   * kernel it is weaker still: a manifest written once has a birth time and a
   * `ctime` that are bit-identical, `verifiedBirthTime` therefore declines to
   * judge, and this goes `null` — so on Linux even the lazy forgery is not
   * caught here. Where it is `null` it says nothing, and a `null` does not
   * block: a missing measurement is not evidence of a violation.
   *
   * Both readings now come from the SAME clock — the filesystem's — so a coarse
   * kernel clock can only make them equal, never invert them, and no tolerance
   * is involved. The comparison it replaced read `Date.now()` on one side and an
   * inode timestamp on the other. MEASURED against `bun 1.3.14` on 2026-08-20,
   * 300 trials of one script per platform, recorded by this project's first
   * `gates.yml` run and reproduced in a Linux container the same day (not
   * measured here):
   *
   *     linux : entry.createdAt > dirBirth  300 / 300   worst lag 1.38 ms
   *     macos : entry.createdAt > dirBirth    0 / 300   worst lag 0.00 ms
   *
   * So on Linux every legitimate clone was judged "dated AFTER the directory"
   * and brigadier never reclaimed disk it had authorised, while a forged
   * manifest written inside one clock tick of the directory compared EQUAL and
   * was accepted. One comparison, both errors.
   */
  readonly manifestOlderThanDirectory: boolean | null;
}

export interface DeleteVerdict {
  readonly deletable: boolean;
  readonly proof: DirectoryProof;
  /** One line per missing condition, each naming the remedy. Empty iff deletable. */
  readonly refusals: readonly string[];
}

export interface DirectoryOptions {
  /** brigadier's own root, as configured. Resolved by `realpath` here. */
  readonly runRoot: string;
}

/**
 * Establish all three conditions, or say which one is absent.
 *
 * `realpath` on both sides is load-bearing rather than decorative: on macOS
 * `/var` is a symlink to `/private/var`, and a lexical containment test against
 * an unresolved run root silently judges a tree that is not the one the
 * directory is in. That is the escape v1 shipped in its lane containment, and it
 * is the same mistake at a bigger blast radius here, because this one deletes.
 */
export function proveDeletableDirectory(candidate: string, options: DirectoryOptions): DeleteVerdict {
  const realRoot = intendedRealPath(options.runRoot);
  const realPath = intendedRealPath(candidate);
  const refusals: string[] = [];

  // (a) Inside the run root, and specifically inside its `r/` subtree: the run
  //     root itself may hold configuration and a cache, and neither is a clone.
  const runs = join(realRoot, RUN_DIR);
  const insideRunRoot = realPath.startsWith(runs + sep);
  if (!insideRunRoot) {
    refusals.push(
      `ruling 15 (a): ${realPath} is not inside brigadier's own run directory (${runs}) by realpath. ` +
        "Nothing outside it is brigadier's to delete, whatever else claims it.",
    );
  }

  // (b) Recorded in a manifest, and recorded as THIS PATH.
  //
  //     `claimedByManifest` walks UP, which is right for its own job — refusing
  //     a git command anywhere inside a worker clone — and wrong for this one.
  //     Under the walking form, `<clone>/agent-made/` inherits its parent's
  //     entry and is judged deletable, so an agent that creates a subdirectory
  //     and drops a marker into it gets brigadier to delete it. Ruling 15 (b) is
  //     a statement about the path being deleted, not about some ancestor of it,
  //     so the entry has to name this path exactly.
  const manifestPath = claimedByManifest(realPath);
  const manifest: RunManifest | null = manifestPath === null ? null : readManifest(manifestPath);
  const entry =
    manifest === null ? undefined : manifest.clones.find((clone) => clone.dir === realPath);
  if (manifestPath === null || manifest === null) {
    refusals.push(
      `ruling 15 (b): no run manifest records ${realPath} as a clone. A directory brigadier ` +
        "did not write down is a directory brigadier did not create.",
    );
  } else if (entry === undefined) {
    refusals.push(
      `ruling 15 (b): ${manifestPath} records an ANCESTOR of ${realPath} but not ${realPath} ` +
        "itself. An entry for a parent authorises the parent; a subdirectory an agent created " +
        "inside its own clone is recorded nowhere and is not brigadier's to delete.",
    );
  } else if (intendedRealPath(manifest.runRoot) !== realRoot) {
    refusals.push(
      `ruling 15 (b): ${manifestPath} claims ${realPath} but names run root ${manifest.runRoot}, ` +
        `and this sweep is rooted at ${realRoot}. A manifest for another root grants nothing here.`,
    );
  }

  // (b) continued: the entry names the INODE `recordClone` created, and the
  //     directory standing here has to be that inode. This separates this
  //     directory from a different one at the same path; it does not separate
  //     brigadier from a forger, who can read the inode as easily as this can.
  //     The proof field's own comment carries the full reach.
  //
  //     THE INODE ONLY, NEVER THE DEVICE. `st_dev` is recorded for the report
  //     and deliberately not compared: btrfs, ZFS, overlayfs and tmpfs are
  //     handed an ANONYMOUS BDEV allocated at mount time, so the same
  //     filesystem carries a different `dev` after a remount or a reboot.
  //     `sweepAtStart` reads runs recorded by an EARLIER process — that is what
  //     it is for — so a later boot is the ordinary path through here, not an
  //     edge case, and comparing `dev` refused legitimate clones outright.
  let identityProof: boolean | null = null;
  let nonceProof: boolean | null = null;
  if (manifest !== null && entry !== undefined) {
    const recorded = entry.identity;
    const actual = directoryIdentity(realPath);
    if (!usableIdentity(recorded)) {
      identityProof = false;
      refusals.push(
        `ruling 15 (b): ${manifestPath} records ${realPath} but no usable inode for it, so this ` +
          "directory cannot be told apart from anything else that might stand at that path. An " +
          "entry from an older brigadier, one left by a process that died between recording and " +
          "creating, and a volume that reports inode 0 for every file on it all look like this — " +
          "and all of them retain rather than delete.",
      );
    } else if (actual === null) {
      identityProof = false;
      refusals.push(
        `ruling 15 (b): ${realPath} is not a directory whose inode can be read — it is missing, ` +
          "unreadable, or something other than a directory. The identity the manifest records " +
          "cannot be matched against it, so nothing here is proved.",
      );
    } else if (!usableInode(actual.ino)) {
      identityProof = false;
      refusals.push(
        `ruling 15 (b): the filesystem under ${realPath} reports inode ${actual.ino} for it, ` +
          "which is not an inode number that identifies anything — a volume that keeps none " +
          "reports 0 for every file on it. Matching against it would match every directory " +
          "equally, so the manifest's record cannot be confirmed and the directory is retained.",
      );
    } else if (!sameInode(recorded, actual)) {
      identityProof = false;
      refusals.push(
        `ruling 15 (b): ${manifestPath} records ${realPath} as inode ${recorded.ino} (on device ` +
          `${recorded.dev}) and the directory standing there now is inode ${actual.ino} (on ` +
          `device ${actual.dev}). A manifest entry authorises the directory brigadier created, ` +
          "never whatever later occupied its path.",
      );
    } else {
      identityProof = true;
    }
  }

  // (c) The marker file brigadier wrote — the in-clone signature `prepareClone`
  //     writes at `.git/brigadier-clone`. It is the WEAKEST of the three, and
  //     deliberately so: an agent owns that directory and can delete the file,
  //     in which case this refuses and reports. Refusing to delete a clone
  //     because its marker is gone is the safe direction of that failure.
  const markerCandidate = join(realPath, ".git", CLONE_SIGNATURE);
  const markerFile = regularFile(markerCandidate) ? markerCandidate : null;
  if (markerFile === null) {
    refusals.push(
      `ruling 15 (c): no marker file at ${markerCandidate}, or it is not a plain regular file. ` +
        "brigadier writes one into every clone it creates; without it this directory cannot be " +
        "shown to be one, and it is retained rather than deleted.",
    );
  } else if (manifest !== null && entry !== undefined) {
    // The marker lives inside a directory the agent owns, so its PRESENCE is
    // the weakest of the three signals — the isolation slice moved the durable
    // record out of `.git` for exactly this reason. Its CONTENT is checked
    // against the manifest entry so that a marker copied from a sibling clone
    // does not stand in for this one.
    const expected = `${manifest.runId}/${entry.item}`;
    let raw = "";
    try {
      raw = readFileSync(markerFile, "utf8");
    } catch {
      raw = "";
    }
    const marker = parseCloneMarker(raw);
    if (marker.claim !== expected) {
      refusals.push(
        `ruling 15 (c): the marker at ${markerFile} says ${JSON.stringify(marker.claim)} and the ` +
          `manifest records ${JSON.stringify(expected)}. A marker that does not name this clone ` +
          "is not this clone's marker.",
      );
    }

    // THE TOKEN. See `DirectoryProof.cloneNonce` for what it reaches and why the
    // inode alone does not reach it on ext4.
    //
    // THE COMPATIBILITY FORK, RULED 2026-08-20 RATHER THAN LEFT OPEN. A run
    // recorded by a brigadier from before this date has no token in its entry
    // and none in its marker. The two available answers were to ACCEPT such an
    // entry — reclaiming on the inode alone, as before — or to REFUSE it and
    // report. **This refuses.**
    //
    // The reason is that accepting would reopen the hole for exactly the runs
    // most likely to be stale: an old manifest is by definition one whose
    // directory has had the longest time to be deleted and replaced, and it is
    // on ext4 that the inode cannot tell. An exemption for old entries is
    // therefore an exemption that applies precisely where the check is needed.
    //
    // THE ACCEPTED COST, stated rather than discovered: **directories recorded
    // by an older brigadier are stranded.** They are never reclaimed, they
    // accumulate under the run root, and the operator has to remove them by
    // hand. That is disk, and the refusal below names the path and says so.
    // The alternative cost is deleting a directory brigadier did not create,
    // which is somebody's only copy of something. Ruling 63 already chose
    // between these two in the same direction and said why — *a leaked process
    // can still act, a retained directory is inert and holds someone's only
    // copy* — and this is that ruling applied one level down.
    if (!usableNonce(entry.nonce)) {
      nonceProof = false;
      refusals.push(
        `ruling 15 (b): ${manifestPath} records ${realPath} with no usable clone token, so this ` +
          "directory cannot be told apart from another one that later took its path. On ext4 and " +
          "overlayfs the inode CANNOT tell them apart either — MEASURED 300/300 on 2026-08-20 — " +
          "so nothing here is proved and the directory is retained. An entry written by a " +
          "brigadier from before 2026-08-20 looks exactly like this, and is refused deliberately " +
          `rather than exempted. REMEDY: check ${realPath} yourself and remove it by hand.`,
      );
    } else if (marker.nonce === undefined) {
      nonceProof = false;
      refusals.push(
        `ruling 15 (c): ${manifestPath} records a clone token for ${realPath} and the marker at ` +
          `${markerFile} carries none. brigadier writes the token into the marker when it creates ` +
          "the clone, so a marker without one is not the marker brigadier wrote — it is a marker " +
          "reconstructed from the path, which is all a later occupant of that path can do.",
      );
    } else if (marker.nonce !== entry.nonce) {
      nonceProof = false;
      refusals.push(
        `ruling 15 (c): the marker at ${markerFile} carries clone token ${JSON.stringify(marker.nonce)} ` +
          `and ${manifestPath} records ${JSON.stringify(entry.nonce)} for ${realPath}. A manifest ` +
          "entry authorises the directory brigadier created, never whatever later occupied its path.",
      );
    } else {
      nonceProof = true;
    }
  }

  const ordering = manifestOlderThanDirectory(manifestPath, realPath);
  if (ordering === false) {
    refusals.push(
      `ruling 15 (b): the manifest file for ${realPath} is dated AFTER the directory it claims, ` +
        "by its own birth time — which only the CREATION of that file sets, so rewriting it in " +
        "place does not move it. The manifest has to exist before the directory does, or it " +
        "records a directory it did not authorise.",
    );
  }

  return {
    deletable: refusals.length === 0,
    proof: {
      candidate,
      realPath,
      insideRunRoot,
      manifest: manifestPath,
      markerFile,
      directoryIdentity: identityProof,
      cloneNonce: nonceProof,
      manifestOlderThanDirectory: ordering,
    },
    refusals,
  };
}

/**
 * Was the manifest FILE born before the directory it claims?
 *
 * `entry.createdAt` is deliberately not consulted. It is a number in the file,
 * so a forger picks it, and it is read from `Date.now()`, so comparing it
 * against an inode timestamp compares two clocks — the measurement in
 * `DirectoryProof` above is what that cost. Both readings here come from one
 * clock, the filesystem's, where a coarse tick can only collapse the two into
 * equality and equality passes. No tolerance, and none is needed.
 *
 * `null` means the platform could not be SHOWN to keep a real birth time, and
 * `null` does not block. That check is `verifiedBirthTime`, and it is not
 * caution for its own sake: where a kernel has no birth time to give, the field
 * is filled from `ctime` instead, and a `ctime` MOVES — the manifest is
 * rewritten once per item and a clone's directory changes on every file git
 * puts into it. Trusting a `ctime` as a birth time would refuse legitimate
 * clones on exactly the platform this comparison was already refusing them on.
 */
function manifestOlderThanDirectory(manifestPath: string | null, realPath: string): boolean | null {
  if (manifestPath === null) return null;
  const manifestBirth = verifiedBirthTime(manifestPath);
  const dirBirth = verifiedBirthTime(realPath);
  if (manifestBirth === null || dirBirth === null) return null;
  return manifestBirth <= dirBirth;
}

/**
 * A birth time this platform can be shown to actually keep, or `null`.
 *
 * The probe is `birthtimeMs < ctimeMs`. Where the field is a real birth time it
 * falls strictly behind `ctime` as soon as anything touches the inode, and both
 * of the paths this is asked about have been touched since they were made — the
 * manifest is written twice by `recordClone` alone, and a clone directory gains
 * `.git` immediately. Where the field is a stand-in for `ctime` the two
 * readings are bit-identical by construction and the probe refuses to draw a
 * conclusion. It can only prove the field real, never prove it fake, and a
 * platform it cannot judge is simply one this comparison stays quiet about.
 */
function verifiedBirthTime(path: string): number | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  const birth = stat.birthtimeMs;
  // A birth time of 0 is the filesystem saying it does not keep one.
  if (!Number.isFinite(birth) || birth <= 0) return null;
  return birth < stat.ctimeMs ? birth : null;
}

/** A plain regular file, never a symlink, a directory or a device. */
function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export interface DirectoryReclamation {
  readonly deleted: boolean;
  readonly verdict: DeleteVerdict;
  /** Bytes the directory held, measured BEFORE the delete. Zero when nothing was deleted. */
  readonly bytes: number;
}

/**
 * Delete a directory, having proved all three conditions.
 *
 * Measures first, deletes second: the report has to say what the reclamation
 * recovered, and after `rmSync` there is nothing left to measure.
 */
export function reclaimDirectory(candidate: string, options: DirectoryOptions): DirectoryReclamation {
  const verdict = proveDeletableDirectory(candidate, options);
  if (!verdict.deletable) return { deleted: false, verdict, bytes: 0 };
  const bytes = directoryBytes(verdict.proof.realPath);
  rmSync(verdict.proof.realPath, { recursive: true, force: true });
  return { deleted: true, verdict, bytes };
}

/**
 * Bytes on disk under a directory, without following symlinks.
 *
 * `lstat`, never `stat`, and the reason is the reason everything else in this
 * area uses it: a symlink to `/` would otherwise make this walk the machine.
 * Ruling 63 requires every start to report what is retained and what it costs —
 * #19 measured roughly 67 MB incremental per clone — so this number is part of
 * the promise rather than a diagnostic.
 */
export function directoryBytes(dir: string): number {
  let total = 0;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return total;
  }
  for (const entry of entries) total += directoryBytes(join(dir, entry));
  return total;
}

export interface OwnedRef {
  readonly ref: string;
  readonly sha: string;
  /**
   * True when the ref is SYMBOLIC — it names another ref rather than an object.
   *
   * This field exists because of a measured way to destroy the deliverable.
   * `for-each-ref` reports a symbolic ref's TARGET's object name, so a symbolic
   * `refs/brigadier/<run>/base` pointing at `refs/heads/brigadier/<run>` yields
   * a sha that matches, the compare-and-swap therefore succeeds, and
   * `git update-ref -d` DEREFERENCES by default — deleting the integration
   * branch. That is the one ref ruling 51 says brigadier never deletes, and the
   * invisible namespace exists precisely so the delete rule can never reach it.
   * A symbolic ref under our namespace is refused outright, and `--no-deref` is
   * on every delete besides.
   */
  readonly symbolic: boolean;
}

export type GitRunner = (repo: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The default runner is `src/isolation/internal-git.ts`'s, deliberately.
 *
 * It builds the child environment from an allowlist and — with no authority
 * argument — REFUSES if the target is a worker clone. Ref reclamation runs in
 * the operator's repository, so that refusal should never fire; wiring it up
 * anyway means a future caller that passes a clone path gets ruling 56's
 * refusal rather than a git command inside a directory an agent has been in.
 */
const defaultGit: GitRunner = async (repo, args) => runGit({ cwd: repo, args: [...args] });

/** Every ref brigadier owns in this repository, with the sha the delete will be pinned to. */
export async function listOwnedRefs(repo: string, git: GitRunner = defaultGit): Promise<OwnedRef[]> {
  // `%(symref)` is empty for an ordinary ref and holds the target for a symbolic
  // one. Asking for it is the only way to tell them apart here: `%(objectname)`
  // reports the target's sha for both.
  const result = await git(repo, [
    "for-each-ref",
    "--format=%(objectname)\t%(symref)\t%(refname)",
    `${REF_NAMESPACE}/`,
  ]);
  if (result.code !== 0) return [];
  const refs: OwnedRef[] = [];
  for (const line of result.stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const sha = (parts[0] ?? "").trim();
    const symref = (parts[1] ?? "").trim();
    const ref = parts.slice(2).join("\t").trim();
    if (ref.length === 0) continue;
    if (symref.length > 0) {
      refs.push({ ref, sha, symbolic: true });
      continue;
    }
    if (/^[0-9a-f]{7,64}$/.test(sha)) refs.push({ ref, sha, symbolic: false });
  }
  return refs;
}

export interface RefReclamation {
  readonly ref: string;
  readonly deleted: boolean;
  readonly refusal: string | null;
}

/**
 * Delete one of brigadier's refs, compare-and-swap.
 *
 * Two refusals, and they are different failures. `deleteRefArgv` throws when the
 * ref is not ours or the sha is not a sha — a programming error, caught before
 * git is invoked at all. A non-zero exit from git means the ref MOVED between
 * the read and the delete, and that is the case the three-argument form exists
 * for: brigadier reports it and leaves the ref alone.
 */
export async function reclaimRef(
  repo: string,
  owned: OwnedRef,
  knownRunIds: readonly string[],
  git: GitRunner = defaultGit,
): Promise<RefReclamation> {
  if (owned.symbolic) {
    return {
      ref: owned.ref,
      deleted: false,
      refusal:
        `ruling 50 and ruling 51: refusing to delete ${owned.ref}, which is a SYMBOLIC ref. ` +
        "`for-each-ref` reports its target's object name, so the compare-and-swap would match " +
        "on a sha that is not this ref's, and the delete would follow the link. The one ref " +
        "brigadier never deletes is reachable that way, so a symbolic ref in our namespace is " +
        "reported rather than resolved.",
    };
  }
  let argv: string[];
  try {
    argv = deleteRefArgv(owned.ref, owned.sha, knownRunIds);
  } catch (error) {
    return { ref: owned.ref, deleted: false, refusal: (error as Error).message };
  }
  // `--no-deref` on every delete, belt and braces beside the refusal above:
  // `git update-ref -d` dereferences by default, and the thing on the far end
  // of a link in this namespace can be `refs/heads/brigadier/<run-id>`.
  argv = [argv[0] as string, "--no-deref", ...argv.slice(1)];
  const result = await git(repo, argv);
  if (result.code === 0) return { ref: owned.ref, deleted: true, refusal: null };
  return {
    ref: owned.ref,
    deleted: false,
    refusal:
      `ruling 50: \`git ${argv.join(" ")}\` exited ${result.code} — ` +
      `${(result.stderr || result.stdout).trim()}. The ref moved between the read and the delete, ` +
      "so brigadier refused it rather than clobbering whatever it points at now.",
  };
}
