// SPDX-License-Identifier: Apache-2.0
/**
 * The one place `src/isolation/` spawns git, and the whole runtime enforcement
 * of ruling 56.
 *
 *     brigadier runs no git command inside a clone after an agent has had
 *     access to it.
 *
 * Every git invocation is one of exactly two kinds, and there is no third:
 *
 *   AUTHORISED — inside a clone brigadier owns right now. Proved by a
 *     capability token: a random nonce written to a file outside the clone,
 *     whose value is held in memory by the handle. `releaseToAgent` DELETES the
 *     file, so the check FAILS CLOSED. An agent that deletes the token, or
 *     overwrites it with content of its own, gets a refusal either way. It
 *     cannot forge one, because it has never seen the nonce.
 *
 *   UNAUTHORISED — anywhere else, which in practice means the operator's own
 *     repository. Refused if the target is inside a clone this process has
 *     released, or inside a clone any run manifest claims. That is what stops
 *     `witnessOperator(agentClone.dir)` and `buildBaseState({ repo: clone })`.
 *
 * THE TOKEN ANSWERS THE WRONG QUESTION ON ITS OWN, and this is the correction a
 * third blind critic earned by attacking it. A token proves "is this directory
 * brigadier's right now". The invariant needs "is this directory free of
 * agent-supplied execution surfaces right now". Authority is durable and
 * sanitisation was instantaneous: one `writeFileSync` of `.git/config` after
 * `recycleClone` returned owned every later spawn, because git re-reads
 * `.git/config` from disk on every invocation. So sanitisation moved to where
 * the reading happens. IMMEDIATELY BEFORE EVERY SPAWN, as plain filesystem
 * operations with nothing in between:
 *
 *   1. the hooks sink is deleted and recreated empty;
 *   2. the empty global config is rewritten from memory — it used to be written
 *      once at creation, which left a file an agent could fill in later and be
 *      read on every subsequent invocation;
 *   3. the clone's `.git/config` is rewritten from brigadier's in-memory
 *      known-good copy, once there is one.
 *
 * The environment is BUILT rather than inherited. `...process.env` passed
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` straight through (a config channel
 * that needs no file at all), and `GIT_DIR` pointed at a released clone made an
 * unauthorised call run inside it while the cwd looked innocent.
 * `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY` and
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES` are the same shape. An allowlist is the
 * only form of this that does not need updating each time git grows a variable.
 *
 * MEASURED against `git 2.50.1` on 2026-08-17 (`probes/git-exec.sh`, and
 * reproduced by `test/isolation-recycle.test.ts` and
 * `test/isolation-live.test.ts` on macOS 25.5.0): a planted `pre-commit`,
 * `post-checkout` or `reference-transaction` hook escapes on an ordinary
 * `commit`, `checkout` or `update-ref`; `--no-verify` does not cover
 * `post-checkout`; `-c core.hooksPath=<empty>` closes all three and does NOT
 * close `core.fsmonitor`, which executes on an ordinary `git status`.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { hooklessArgs } from "../repo/git.ts";
import { claimedByManifest } from "./manifest.ts";
import { resetDirectory, writeRegularFile } from "./safe-fs.ts";

/**
 * A file inside the clone naming it as one.
 *
 * The WEAKEST of the three signals and deliberately no longer the durable one:
 * an agent owns this directory and can delete it, and `git gc` erases the
 * companion signal (the loose `refs/heads/brigadier-base`) with no hostile
 * intent at all. The manifest is the record that survives both.
 */
export const CLONE_SIGNATURE = "brigadier-clone";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The capability to run git inside one specific clone.
 *
 * Held in memory by a `PreparedClone`. Not serialisable by design: the nonce
 * exists in exactly two places, this process's memory and a file brigadier
 * controls.
 */
export interface CloneAuthority {
  /** The clone, by `realpath`. An authority authorises this directory and no other. */
  readonly dir: string;
  /** Where the nonce is written. Outside the clone. */
  readonly tokenPath: string;
  readonly nonce: string;
}

/**
 * The clone's `.git/config` as brigadier means it to be.
 *
 * `known` is mutable on purpose. It is null while `prepareClone` is still
 * building the clone — there is nothing to restore yet, and no agent has been
 * anywhere near it — and it is adopted once brigadier's own `git config` calls
 * have finished. From that moment every spawn rewrites the file from this
 * string, so a poisoned config survives for no invocations at all rather than
 * for all of them.
 */
export interface CloneConfig {
  readonly path: string;
  known: string | null;
}

/** The parts of a clone-scoped invocation that are hermetic rather than authorising. */
export interface Hermetic {
  /** Per-item, outside the clone, recreated empty before every invocation. */
  readonly hooksSink: string;
  /** An empty file brigadier owns, rewritten before every invocation. */
  readonly emptyGlobalConfig: string;
  readonly config: CloneConfig;
}

export interface GitRun {
  cwd: string;
  args: string[];
  /** Extra environment. `GIT_INDEX_FILE` arrives here, and nowhere else. */
  env?: Record<string, string>;
  /** Present for every command inside a clone brigadier owns. */
  authority?: CloneAuthority;
  /** Present for every clone-scoped command, including `git clone` itself. */
  hermetic?: Hermetic;
}

export class GitFailure extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly result: GitResult,
  ) {
    super(`git ${argv.join(" ")} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GitFailure";
  }
}

export class GitRefused extends Error {
  constructor(message: string) {
    super(`ruling 56: ${message}`);
    this.name = "GitRefused";
  }
}

/**
 * Clones this process has handed to an agent.
 *
 * In-process and exact. The manifest is what covers another process, and the
 * on-disk signature is the third of three. None of them is claimed to be a
 * boundary against an agent that has already escaped its sandbox.
 */
const releasedClones = new Set<string>();

export function markReleased(dir: string): void {
  releasedClones.add(dir);
}

export function unmarkReleased(dir: string): void {
  releasedClones.delete(dir);
}

/**
 * The environment a git child is allowed to see.
 *
 * An allowlist, so that a variable git grows next year is excluded by default
 * rather than by an update to a blocklist. Everything git reads that changes
 * WHERE it works or WHAT it configures — `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_CONFIG_*`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
 * `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF` — is outside it, and so is
 * `LD_PRELOAD` and its friends.
 *
 * `PATH` is kept, and that is a deliberate limit rather than an oversight: git
 * needs it to find its own helpers, and the shell a hook or filter would run.
 * Which is why `git` itself is resolved to an absolute path once, below, rather
 * than looked up per spawn.
 */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Windows needs these to run a process at all.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "TEMP",
  "TMP",
]);

export function allowedEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) allowed[key] = value;
  }
  return allowed;
}

/**
 * `git`, resolved once.
 *
 * `PATH` has to stay in the child environment, so a `PATH` entry that shadows
 * `git` would otherwise be consulted on every spawn. Resolving at module load
 * narrows that to the state of `PATH` when brigadier started. It is a
 * narrowing, not a boundary.
 */
const GIT = Bun.which("git") ?? "git";

/** Run git and hand back the raw result, including a non-zero exit. */
export async function runGit(run: GitRun): Promise<GitResult> {
  const real = realpathSync(run.cwd);

  if (run.authority === undefined) {
    refuseWorkerClone(real);
  } else {
    authorise(run.authority, real);
  }

  if (run.hermetic !== undefined) {
    // Plain filesystem work, immediately before the spawn, with nothing in
    // between. Not once per recycle: git re-reads `.git/config` from disk on
    // every invocation, so anything sanitised once per recycle is sanitised for
    // the first invocation and for no others.
    resetDirectory(run.hermetic.hooksSink);
    writeRegularFile(run.hermetic.emptyGlobalConfig, "");
    if (run.hermetic.config.known !== null) {
      writeRegularFile(run.hermetic.config.path, run.hermetic.config.known);
    }
  }

  const argv = [
    GIT,
    ...(run.hermetic === undefined ? [] : hooklessArgs(run.hermetic.hooksSink)),
    ...run.args,
  ];

  const child = Bun.spawn(argv, {
    cwd: run.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...allowedEnv(),
      // A credential prompt fails as a hang rather than an error, and
      // AGENTS.md records that a hang is the failure nobody diagnoses.
      GIT_TERMINAL_PROMPT: "0",
      ...(run.hermetic === undefined
        ? {}
        : { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: run.hermetic.emptyGlobalConfig }),
      ...run.env,
    },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  return { code, stdout, stderr };
}

/** Run git, throw on a non-zero exit, return trimmed stdout. */
export async function git(run: GitRun): Promise<string> {
  const result = await runGit(run);
  if (result.code !== 0) throw new GitFailure(["git", ...run.args], result);
  return result.stdout.trim();
}

/** Adopt the config brigadier's own `git config` calls have just written. */
export function adoptConfig(hermetic: Hermetic): void {
  hermetic.config.known = readFileSync(hermetic.config.path, "utf8");
}

function authorise(authority: CloneAuthority, real: string): void {
  if (authority.dir !== real) {
    throw new GitRefused(
      `an authority for ${authority.dir} does not authorise a command in ${real}`,
    );
  }
  let presented: string;
  try {
    presented = readFileSync(authority.tokenPath, "utf8");
  } catch {
    throw new GitRefused(
      `no capability token at ${authority.tokenPath}, so ${real} is not brigadier's to ` +
        "run git in. It has been released to an agent, or something removed the token. " +
        "Recycle it through recycleClone(), which restores .git/hooks and .git/config as " +
        "filesystem operations before git is invoked at all.",
    );
  }
  if (presented !== authority.nonce) {
    throw new GitRefused(
      `the capability token at ${authority.tokenPath} does not match the one brigadier ` +
        `wrote for ${real}. Something replaced it.`,
    );
  }
}

function refuseWorkerClone(real: string): void {
  for (const dir of releasedClones) {
    if (real === dir || real.startsWith(dir + sep)) {
      throw new GitRefused(
        `${real} is inside ${dir}, which this process handed to an agent. No git command ` +
          "runs in there — not a status, not a witness, not a base state.",
      );
    }
  }
  const manifest = claimedByManifest(real);
  if (manifest !== null) {
    throw new GitRefused(
      `${real} is a brigadier worker clone, recorded in ${manifest}. An agent may have been ` +
        "in it, so brigadier does not run git there. The operator's repository is the " +
        "argument these functions want.",
    );
  }
  const signature = signatureAbove(real);
  if (signature !== null) {
    throw new GitRefused(
      `${real} is inside a brigadier worker clone (${signature}). An agent may have been in ` +
        "it, so brigadier does not run git there.",
    );
  }
}

/**
 * The in-clone signature on `dir` or an ancestor, or null.
 *
 * Third of three, and the one that can be erased from inside the clone. Kept
 * because it costs one `existsSync` and covers a clone whose manifest has been
 * removed; not relied on, because `git gc` alone is enough to remove half of it.
 */
function signatureAbove(dir: string): string | null {
  let current = dir;
  for (;;) {
    for (const candidate of [
      join(current, ".git", CLONE_SIGNATURE),
      join(current, ".git", "refs", "heads", "brigadier-base"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Split a `-z` git output into records, dropping the trailing empty one. */
export function nulRecords(output: string): string[] {
  return output.split("\0").filter((record) => record.length > 0);
}
