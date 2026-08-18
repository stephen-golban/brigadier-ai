// SPDX-License-Identifier: Apache-2.0
/**
 * The integration gate: the verify command, run once more on the MERGED
 * result.
 *
 * Ruling 52's closure of #9's handoff, and ruling 51 states the gap plainly —
 * the integration branch is otherwise **unverified**. Every item's gate ran
 * inside that item's clone against that item's state, and nothing re-runs it
 * over the merge. Two items that each pass and whose merge breaks the build is
 * the classic integration failure, and without this it passes silently: N green
 * ticks and a broken branch.
 *
 * REPORTED SEPARATELY, ALWAYS. "Every item passed" and "the merged result
 * passed" are two facts, and ruling 52's whole subject is what happens when a
 * report lets one stand in for the other. So this produces its own
 * `CheckResult` under its own name, and `report.ts` prints it in its own
 * section rather than folding it into the item list.
 *
 * WHERE IT RUNS: one dedicated clone under brigadier's own run root, not the
 * operator's repository — the operator's working tree is exactly what ruling 51
 * refuses to touch, and a verify command needs a checkout. Ruling 61 applies at
 * full strength here rather than by analogy: this clone is where AGENT-WRITTEN
 * CODE EXECUTES, and #41 measured a worker under a temp root writing into
 * another clone's tracked file, so a temp-rooted run root is refused before
 * anything is created.
 *
 * AND THE ORDER RULING 56 IMPLIES: brigadier clones, sets `core.autocrlf`,
 * fetches, checks out, and then runs the operator's command — and never runs
 * another git command in that directory afterwards. From the moment the verify
 * command starts, this is a directory whose contents have executed
 * agent-authored code, and the invariant that keeps the enumeration at zero is
 * the same one that keeps it at zero for a worker clone.
 *
 * Ruling 52's four outcomes are used as they are defined, because their
 * REMEDIES differ:
 *
 *   pass          the merged result verified
 *   fail          it did not — the merge is the defect, not any one item
 *   error         the checker broke: killed, timed out. Re-run the checker.
 *   not-run       never started — the command is not on PATH. No retry helps.
 *   unconfigured  there is no verify command, which does not block
 *
 * `not-run` is resolved BEFORE the clone, by looking the command up on PATH.
 * Ruling 52 asks for exactly that, and it is the session's habit of finding out
 * before spending: cloning a repository to discover the command does not exist
 * spends a clone to learn something a lookup knows.
 */

import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { adoptConfig, git, type Hermetic } from "../isolation/internal-git.ts";
import { realTempDirs } from "../isolation/clone.ts";
import { resetDirectory, writeRegularFile } from "../isolation/safe-fs.ts";
import { RUN_DIR, isTempRooted } from "../repo/layout.ts";
import { integrationBranch } from "../repo/refs.ts";
import { INITIAL_OUTCOME, type CheckResult } from "../work/check.ts";

/** Its own name, in its own slot. Never merged with an item's gate. */
export const INTEGRATION_CHECK = "verify (merged result)";

export interface IntegrationGateSpec {
  /** The operator's repository — cloned FROM, never run in. */
  repo: string;
  runId: string;
  /** The commit the branch was just published at. Asserted after checkout. */
  commit: string;
  /**
   * The operator's verify command, argv-style.
   *
   * `null` means there is no verify command, which ruling 52 renders as
   * `unconfigured` and does not treat as a failure — a first-time user with no
   * verify command must still get a product that runs.
   */
  verify: readonly string[] | null;
  /** brigadier's own root. Ruling 61: refused if it is inside a temp region. */
  runRoot: string;
  wave?: number;
  /** #5: set explicitly before the checkout, because it is the checkout that applies it. */
  autocrlf?: string;
  /** Ruling 52's `error`: a checker that never finishes has broken, not failed. */
  timeoutMs?: number;
  /** Extra environment for the verify command. */
  env?: Record<string, string>;
}

export interface IntegrationGateResult {
  check: CheckResult;
  /**
   * The clone the gate ran in, kept.
   *
   * Kept for the same reason a conflicted item's ref is kept: a failure the
   * operator cannot inspect is a failure they have to reproduce. `discardGateClone`
   * removes it, and it is a filesystem delete with no git involved.
   */
  cloneDir: string | null;
}

/**
 * The value written to the run record BEFORE the gate runs.
 *
 * Ruling 52's write-ahead, and the whole fix for v1's third failure: a crash
 * between "started" and "finished" leaves a BLOCKING value rather than an
 * absent field. There is deliberately no code path in this module that produces
 * "no result".
 */
export function initialIntegrationCheck(wave = 1): CheckResult {
  return {
    name: INTEGRATION_CHECK,
    outcome: INITIAL_OUTCOME,
    qualifier: `wave ${wave}`,
    detail: "written before the gate started; if this is what you are reading, it never finished",
  };
}

export function gateCloneDir(runRoot: string, runId: string, wave: number): string {
  return join(runRoot, RUN_DIR, runId, "gate", String(wave));
}

/** Plain filesystem removal. No git — see the module header. */
export function discardGateClone(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export async function runIntegrationGate(
  spec: IntegrationGateSpec,
): Promise<IntegrationGateResult> {
  const wave = spec.wave ?? 1;

  if (spec.verify === null || spec.verify.length === 0) {
    return {
      cloneDir: null,
      check: {
        name: INTEGRATION_CHECK,
        outcome: "unconfigured",
        qualifier: `wave ${wave}`,
        detail:
          "no verify command is configured, so the merged result was not verified. Ruling 52 " +
          "does not treat this as a failure — and prints it here, at full size, because the " +
          "difference between an unmet requirement and an absent one is real and the " +
          "difference in how loudly they print is not.",
      },
    };
  }

  const command = spec.verify[0]!;
  const resolved = Bun.which(command);
  if (resolved === null) {
    return {
      cloneDir: null,
      check: {
        name: INTEGRATION_CHECK,
        outcome: "not-run",
        qualifier: `wave ${wave}`,
        detail:
          `${command} is not on PATH, so the merged result was never verified. This is the ` +
          "operator's environment rather than the code's, and no retry helps: install it, or " +
          "configure a verify command that exists. Resolved before cloning, deliberately.",
      },
    };
  }

  mkdirSync(spec.runRoot, { recursive: true });
  const realRoot = realpathSync(spec.runRoot);
  if (isTempRooted(realRoot, realTempDirs())) {
    throw new Error(
      `ruling 61: refusing to run the integration gate under ${realRoot}, which is inside a ` +
        "temp region. The gate is where the merged, agent-written code EXECUTES, and #41 " +
        "measured a worker in a temp root writing into another clone's tracked file — the " +
        "Codex bridge builds its sandbox with the temp roots writable by design.",
    );
  }

  const dir = gateCloneDir(realRoot, spec.runId, wave);
  const stateDir = join(realRoot, RUN_DIR, spec.runId, "gate", "state", String(wave));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const hermetic: Hermetic = {
    hooksSink: join(stateDir, "nohooks"),
    emptyGlobalConfig: join(stateDir, "empty-gitconfig"),
    config: { path: join(realpathSync(dir), ".git", "config"), known: null },
  };
  resetDirectory(hermetic.hooksSink);
  writeRegularFile(hermetic.emptyGlobalConfig, "");

  const realDir = realpathSync(dir);
  await git({ cwd: realRoot, hermetic, args: ["clone", "--local", "--no-checkout", spec.repo, realDir] });
  const inClone = { cwd: realDir, hermetic };
  if (spec.autocrlf !== undefined) {
    await git({ ...inClone, args: ["config", "core.autocrlf", spec.autocrlf] });
  }
  adoptConfig(hermetic);
  // `--no-tags`, for the reason `integrate.ts` measures: a plain fetch carries
  // whatever tags the source has, and this source is the operator's repository.
  await git({
    ...inClone,
    args: ["fetch", "--no-tags", spec.repo, `+${integrationBranch(spec.runId)}:refs/heads/verify`],
  });
  await git({ ...inClone, args: ["checkout", "verify"] });

  // Asserted rather than assumed: the gate must verify the commit the wave
  // published, not whatever the branch happens to be at if something else moved
  // it between the transaction and this clone.
  const head = await git({ ...inClone, args: ["rev-parse", "HEAD"] });
  if (head !== spec.commit) {
    return {
      cloneDir: realDir,
      check: {
        name: INTEGRATION_CHECK,
        outcome: "error",
        qualifier: `wave ${wave}`,
        detail:
          `the gate clone checked out ${head} but this wave published ${spec.commit}. ` +
          `Something moved ${integrationBranch(spec.runId)} between the publish and the gate, ` +
          "so what ran would not have been the merged result.",
      },
    };
  }

  // From here on this directory has executed agent-authored code, and no git
  // command of brigadier's runs in it again. Ruling 56, one directory over.
  return {
    cloneDir: realDir,
    check: await spawnVerify(spec, spec.verify, realDir, resolved, wave),
  };
}

async function spawnVerify(
  spec: IntegrationGateSpec,
  verify: readonly string[],
  dir: string,
  resolved: string,
  wave: number,
): Promise<CheckResult> {
  const argv = [resolved, ...verify.slice(1)];
  const rendered = verify.join(" ");
  let child;
  try {
    child = Bun.spawn(argv, {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...spec.env },
    });
  } catch (cause) {
    return {
      name: INTEGRATION_CHECK,
      outcome: "not-run",
      qualifier: `wave ${wave}`,
      detail: `\`${rendered}\` could not be started: ${String(cause)}`,
    };
  }

  let timedOut = false;
  const timer =
    spec.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, spec.timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (timer !== null) clearTimeout(timer);

  const tail = `${stdout}${stderr}`.trim().split("\n").slice(-12).join("\n");

  if (timedOut) {
    return {
      name: INTEGRATION_CHECK,
      outcome: "error",
      qualifier: `wave ${wave}`,
      detail:
        `\`${rendered}\` was killed after ${spec.timeoutMs}ms. Ruling 52: a checker that was ` +
        "killed is `error`, not `fail` — the remedy is to re-run the checker, and sending a " +
        `builder to fix a defect that is not in its code burns a rung of ruling 24's ladder.\n${tail}`,
    };
  }
  if (code === 0) {
    return {
      name: INTEGRATION_CHECK,
      outcome: "pass",
      qualifier: `wave ${wave}`,
      detail: `\`${rendered}\` on the merged commit ${spec.commit.slice(0, 12)}`,
    };
  }
  return {
    name: INTEGRATION_CHECK,
    outcome: "fail",
    qualifier: `wave ${wave}`,
    detail:
      `\`${rendered}\` exited ${code} on the merged commit ${spec.commit.slice(0, 12)}. Every ` +
      "item's own gate ran against that item's state; this is the first thing to run against " +
      `the merge.\n${tail}`,
  };
}
