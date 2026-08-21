// SPDX-License-Identifier: Apache-2.0
/**
 * Which agents on this machine can actually be driven?
 *
 * Ruling 41 amends decision 6: detection is TWO steps, not one. All six agents
 * measured complete `initialize` while unauthenticated and fail one step later
 * at `session/new` with an actionable error. So a completed handshake means
 * *present*, and only a completed session means *usable*. The second step costs
 * 40–300 ms and its error text is the remedy channel — Copilot's even names the
 * exact command to run.
 *
 * Detection deliberately reports THREE states rather than a boolean, because
 * "not installed" and "installed but logged out" need different remedies and
 * v1's finding was that collapsing them reported an agent present on a machine
 * where it was not on PATH.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lane } from "../lane/lane.ts";
import { lanePolicyFor } from "../work/kind.ts";
import { planAmbient } from "./ambient.ts";
import { applyOverride, driftFor, sessionContradictions, type BridgeOverride, type Drift } from "./drift.ts";
import { PROFILES, ALL_AGENT_IDS, type AgentId, type LaunchProfile } from "./profiles.ts";
import { Worker } from "./worker.ts";

export type Availability =
  /** Handshake and session both succeeded. Usable. */
  | "usable"
  /** Handshake succeeded, session failed. Present but not usable — see `remedy`. */
  | "unusable"
  /** Could not even handshake: not installed, not on PATH, or a stale coordinate. */
  | "absent";

export interface Detection {
  id: AgentId;
  availability: Availability;
  /** Reported by the agent at `initialize`, when we got that far. */
  version?: string;
  /** The vendor's own words. On `unusable` this usually names the fix. */
  remedy?: string;
  /** Where the command resolved. Ruling 46: never assume a PATH hit is ours. */
  resolvedPath?: string;
  /**
   * Ruling 69. What this agent has moved out from under, graded by what a stale
   * fact can silently break. Present only when something drifted — an agent at
   * the version its profile was measured against carries no key at all, because
   * an empty array reads as "checked and clean" only to someone who already
   * knows the field exists.
   *
   * Recorded, never pinned: agents auto-update, and a product that stops working
   * after every vendor release is not a product.
   */
  drift?: Drift[];
  /**
   * Model ids this session returned, read from `availableModels` and never
   * constructed. Ruling 68's maintenance trigger runs off this: an id here that
   * the competence table does not list is reported, which is a mechanical
   * trigger rather than a review cadence nobody enforces.
   */
  models?: string[];
  milliseconds: number;
  /**
   * Was this probed under a worker-shaped config root?
   *
   * Recorded rather than assumed, because the whole of finding V1 is that a
   * `usable` produced under the operator's own config root is not a statement
   * about what a worker will be able to do. A consumer that admits on this
   * result can tell which question was answered.
   */
  probedWorkerShaped: boolean;
}

/**
 * Probe one agent. Never throws — an agent that cannot be reached is a result,
 * not an error.
 *
 * The probe runs in a throwaway directory rather than the operator's tree, so a
 * detection sweep cannot be observed by, or write into, real work.
 */
export async function detectOne(
  profile: LaunchProfile,
  options: { timeoutMs?: number; workerShaped?: boolean } = {},
): Promise<Detection> {
  const started = Date.now();
  const scratch = mkdtempSync(join(tmpdir(), "brigadier-detect-"));
  const resolved = Bun.which(profile.command);
  // The probe runs under the SAME config root shape a worker gets, and that is
  // the difference between this function answering the question it is asked and
  // answering a nearby one.
  //
  // MEASURED 2026-08-20: it did not, and the verifier's finding V1 is the
  // consequence — `detect` reported five vendors usable, `run` routed a write to
  // Claude, and the first prompt failed with `Authentication required`. The
  // probe was passing no `configRoot`, so `buildEnvironment` left the vendor's
  // config-root variable unset and the probe read the OPERATOR's logged-in root.
  // The worker then got `join(clone.stateDir, "agent-config")` and was logged
  // out. Detection was measuring an environment no worker ever runs in.
  //
  // `join(scratch, "agent-config")` mirrors `src/queue/execute.ts`'s own
  // construction, so what is probed and what is spawned differ in path and in
  // nothing else.
  const workerShaped = options.workerShaped ?? true;
  const configRoot = join(scratch, "agent-config");
  // RULING 83, and it is the same finding V1 one lever further on. A worker's
  // environment is no longer "the config root, redirected" on every vendor: on
  // Claude it is the vendor's own argv, rewritten through a shim, with the
  // config root deliberately left alone. A probe that kept redirecting would
  // once again be measuring an environment no worker runs in — which is the
  // exact defect this function was corrected for on 2026-08-20.
  const ambient = planAmbient(profile, {
    suppress: workerShaped,
    ownedDir: configRoot,
    shimPath: join(scratch, "claude-exec-shim.sh"),
    platform: process.platform,
    resolveTarget: () => process.env["CLAUDE_CODE_EXECUTABLE"] ?? Bun.which("claude"),
  });
  // It must EXIST before the spawn. MEASURED 2026-08-20: codex-acp 1.6.2 exits
  // immediately when `CODEX_HOME` names a directory that is not there, and
  // stays up when it is. Creating it here is what makes the probe's environment
  // the worker's environment rather than a near-miss of it.
  if (ambient.configRoot !== undefined) mkdirSync(ambient.configRoot, { recursive: true });

  try {
    if (!resolved) {
      return {
        id: profile.id,
        availability: "absent",
        remedy: `${profile.command} is not on PATH`,
        milliseconds: Date.now() - started,
        probedWorkerShaped: workerShaped,
      };
    }

    const worker = await withTimeout(
      // Detection is a `read-only` probe by ruling 49's definition: nothing it
      // touches is ever read back. Both halves are asserted — the vendor's own
      // read-only mode where one was measured, and the flat `deny` lane
      // everywhere.
      Worker.start(profile, {
        cwd: scratch,
        kind: "read-only",
        lane: new Lane(scratch, lanePolicyFor("read-only")),
        ...(ambient.configRoot !== undefined ? { configRoot: ambient.configRoot } : {}),
        ...(Object.keys(ambient.env).length > 0 ? { extraEnv: ambient.env } : {}),
      }),
      options.timeoutMs ?? 60_000,
      `${profile.id} did not answer within the detection timeout`,
    );

    const version = worker.agentVersion;
    const models = [...worker.models];
    await worker.close();

    // Ruling 69, both halves. The version comparison catches a table that went
    // stale against a NUMBER; the contradiction catches a bridge replaced under
    // the same number, which no history would have seen.
    const drift = [...driftFor(profile, version), ...sessionContradictions(profile, { models })];

    return {
      id: profile.id,
      availability: "usable",
      version,
      resolvedPath: resolved,
      ...(drift.length > 0 ? { drift } : {}),
      ...(models.length > 0 ? { models } : {}),
      milliseconds: Date.now() - started,
      probedWorkerShaped: workerShaped,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // If `initialize` itself never answered, the agent is absent for our
    // purposes; if it answered and `session/new` failed, it is present but
    // unusable — and that distinction is the whole point of ruling 41.
    const reachedSession = /session\/new/.test(message);
    return {
      id: profile.id,
      availability: reachedSession ? "unusable" : "absent",
      remedy: message.slice(0, 400),
      ...(resolved ? { resolvedPath: resolved } : {}),
      milliseconds: Date.now() - started,
      probedWorkerShaped: workerShaped,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Probe every known agent concurrently.
 *
 * `overrides` are the operator's own, read from a per-machine config by the
 * caller — never from the repository, because ruling 37's principle is that
 * capability comes from the human and a repository choosing which binary
 * brigadier executes is the same class of attack as one supplying a verify
 * command. They are applied here so that detection probes the coordinate that
 * will actually be spawned rather than the one in the table.
 */
export async function detectAll(
  ids: AgentId[] = ALL_AGENT_IDS,
  options: { timeoutMs?: number; overrides?: readonly BridgeOverride[] } = {},
): Promise<Detection[]> {
  const overrides = options.overrides ?? [];
  return Promise.all(ids.map((id) => detectOne(applyOverride(PROFILES[id], overrides), options)));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
