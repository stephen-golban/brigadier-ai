#!/usr/bin/env bun
/**
 * The terminal entry point.
 *
 * Decision 25: this is the engine's real interface, but it is a power-user and
 * debugging surface — the product is the host-first path where a model invokes
 * `brigadier` from inside its own session. Documentation leads with that; this
 * file is what it calls.
 */

import { detectAll } from "./agent/detect.ts";
import { ALL_AGENT_IDS, PROFILES, type AgentId } from "./agent/profiles.ts";

const USAGE = `brigadier — an ACP hub

  brigadier detect [--json] [--timeout <ms>] [agent...]
      Probe which agents on this machine can actually be driven. Detection is
      two steps: a handshake proves an agent is present, a session proves it is
      usable. Both must pass.

  brigadier agents
      Print the launch-profile table, with what was measured against each.

Agents: ${ALL_AGENT_IDS.join(", ")}
`;

const argv = Bun.argv.slice(2);
const command = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const SYMBOL: Record<string, string> = { usable: "✓", unusable: "!", absent: "·" };

async function detect(): Promise<number> {
  const requested = argv.slice(1).filter((a) => !a.startsWith("--") && ALL_AGENT_IDS.includes(a as AgentId));
  const ids = (requested.length > 0 ? requested : ALL_AGENT_IDS) as AgentId[];
  const timeout = Number(value("timeout") ?? 60_000);

  const results = await detectAll(ids, { timeoutMs: timeout });
  results.sort((a, b) => a.id.localeCompare(b.id));

  if (flag("json")) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      const symbol = SYMBOL[result.availability] ?? "?";
      const version = result.version ? ` ${result.version}` : "";
      console.log(
        `${symbol} ${result.id.padEnd(9)} ${result.availability.padEnd(9)}${version.padEnd(10)} ${result.milliseconds}ms`,
      );
      // The remedy is the whole point of the second step: the vendor's own
      // error names the fix, so it is printed rather than swallowed.
      if (result.availability !== "usable" && result.remedy) {
        console.log(`  ${result.remedy.split("\n")[0]?.slice(0, 160) ?? ""}`);
      }
    }
    const usable = results.filter((r) => r.availability === "usable").length;
    console.log(`\n${usable}/${results.length} usable`);
    // Decision 32: with one vendor, cross-vendor review cannot run, and a
    // weakened check must never be reported as a pass.
    if (usable === 1) console.log("Only one vendor is drivable — review would run same-vendor.");
    if (usable === 0) return 1;
  }

  return 0;
}

function agents(): number {
  for (const id of ALL_AGENT_IDS) {
    const profile = PROFILES[id];
    console.log(`${profile.id} — ${profile.name}`);
    console.log(`  command    ${profile.command} ${profile.args.join(" ")}`);
    console.log(`  measured   ${profile.measuredVersion}`);
    console.log(`  lane       ${describeLane(profile.laneAssertion)}`);
    console.log(`  usage      ${profile.emitsUsage ? "emits usage_update" : "none over ACP"}`);
    for (const caveat of profile.caveats) console.log(`  ! ${caveat}`);
    console.log();
  }
  return 0;
}

function describeLane(assertion: (typeof PROFILES)[AgentId]["laneAssertion"]): string {
  switch (assertion.kind) {
    case "env":
      return `${assertion.name}=${assertion.restrictive} at spawn`;
    case "session-mode":
      return `session/set_mode ${assertion.restrictive} after session/new`;
    case "none":
      return "no spawn-time lever measured — the agent decides for itself";
  }
}

const exitCode = await (async () => {
  switch (command) {
    case "detect":
      return detect();
    case "agents":
      return agents();
    case undefined:
    case "-h":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
})();

process.exit(exitCode);
