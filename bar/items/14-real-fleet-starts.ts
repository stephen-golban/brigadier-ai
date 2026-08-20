// SPDX-License-Identifier: Apache-2.0
/**
 * Item 14 — The real fleet starts, on the argv and the config root brigadier
 * actually uses.
 *
 * Rulings 38, 41, 69, 57, 46. This item exists because of a specific, dated
 * failure and it should be read with that failure in view.
 *
 * On 2026-08-20 an independent verifier drove this harness against the compiled
 * binary and read **13 PASS / 0 FAIL / 0 SKIPPED**, exit 0, in about 39 seconds.
 * It then drove the real fleet and could not complete ONE builder turn: every
 * direct agent profile rejected brigadier's command line before any protocol,
 * and the Codex bridge threw on the value brigadier put in its config-root
 * variable. Both defects were older than the harness that declared them absent.
 *
 * The verifier's own words for why the harness could not see it:
 *
 *   > fixtures faithfully test the fixture protocol but do not test current
 *   > vendor argv/config contracts.
 *
 * Item 1 plants a fake agent. Item 5 detects the real fleet and then runs
 * builder work through fixtures. Item 9 states in its own output that its result
 * is fixture-only. **No item anywhere spawned a real vendor with the argv a real
 * worker gets.** That is the hole, and this item is the leg that fills it.
 *
 * TWO PROPERTIES MAKE THIS DIFFERENT FROM THE OTHER LIVE ITEMS.
 *
 *   It reads the contract from the ARTIFACT, never from a constant here.
 *   `brigadier agents` prints `command`, `marker` and `configroot`; this item
 *   splices them together and runs the result. A placement hard-coded in the
 *   harness would agree with a wrong table forever, which is the failure mode
 *   this item was written against. Item 1 reads `measured` from the same surface
 *   for the same reason.
 *
 *   Its demonstrated negative is a REAL vendor, not a fixture. The item respawns
 *   one direct agent with the marker appended bare — the exact form that
 *   shipped — and requires that to fail. Ruling 62 (b): a guard that always
 *   passes looks identical to a working one, and this guard's entire value is
 *   that it can tell the broken contract from the fixed one.
 *
 * WHAT IT DOES NOT PROVE, stated here rather than left to be discovered. It
 * drives `initialize` and stops. A vendor that starts may still be logged out,
 * out of quota, or unable to finish a turn — item 5 owns that, and this item
 * would have passed on a machine where every vendor was unauthenticated. What it
 * proves is narrower and was the thing missing: brigadier's launch contract is
 * one a currently-installed vendor accepts.
 *
 * HOW `exit 0` IS READ. An ACP server handed a closed stdin sees EOF and exits
 * cleanly, so a fast `exit 0` here means the argv parsed and the process started.
 * A fast non-zero exit is a parse refusal. Bridged profiles reached through
 * `npx` do not all exit on EOF — codex-acp stays up — so a timeout is ALSO a
 * pass: it means the process was alive, which is the thing being asserted.
 * Distinguishing further would need a handshake, and a handshake needs
 * credentials this check deliberately does not require.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { ensureDir } from "../lib/fs.ts";
import { combine, type LiveHalf } from "../lib/halves.ts";
import { baseEnv, exec } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/** One agent's launch contract, as the artifact describes itself. */
export interface MarkerContract {
  id: string;
  /** `copilot --acp`, split. */
  command: string;
  args: string[];
  /** The marker tail with `<marker>` still in it: `-- <marker>`, `--name <marker>`. */
  markerTail: string[];
  /** The config-root variable, or undefined where the artifact measured none. */
  configRootEnv?: string;
}

/**
 * Parse `brigadier agents`.
 *
 * Tolerant of unknown lines and intolerant of a missing one: an agent block
 * without a `marker` line is a contract the artifact did not state, and this
 * item reports that rather than inventing a placement for it.
 */
export function parseAgentContracts(stdout: string): MarkerContract[] {
  const found: MarkerContract[] = [];
  let current: Partial<MarkerContract> | undefined;

  const flush = () => {
    if (current?.id && current.command && current.markerTail) found.push(current as MarkerContract);
  };

  for (const line of stdout.split("\n")) {
    const heading = /^(\S+)\s+—\s+/.exec(line);
    if (heading?.[1]) {
      flush();
      current = { id: heading[1], args: [] };
      continue;
    }
    if (!current) continue;

    const command = /^\s+command\s+(.+)$/.exec(line);
    if (command?.[1]) {
      const parts = command[1].trim().split(/\s+/);
      current.command = parts[0] ?? "";
      current.args = parts.slice(1);
      continue;
    }
    const marker = /^\s+marker\s+(.+)$/.exec(line);
    if (marker?.[1]) {
      current.markerTail = marker[1].trim().split(/\s+/);
      continue;
    }
    const configRoot = /^\s+configroot\s+(.+)$/.exec(line);
    if (configRoot?.[1]) {
      const value = configRoot[1].trim();
      if (value !== "none measured") current.configRootEnv = value;
    }
  }
  flush();
  return found;
}

/** Splice a real marker value into the tail the artifact printed. */
export function argvFor(contract: MarkerContract, marker: string): string[] {
  return [contract.command, ...contract.args, ...contract.markerTail.map((t) => (t === "<marker>" ? marker : t))];
}

/**
 * Did this spawn START?
 *
 * `timedOut` is a pass, and the reason is in this module's header: a bridged
 * agent that does not exit on EOF is a live process, which is what is being
 * asserted. Only a fast non-zero exit is a refusal.
 */
export function started(result: { code: number | null; signal: string | null }): boolean {
  if (result.signal !== null) return true;
  return result.code === 0;
}

const PROBE_TIMEOUT_MS = 20_000;
const MARKER = "--brigadier-run=bar-item14/1";

async function spawnVendor(
  ctx: BarContext,
  argv: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; signal: string | null; first: string }> {
  const result = await exec(argv, { env, timeoutMs: PROBE_TIMEOUT_MS });
  const text = `${result.stderr}${result.stdout}`.trim();
  const first = text.split("\n")[0] ?? "";
  ctx.log(`  ${argv.join(" ")} -> code=${result.code} signal=${result.signal ?? "none"}`);
  return { code: result.code, signal: result.signal, first };
}

const item: BarItem = {
  id: 14,
  title: "The real fleet starts, on the argv and the config root brigadier actually uses",
  rulings: [38, 41, 69, 57, 46],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];
    const credentialFree = new Checks();

    // ---- credential-free half: the artifact must STATE its contract ----
    //
    // This half needs no vendor at all. It asks whether `brigadier agents`
    // describes a launch contract precisely enough for anyone to reproduce it —
    // which is the property whose absence let finding V2 live in the table
    // unchallenged.
    const agents = await ctx.run(["agents"]);
    did.push("ran `brigadier agents` and parsed each profile's command, marker placement and config root");

    credentialFree.expect(
      "`brigadier agents` succeeded",
      agents.code === 0,
      `exit ${agents.code}; ${excerpt(agents.stderr || agents.stdout, 200)}`,
    );

    const contracts = parseAgentContracts(agents.stdout);
    credentialFree.expect(
      "every profile states a marker placement",
      contracts.length > 0 && contracts.every((c) => c.markerTail.length > 0),
      contracts.length === 0
        ? "no agent blocks parsed out of `brigadier agents`"
        : contracts.map((c) => `${c.id}: ${c.markerTail.join(" ")}`).join(", "),
    );

    credentialFree.expect(
      "every stated placement carries the marker itself",
      contracts.length > 0 && contracts.every((c) => c.markerTail.includes("<marker>")),
      contracts.map((c) => `${c.id}: [${c.markerTail.join(" ")}]`).join(", ") || "none",
    );

    // A placement that is a bare `<marker>` on a NON-bridged profile is the
    // shipped defect. The artifact is allowed to say it — this item is not the
    // profile police — but the live half below will then find it, and saying so
    // here makes the two halves legible together.
    credentialFree.note(
      "placements as the artifact states them",
      contracts.map((c) => `${c.id}: ${c.command} ${[...c.args, ...c.markerTail].join(" ")}`).join("; ") || "none",
    );

    if (!ctx.live) {
      return combine(did, credentialFree, {
        kind: "skipped",
        why: "spawning the installed vendors needs the real fleet on PATH, and --live was not passed",
      });
    }

    // ---- live half: the real binaries, no fixtures anywhere ----
    const live = new Checks();
    const scratch = mkdtempSync(join(tmpdir(), "bar-item14-"));

    // Which of the artifact's agents are actually installed here? A machine
    // without a vendor is not a failing machine, and ruling 46's lesson is that
    // resolution must be reported rather than assumed.
    const present: MarkerContract[] = [];
    for (const contract of contracts) {
      const which = await exec(["/usr/bin/env", "which", contract.command], { env: baseEnv() });
      if (which.code === 0) present.push(contract);
    }
    did.push(
      `resolved ${present.length} of ${contracts.length} profiles on PATH: ${present.map((c) => c.id).join(", ") || "none"}`,
    );

    live.expect(
      "at least one profile resolved on this machine",
      present.length > 0,
      present.length === 0
        ? "no profile's command is on PATH — this item cannot say anything about the fleet"
        : present.map((c) => `${c.id} (${c.command})`).join(", "),
    );

    for (const contract of present) {
      // The config root is created BEFORE the spawn, because that ordering is
      // half of what this item proves. MEASURED 2026-08-20: codex-acp 1.6.2
      // exits immediately when CODEX_HOME names a directory that is not there.
      const configRoot = ensureDir(join(scratch, contract.id, "agent-config"));
      const env = baseEnv(contract.configRootEnv ? { [contract.configRootEnv]: configRoot } : {});
      const argv = argvFor(contract, MARKER);
      const result = await spawnVendor(ctx, argv, env);

      live.expect(
        `${contract.id} starts on the argv brigadier will use`,
        started(result),
        `argv: ${argv.join(" ")} -> code=${result.code} signal=${result.signal ?? "none"}` +
          (started(result) ? "" : `; first line: ${excerpt(result.first, 160)}`),
      );
    }
    did.push(`spawned each resolved vendor with the marker spliced in and its config root pointed at a fresh directory`);

    // ---- the demonstrated negative, on a real vendor ----
    //
    // Ruling 62 (b). Without this the item cannot distinguish "the contract is
    // right" from "the check is inert", and an inert check is exactly what
    // produced 13 PASS on an unstartable fleet.
    const negativeSubject = present.find((c) => !c.markerTail.every((t) => t === "<marker>"));
    if (negativeSubject === undefined) {
      live.expect(
        "a demonstrated negative was available",
        false,
        "no resolved profile states a non-trivial marker placement, so the broken form could not be " +
          "distinguished from the fixed one on this machine",
      );
    } else {
      const bare = [negativeSubject.command, ...negativeSubject.args, MARKER];
      const configRoot = ensureDir(join(scratch, `${negativeSubject.id}-negative`, "agent-config"));
      const env = baseEnv(negativeSubject.configRootEnv ? { [negativeSubject.configRootEnv]: configRoot } : {});
      const result = await spawnVendor(ctx, bare, env);
      live.expect(
        `${negativeSubject.id} REFUSES the bare appended marker (demonstrated negative)`,
        !started(result),
        `argv: ${bare.join(" ")} -> code=${result.code} signal=${result.signal ?? "none"}; ` +
          `first line: ${excerpt(result.first, 160)}. This is the form that shipped; if it starts, ` +
          "this item cannot tell a working contract from a broken one",
      );
      did.push(`re-spawned ${negativeSubject.id} with the marker appended bare and required that to fail`);
    }

    const liveHalf: LiveHalf = { kind: "ran", checks: live };
    return combine(did, credentialFree, liveHalf);
  },
};

export default item;
