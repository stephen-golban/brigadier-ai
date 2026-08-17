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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lane } from "../lane/lane.ts";
import { lanePolicyFor } from "../work/kind.ts";
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
  milliseconds: number;
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
  options: { timeoutMs?: number } = {},
): Promise<Detection> {
  const started = Date.now();
  const scratch = mkdtempSync(join(tmpdir(), "brigadier-detect-"));
  const resolved = Bun.which(profile.command);

  try {
    if (!resolved) {
      return {
        id: profile.id,
        availability: "absent",
        remedy: `${profile.command} is not on PATH`,
        milliseconds: Date.now() - started,
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
      }),
      options.timeoutMs ?? 60_000,
      `${profile.id} did not answer within the detection timeout`,
    );

    const version = worker.agentVersion;
    await worker.close();

    return {
      id: profile.id,
      availability: "usable",
      version,
      resolvedPath: resolved,
      milliseconds: Date.now() - started,
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
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Probe every known agent concurrently. */
export async function detectAll(
  ids: AgentId[] = ALL_AGENT_IDS,
  options: { timeoutMs?: number } = {},
): Promise<Detection[]> {
  return Promise.all(ids.map((id) => detectOne(PROFILES[id], options)));
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
