// SPDX-License-Identifier: Apache-2.0
/**
 * One clone per unit of work: where it goes, how it is built, and the door
 * after which brigadier stops running git in it.
 *
 *     prepareClone(spec)      -> PreparedClone      brigadier owns it
 *     releaseToAgent(clone)   -> AgentOwnedClone    the door
 *     recycleClone(clone, …)  -> PreparedClone      the only way back
 *     discardClone(clone)     -> void               no git involved
 *
 * ---------------------------------------------------------------------------
 * A MEASUREMENT THAT CONTRADICTS RULING 56, stated first because it changes
 * what the rest of this file is for.
 *
 * Ruling 56 says the pooled recycle is "the one exception, and it is the whole
 * exception", and that the restore closes it because deleting `.git/hooks` and
 * copying back `.git/config` are "both plain filesystem operations, before git
 * is invoked at all, so no git command's behaviour can be influenced by planted
 * content".
 *
 * MEASURED against `git 2.50.1` on 2026-08-17 (`test/isolation-live.test.ts`,
 * macOS 25.5.0), that reasoning holds only against an agent that has STOPPED:
 *
 *   - a single `writeFileSync` of `.git/config` with a `core.fsmonitor`,
 *     performed AFTER `recycleClone` returned, made the next authorised git
 *     command execute the payload. No race, no loop, one write. git re-reads
 *     `.git/config` from disk on every invocation, so a restore performed once
 *     per recycle sanitises exactly the first spawn after it;
 *   - the same write performed by a shell loop the agent left running escaped
 *     DURING the recycle itself, between two of brigadier's own commands;
 *   - a loop writing `post-checkout` into the hooks sink escaped the same way.
 *
 * What ruling 56 assumed is that sanitisation and use are adjacent. They are
 * not: sanitisation is instantaneous and authority is durable, and in between
 * the agent's processes may still be alive. `probes/git-exec.sh`'s 26 checks
 * could not have found this, because every payload it planted was static and
 * planted before the restore — which is the case the ruling's reasoning covers
 * and the only case it covers.
 *
 * TWO THINGS FOLLOW, and both are in this file:
 *
 *   1. Sanitisation moved to immediately before EVERY spawn (`internal-git.ts`),
 *      not once per recycle. That closes the single-shot form completely and
 *      narrows the loop form to a genuine race between two adjacent statements.
 *   2. A live agent has to be impossible rather than unlikely before a
 *      directory is recycled. Ruling 38 makes the reclamation sweep the
 *      containment mechanism for processes and ruling 63 splits it so that the
 *      sweep reclaims processes ALWAYS — so the honest precondition for ruling
 *      49's recycle is "the sweep has confirmed this item's processes are
 *      dead". That is a cross-module invariant with a slice that does not exist
 *      yet, so it is expressed as a REQUIRED ARGUMENT (`ReclamationEvidence`)
 *      whose claims are verified here, rather than as a comment.
 *
 * The narrowed residual is stated where it lives, on `recycleClone`.
 * ---------------------------------------------------------------------------
 *
 * WHAT THE TYPE SYSTEM ACTUALLY DOES, stated exactly. The brands are
 * module-private symbols, so neither handle can be conjured from a bare object
 * literal. They are ordinary structural types otherwise: spreading an existing
 * handle produces another that typechecks, and `releaseToAgent` returns a NEW
 * object rather than invalidating the caller's `PreparedClone`. The types make
 * the intended path obvious and the wrong path awkward. They do not enforce it.
 *
 * THE ENFORCEMENT IS THE CAPABILITY TOKEN plus the per-spawn sanitisation, and
 * both are runtime. `releaseToAgent` deletes the token, so a stale
 * `PreparedClone` used after release fails closed at its first git call.
 *
 * Ruling 61 puts the directory at `~/.brigadier/r/<run-id>/<n>` (the
 * `%LOCALAPPDATA%` equivalent on Windows) and never in `/tmp` or `$TMPDIR`,
 * judged by `realpath` and never lexically. Both refusals, and the existence
 * checks, happen BEFORE anything is created.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pooledRestore } from "../repo/git.ts";
import { RUN_DIR, defaultRunRoot, fitsBudget, isTempRooted, itemDir, type FitVerdict } from "../repo/layout.ts";
import { BASE_BRANCH, WORK_BRANCH } from "../repo/refs.ts";
import type { BaseState } from "./base.ts";
import {
  CLONE_SIGNATURE,
  adoptConfig,
  git,
  markReleased,
  unmarkReleased,
  type CloneAuthority,
  type Hermetic,
} from "./internal-git.ts";
import { manifestPath, recordClone } from "./manifest.ts";
import { resetDirectory, writeRegularFile } from "./safe-fs.ts";

const BRAND: unique symbol = Symbol("brigadier.isolation.clone");

interface CloneFacts {
  /** The clone itself, by `realpath`. The agent's working directory and its lane root. */
  readonly dir: string;
  /** The operator's repository. Retained because ruling 51 removes `origin`. */
  readonly parentRepo: string;
  readonly runId: string;
  readonly item: number;
  readonly baseSha: string;
  /** Per-item brigadier state, outside the clone: token, hooks sink, empty global config. */
  readonly stateDir: string;
  readonly hermetic: Hermetic;
  readonly tokenPath: string;
  /**
   * The clone's `.git/config` as it was at creation, held IN MEMORY.
   *
   * Ruling 56 says the restore copies `.git/config` back "from a known-good
   * copy written at creation". A copy on disk beside the clone is a file an
   * agent can overwrite, and then the restore installs the agent's payload and
   * runs git over it — so the authority is the string below, and the file is
   * rewritten from it immediately before the copy. Held in memory means the
   * pool is in-process; a cross-process pool would need this keyed in a store
   * brigadier owns, and that is a ticket rather than a silent assumption.
   */
  readonly knownGoodConfig: string;
  readonly knownGoodConfigPath: string;
}

/** A clone brigadier owns. The authority is what lets git run in it. */
export interface PreparedClone extends CloneFacts {
  readonly [BRAND]: "prepared";
  readonly authority: CloneAuthority;
}

/** A clone an agent has had access to. It carries no authority, and there is no way to add one. */
export interface AgentOwnedClone extends CloneFacts {
  readonly [BRAND]: "agent-owned";
  /** When the door was opened. The sweep's evidence has to be newer than this. */
  readonly releasedAt: number;
}

/**
 * What the reclamation sweep has to have established before a directory an
 * agent held can be re-entered.
 *
 * THE SEAM, named rather than assumed: this is produced by ruling 38's
 * reclamation sweep — the module ruling 63 splits so that process reclamation
 * happens ALWAYS — which is a different slice and does not exist yet. Nothing
 * in `src/isolation/` can construct an honest one, and that is the point:
 * `recycleClone` cannot be called without it, so the precondition cannot be
 * forgotten, only supplied.
 *
 * What `recycleClone` verifies for itself, rather than taking on trust:
 *
 *   - the evidence names THIS run and THIS item;
 *   - it was taken at or after the moment the clone was released;
 *   - `survivors` is empty;
 *   - every pid in `reclaimedPids` really is gone, checked with signal 0.
 *
 * What it CANNOT verify, said plainly: that the sweep found every process. A
 * caller that reports an empty list gets past this check. The verifiable part
 * is verified; the rest is why the sweep is a ruling rather than a convention.
 */
export interface ReclamationEvidence {
  readonly runId: string;
  readonly item: number;
  /** Milliseconds since the epoch, at the moment the sweep finished. */
  readonly sweptAt: number;
  /** Every process the sweep reclaimed for this item. Each is checked dead here. */
  readonly reclaimedPids: readonly number[];
  /** Anything the sweep could not reclaim. Non-empty means no recycle. */
  readonly survivors: readonly number[];
  /** Which sweep produced this, so a refusal can name it. */
  readonly sweptBy: string;
}

export class NotReclaimed extends Error {
  constructor(message: string) {
    super(
      `rulings 38 and 63: refusing to recycle a directory whose processes are not proven ` +
        `gone — ${message}`,
    );
    this.name = "NotReclaimed";
  }
}

export interface CloneSpec {
  /** The published base state. Its ref is fetched explicitly; a default clone does not carry it. */
  base: BaseState;
  /** 1-based, and it is the directory name. Ruling 61 keeps it a bare number. */
  item: number;
  /** Defaults to `~/.brigadier` / `%LOCALAPPDATA%\brigadier`. */
  runRoot?: string;
  /** Real paths of the temp regions to refuse. Defaults to this machine's. */
  tempDirs?: readonly string[];
}

/**
 * Build a clone for one unit of work.
 *
 * The order is fixed and every step has a reason:
 *
 *   1. refuse a temp-rooted run root, refuse a run whose deepest path will not
 *      fit, and refuse a target that already exists — all BEFORE anything is
 *      created, including the run root itself;
 *   2. write the run manifest, which is ruling 15's record and has to exist
 *      before the directory it records;
 *   3. `git clone --local --no-checkout`, because the base ref is not in a
 *      default clone's refspec and checking out HEAD first is work thrown away;
 *   4. set `core.autocrlf` explicitly, BEFORE any checkout — it is the checkout
 *      that applies it — and adopt the result as the known-good config;
 *   5. fetch the base ref explicitly from the parent path;
 *   6. check out `work` from it, so the agent starts on the branch ruling 51's
 *      ownership diff reads;
 *   7. `git remote remove origin` — ruling 51, a speed bump rather than a
 *      boundary — and adopt again, so the known-good config does not carry
 *      `origin` back on a later recycle.
 */
export async function prepareClone(spec: CloneSpec): Promise<PreparedClone> {
  const { base, item } = spec;
  if (!Number.isInteger(item) || item < 1) throw new Error(`unusable item number: ${item}`);

  const configuredRoot = spec.runRoot ?? defaultRunRoot();
  // Judged BEFORE the directory is created: a refusal that first creates the
  // directory it is refusing has already done the thing it exists to prevent.
  const intendedRoot = intendedRealPath(configuredRoot);

  const tempDirs = spec.tempDirs ?? realTempDirs();
  if (isTempRooted(intendedRoot, tempDirs)) {
    throw new Error(
      `ruling 61: refusing a run root inside a temp region — ${intendedRoot}. #41 measured a ` +
        "worker in a temp root writing into another clone's tracked file: the Codex ACP " +
        "bridge builds its sandbox with the temp roots writable BY DESIGN, so the " +
        "conventional home for scratch directories is exactly the region that makes " +
        "concurrent workers non-isolated.",
    );
  }

  const verdict = fitsBudget(intendedRoot, base.runId, item, base.longestPath);
  const refusal = pathBudgetRefusal(verdict, intendedRoot);
  if (refusal !== null) throw new Error(refusal);

  const dir = itemDir(intendedRoot, base.runId, item);
  const stateDir = join(intendedRoot, RUN_DIR, base.runId, "state", String(item));
  // Existence, not emptiness. An agent that empties its own workspace made the
  // old check say "free"; the clone then landed on a path that was still
  // somebody's, and the failure arrived two git commands later.
  for (const occupied of [dir, stateDir]) {
    if (existsSync(occupied)) {
      throw new Error(
        `refusing to build a clone over ${occupied}, which already exists. A pooled ` +
          "directory is reused through recycleClone(); a finished one is removed by " +
          "discardClone().",
      );
    }
  }

  // Ruling 15's manifest, and it is written BEFORE the clone directory exists.
  // It is the record that survives what an agent does inside its own clone —
  // unlike an in-clone signature, which `git gc` alone erases half of.
  const manifest = manifestPath(intendedRoot, RUN_DIR, base.runId);
  mkdirSync(dirname(manifest), { recursive: true });
  recordClone(
    manifest,
    { runId: base.runId, runRoot: intendedRoot, createdAt: Date.now(), clones: [] },
    { item, dir, createdAt: Date.now() },
  );

  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const runRoot = realpathSync(intendedRoot);
  const realDir = realpathSync(dir);
  const hermetic: Hermetic = {
    hooksSink: join(stateDir, "nohooks"),
    emptyGlobalConfig: join(stateDir, "empty-gitconfig"),
    // `known` stays null until brigadier's own config calls are done: there is
    // nothing to restore while the clone is still being built, and no agent has
    // been anywhere near it.
    config: { path: join(realDir, ".git", "config"), known: null },
  };
  resetDirectory(hermetic.hooksSink);
  writeRegularFile(hermetic.emptyGlobalConfig, "");

  await git({
    cwd: runRoot,
    hermetic,
    args: ["clone", "--local", "--no-checkout", base.repo, realDir],
  });
  writeRegularFile(join(realDir, ".git", CLONE_SIGNATURE), `${base.runId}/${item}\n`);

  const facts = {
    dir: realDir,
    parentRepo: base.repo,
    runId: base.runId,
    item,
    baseSha: base.sha,
    stateDir,
    hermetic,
    tokenPath: join(stateDir, "token"),
    knownGoodConfigPath: join(stateDir, "known-good-config"),
  };
  const authority = issueAuthority(facts.dir, facts.tokenPath);

  await checkOutBase(facts, authority, base, { recycled: false });
  const knownGoodConfig = hermetic.config.known ?? readFileSync(hermetic.config.path, "utf8");
  return { ...facts, knownGoodConfig, authority, [BRAND]: "prepared" };
}

/**
 * The door.
 *
 * Deleting the token is what makes it one. A `PreparedClone` the caller kept
 * hold of still typechecks after this call and its first git command still
 * fails, because the file its nonce refers to is gone.
 */
export function releaseToAgent(clone: PreparedClone): AgentOwnedClone {
  rmSync(clone.tokenPath, { force: true });
  markReleased(clone.dir);
  const { [BRAND]: _stage, authority: _authority, ...facts } = clone;
  return { ...facts, releasedAt: Date.now(), [BRAND]: "agent-owned" };
}

export interface RecycleSpec {
  /** The base state of the NEXT unit of work. */
  base: BaseState;
  /**
   * Proof from ruling 38's sweep that this item's processes are gone.
   *
   * Required, and required for a reason the module header measures: the ruling
   * 49 restore is sound against an agent that has stopped and vacuous against
   * one that has not.
   */
  reclaimed: ReclamationEvidence;
}

/**
 * Ruling 49's pooled recycle, and the only re-entry into a directory an agent
 * has had access to.
 *
 * Ruling 19 records recycling at roughly 1–3 s against 6.06 s to clone, and
 * measured `checkout --force` LEAVING untracked and gitignored residue — which
 * is how one item's junk becomes the next item's context. `clean -fdx` is
 * mandatory, not tidy. Local timings are in `test/isolation-cost.test.ts`,
 * which measures them rather than quoting them.
 *
 * The restore is plain filesystem work performed before git is invoked — and
 * then performed AGAIN before every subsequent spawn, which is the part ruling
 * 56 does not have and the module header measures the need for:
 *
 *   - `.git/hooks` deleted and recreated empty — an agent may have planted any
 *     hook name, and an unwritable directory was MEASURED ineffective against
 *     `git 2.50.1` on 2026-08-17 (`probes/git-exec.sh`) because the agent
 *     deletes it and recreates it;
 *   - `.git/config` rewritten from the in-memory copy taken at creation, which
 *     closes `core.fsmonitor` — MEASURED on the same date not to be covered by
 *     `core.hooksPath` — and every `filter.*` driver, since a `.gitattributes`
 *     naming a filter was MEASURED inert until the driver exists in config.
 *
 * THE RESIDUAL, narrowed and stated: between brigadier's rewrite of
 * `.git/config` and git's read of it there is a window of a few microseconds. A
 * process still alive inside the clone and writing in a tight loop can win it.
 * That is why `reclaimed` is not optional. With the sweep's evidence the window
 * has no writer in it; without evidence there is no recycle at all.
 */
export async function recycleClone(
  clone: AgentOwnedClone,
  spec: RecycleSpec,
): Promise<PreparedClone> {
  assertReclaimed(clone, spec.reclaimed);

  const restore = pooledRestore(clone.dir, clone.knownGoodConfigPath);

  resetDirectory(restore.hooksDir);
  // From memory, and written with the symlink-refusing writer. `copyFileSync`
  // used to do this and FOLLOWS SYMLINKS at the destination: a `.git/config`
  // symlinked outside the clone turned the restore into an arbitrary overwrite
  // of the target, and left the clone reading its config from a path the agent
  // chose. Refuse, never repair.
  writeRegularFile(restore.knownGoodConfigPath, clone.knownGoodConfig);
  writeRegularFile(restore.configPath, clone.knownGoodConfig);
  writeRegularFile(join(clone.dir, ".git", CLONE_SIGNATURE), `${clone.runId}/${clone.item}\n`);

  // Only now is the directory brigadier's again.
  unmarkReleased(clone.dir);
  // And from here every spawn rewrites the config from this string, so the
  // restore above is the first of many rather than the only one.
  clone.hermetic.config.known = clone.knownGoodConfig;
  const authority = issueAuthority(clone.dir, clone.tokenPath);

  const { [BRAND]: _stage, releasedAt: _releasedAt, ...carried } = clone;
  const facts = { ...carried, baseSha: spec.base.sha };
  await checkOutBase(facts, authority, spec.base, { recycled: true });
  return { ...facts, authority, [BRAND]: "prepared" };
}

/**
 * Verify what can be verified about the sweep's claim.
 *
 * Deliberately not a boolean: every branch names what was wrong, because a
 * refusal here means a worker may still be alive and "false" is not a report
 * anyone can act on.
 */
export function assertReclaimed(
  clone: { runId: string; item: number; releasedAt: number; dir: string },
  evidence: ReclamationEvidence,
): void {
  if (evidence.runId !== clone.runId || evidence.item !== clone.item) {
    throw new NotReclaimed(
      `the evidence names ${evidence.runId}/${evidence.item} and this is ` +
        `${clone.runId}/${clone.item} (${clone.dir}), reported by ${evidence.sweptBy}`,
    );
  }
  if (evidence.survivors.length > 0) {
    throw new NotReclaimed(
      `${evidence.sweptBy} reports ${evidence.survivors.length} process(es) it could not ` +
        `reclaim: ${evidence.survivors.join(", ")}`,
    );
  }
  if (!Number.isFinite(evidence.sweptAt) || evidence.sweptAt < clone.releasedAt) {
    throw new NotReclaimed(
      `the sweep ran at ${evidence.sweptAt} and the clone was released at ${clone.releasedAt}. ` +
        "Evidence older than the release says nothing about the processes the release started.",
    );
  }
  for (const pid of evidence.reclaimedPids) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new NotReclaimed(`${evidence.sweptBy} reported an unusable pid: ${pid}`);
    }
    if (isAlive(pid)) {
      throw new NotReclaimed(
        `${evidence.sweptBy} reports pid ${pid} reclaimed, and it is still alive`,
      );
    }
  }
}

/** Signal 0 asks the kernel rather than the caller. `EPERM` means alive and not ours. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Delete a clone and its state. Plain filesystem work: no git, so ruling 56 has nothing to say. */
export function discardClone(clone: AgentOwnedClone | PreparedClone): void {
  unmarkReleased(clone.dir);
  rmSync(clone.dir, { recursive: true, force: true });
  rmSync(clone.stateDir, { recursive: true, force: true });
}

/** A fresh nonce, written where only brigadier can have put it. */
function issueAuthority(dir: string, tokenPath: string): CloneAuthority {
  const nonce = randomBytes(32).toString("hex");
  writeRegularFile(tokenPath, nonce);
  return { dir, tokenPath, nonce };
}

/**
 * The steps shared by a fresh clone and a recycled one.
 *
 * Recycling force-moves `work` and cleans, because the directory still holds
 * the previous item's checkout. A fresh clone has neither branch yet.
 */
async function checkOutBase(
  facts: { dir: string; parentRepo: string; hermetic: Hermetic },
  authority: CloneAuthority,
  base: BaseState,
  options: { recycled: boolean },
): Promise<void> {
  const inClone = { cwd: facts.dir, authority, hermetic: facts.hermetic };

  // #5 measured a `core.autocrlf` mismatch turning a one-line edit into a
  // six-line whole-file diff. Written explicitly, always, and before any
  // checkout, because it is the checkout that applies it. Doubly necessary
  // here: these invocations run with `GIT_CONFIG_NOSYSTEM` and an empty global
  // config, so whatever those two levels hold on the operator's machine is not
  // inherited. The value written is whatever `buildBaseState` read as
  // effective, which is the value the base commit was actually built under.
  await git({ ...inClone, args: ["config", "core.autocrlf", base.autocrlf] });
  // Adopt it: from here the per-spawn rewrite restores THIS, so brigadier's own
  // deliberate change is not undone by its own sanitisation.
  adoptConfig(facts.hermetic);

  // The explicit fetch. MEASURED against `git 2.50.1` on 2026-08-17
  // (`probes/base-state.sh`): a default `git clone` does not carry a ref
  // outside `refs/heads/`, which is the same property that keeps the namespace
  // out of the operator's `git branch`. The parent is named by path because
  // ruling 51 removes `origin`; the same probe measured
  // `uploadpack.packObjectsHook` set inside a clone NOT firing for a local-path
  // fetch, and `src/repo/git.ts` records that this holds because of the
  // transport rather than in general.
  await git({
    ...inClone,
    args: ["fetch", "--no-tags", facts.parentRepo, `+${base.ref}:refs/heads/${BASE_BRANCH}`],
  });

  await git({
    ...inClone,
    args: options.recycled
      ? ["checkout", "--force", "-B", WORK_BRANCH, BASE_BRANCH]
      : ["checkout", "-b", WORK_BRANCH, BASE_BRANCH],
  });

  if (options.recycled) {
    // Ruling 19 measured `checkout --force` leaving untracked and gitignored
    // residue behind. This is the line that stops one item's junk becoming the
    // next item's context.
    await git({ ...inClone, args: ["clean", "-fdx"] });
  } else {
    // Ruling 51, and labelled the way the ruling labels it: a SPEED BUMP, not a
    // boundary. MEASURED against `git 2.50.1` on 2026-08-17 and reproduced in
    // `test/isolation-placement.test.ts`: with `origin` present, `git push
    // origin work:refs/heads/x` from inside the clone creates that branch in
    // the operator's repository; with it removed the same command fails; and a
    // push naming the parent's path succeeds either way. Removing it also stops
    // a worker `git pull`-ing mid-run, which would break ruling 50's "the base
    // commit pins the state at plan time". Do not describe this as containment.
    await git({ ...inClone, args: ["remote", "remove", "origin"] });
    adoptConfig(facts.hermetic);
  }
}

/**
 * Ruling 61's refusal message, separated from the check so that it can be
 * rendered on every platform.
 *
 * `fitsBudget` short-circuits to "fits" off Windows, which is correct and also
 * means the refusal path never executes on the machine most of this was written
 * on. A refusal nobody has seen rendered names the wrong things.
 */
export function pathBudgetRefusal(verdict: FitVerdict, runRoot: string): string | null {
  if (verdict.fits) return null;
  return (
    `ruling 61: refusing this run before cloning — the deepest path it would create ` +
    `does not fit. ${verdict.worstPath} is ${verdict.worstPath?.length} characters against a ` +
    `budget of ${verdict.budget}. The run root is ${runRoot}; a shorter one is the remedy. ` +
    `#5 measured a clone target failing at 198 characters, from the inside, with a git error ` +
    `naming a path nobody chose.`
  );
}

/**
 * Where a path WOULD land, resolved by `realpath` as far as anything exists.
 *
 * `realpathSync` throws on a path that does not exist yet, and `resolve` alone
 * collapses `..` lexically and never sees a symlink — the escape v1 shipped.
 * This walks up to the deepest existing ancestor, resolves that, and re-attaches
 * the tail.
 */
export function intendedRealPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    tail.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  const real = realpathSync(existing);
  return tail.length === 0 ? real : join(real, ...tail);
}

/**
 * The temp regions this machine exempts from its sandboxes, as REAL paths.
 *
 * `realpath` per ruling 61: `$TMPDIR` on macOS is `/var/folders/...`, `/var` is
 * a symlink to `/private/var`, and comparing the unresolved forms silently
 * judges a tree that is not the one the run root is in.
 */
export function realTempDirs(env: Record<string, string | undefined> = process.env): string[] {
  const candidates = [tmpdir(), "/tmp", env["TMPDIR"], env["TEMP"], env["TMP"]];
  const real: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) continue;
    try {
      const resolved = realpathSync(candidate);
      if (!real.includes(resolved)) real.push(resolved);
    } catch {
      // A temp directory that does not exist cannot contain the run root.
    }
  }
  return real;
}
