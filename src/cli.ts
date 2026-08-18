#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal entry point.
 *
 * Decision 25: this is the engine's real interface, but it is a power-user and
 * debugging surface — the product is the host-first path where a model invokes
 * `brigadier` from inside its own session. Documentation leads with that; this
 * file is what it calls.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectAll, type Detection } from "./agent/detect.ts";
import { applyOverride, noBlockingReason, overrideWarning, parseOverrides, type BridgeOverride } from "./agent/drift.ts";
import { REFUSAL, isInsideWorker } from "./agent/marker.ts";
import { ALL_AGENT_IDS, PROFILES, type AgentId } from "./agent/profiles.ts";
import { LICENSES } from "./generated/licenses.ts";
import { renderCompetence, tableProblems, unlistedModels } from "./router/table.ts";

const USAGE = `brigadier — an ACP hub

  brigadier detect [--json] [--timeout <ms>] [agent...]
      Probe which agents on this machine can actually be driven. Detection is
      two steps: a handshake proves an agent is present, a session proves it is
      usable. Both must pass.

  brigadier agents
      Print the launch-profile table, with what was measured against each.

  brigadier competence
      Print the routing table this binary ranks with: every row's score, its
      evidence class and its citation. Ruling 26 ships a bare binary, and a
      table in a repository you do not have is not auditable by you.

  brigadier licenses [--full]
      brigadier's own licence and every third-party component compiled into
      this binary. --full prints the complete licence texts.

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

/**
 * Ruling 69's bridge escape hatch: a per-machine file, and nothing else.
 *
 * Under the operator's config home and NEVER inside a repository, and that
 * placement is the security property rather than a convention — ruling 37 says
 * capability comes from the human, and a cloned repository that could name the
 * binary brigadier executes is the same attack as one that could supply a
 * verify command. Nothing here consults the working directory.
 *
 * The file is optional and its absence is the normal case, so a missing file is
 * silent. A file that exists and cannot be read is not: an operator who wrote
 * one believes it is in force.
 */
function overridesPath(): string {
  const configHome = process.env["XDG_CONFIG_HOME"];
  return join(configHome && configHome.length > 0 ? configHome : join(homedir(), ".config"), "brigadier", "bridges.json");
}

function loadOverrides(): BridgeOverride[] {
  const path = overridesPath();
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`could not read ${path}: ${String(error)} — no bridge override is in force`);
    return [];
  }
  const { overrides, problems } = parseOverrides(text);
  for (const problem of problems) console.error(`${path}: ${problem}`);
  // Loud, every time. An overridden bridge invalidates every measured fact in
  // that agent's launch profile, and the operator chose it, so the operator
  // gets the consequences stated rather than discovered. On stderr so that
  // `--json` stays machine-readable without the warning being lost — a warning
  // that exists only in the human rendering is one the host-first path never
  // sees.
  for (const override of overrides) console.error(`! ${overrideWarning(override)}`);
  return overrides;
}

/** Every command that spawns or describes an agent reads the same overrides. */
const OVERRIDES = loadOverrides();

async function detect(): Promise<number> {
  const requested = argv.slice(1).filter((a) => !a.startsWith("--") && ALL_AGENT_IDS.includes(a as AgentId));
  const ids = (requested.length > 0 ? requested : ALL_AGENT_IDS) as AgentId[];
  const timeout = Number(value("timeout") ?? 60_000);

  const results = await detectAll(ids, { timeoutMs: timeout, overrides: OVERRIDES });
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
      for (const line of driftLines(result)) console.log(`  ${line}`);
      // Ruling 68's maintenance trigger: mechanical, because a review cadence
      // nobody enforces is a request. Detection already read these ids back.
      for (const model of unlistedModels(result.id, result.models ?? [])) {
        console.log(
          `  model ${model} is not in the competence table — unranked, still eligible, sorted last (ruling 68)`,
        );
      }
    }
    const usable = results.filter((r) => r.availability === "usable").length;
    console.log(`\n${usable}/${results.length} usable`);
    // Decision 32: with one vendor, cross-vendor review cannot run, and a
    // weakened check must never be reported as a pass. Ruling 71 makes the
    // other two cases explicit too — "is cross-vendor review available at all"
    // is one of the four things a first run cannot learn anywhere else, and
    // silence on a two-vendor machine answers it only by implication.
    if (usable === 0) console.log("No vendor is drivable — nothing can be run and no review is available.");
    else if (usable === 1) console.log("Only one vendor is drivable — review would run same-vendor.");
    else console.log("Cross-vendor review is available — a reviewer of a different vendor can be routed.");
    for (const line of FIRST_RUN) console.log(line);
    if (usable === 0) return 1;
  }

  return 0;
}

/**
 * Ruling 69, rendered. Recorded and graded, never pinned — agents auto-update,
 * and a product that stops working after every vendor release is not a product.
 *
 * The grade, not the distance: how far a version number moved says nothing about
 * what moved with it, and the only axis separating "your table is out of date"
 * from "your containment is gone" is what a stale fact can silently break.
 */
function driftLines(result: Detection): string[] {
  const drift = result.drift ?? [];
  if (drift.length === 0) return [];
  const profile = PROFILES[result.id];
  const lines = [
    `drift — reported ${result.version ?? "unknown"}, profile measured against ${profile.measuredVersion}.` +
      ` Recorded and graded, never pinned: agents auto-update (ruling 69)`,
  ];
  for (const entry of drift) lines.push(`  ${entry.severity.padEnd(8)} ${entry.field} — ${entry.why}`);
  const clean = noBlockingReason(profile, drift);
  if (clean) lines.push(`  ${"none".padEnd(8)} ${clean}`);
  return lines;
}

/**
 * Ruling 71's four unlearnable facts, printed where a first run will meet them.
 *
 * There is no `init` and that is settled: in the host-first path a model invokes
 * brigadier and stdout lands in a model's context, so an interactive
 * propose-flow has nobody to talk to. Detection is the lazy first contact, so
 * this is where the facts go. Each is here because it cannot be learned
 * anywhere else — decision 17 accepted the cost of suppressing ambient
 * instructions with the words "first-run must state it out loud", and isolation
 * that covers the filesystem and the process tree but NOT external services is
 * exactly the boundary a reader will otherwise assume the other way.
 */
const FIRST_RUN = [
  "",
  "Ambient instruction files (a user-global AGENTS.md and the like) are SUPPRESSED in workers by",
  "  default — decision 17. A worker will not obey them, so anything load-bearing belongs in the plan.",
  "Isolation covers the filesystem and the process tree. It does NOT cover external services: a",
  "  worker that reaches the network can still act on the world, and no clone contains that.",
];

function agents(): number {
  for (const id of ALL_AGENT_IDS) {
    // The table describes what will actually be spawned, override included —
    // a table that described the shipped coordinate while another one ran is
    // the staleness this whole file exists to avoid.
    const profile = applyOverride(PROFILES[id], OVERRIDES);
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

/**
 * Ruling 49 leaves `readOnly` absent where no vendor lever was measured, and an
 * absent lever must print as absent. Rendering "no read-only mode" as a blank
 * is the one-line way to make this table read stronger than it is.
 */
function describeReadOnly(readOnly: string | undefined, lever: string): string {
  return readOnly
    ? `${lever}=${readOnly} (read-only)`
    : "no read-only lever measured — the flat deny lane is the whole enforcement";
}

function describeLane(assertion: (typeof PROFILES)[AgentId]["laneAssertion"]): string {
  switch (assertion.kind) {
    case "env":
      return `${assertion.name}=${assertion.write} at spawn (write), ${describeReadOnly(assertion.readOnly, assertion.name)}`;
    case "session-mode":
      return `session/set_mode ${assertion.write} after session/new (write), ${describeReadOnly(assertion.readOnly, "session/set_mode")}`;
    case "none":
      return "no spawn-time lever measured — the agent decides for itself";
  }
}

/**
 * Ruling 68. The routing table, printed from inside the binary.
 *
 * `citationProblems` is enforced here rather than trusted: a table whose
 * citations have rotted is printed by nobody, because printing it with a warning
 * attached is how v1's `METHODOLOGY.md` kept being audited against anchors that
 * had already stopped pointing at anything. The gate is cheap — the table is a
 * compile-time constant, so this can only fail for a maintainer who just edited
 * it, which is exactly who should hear about it.
 */
function competence(): number {
  const problems = tableProblems();
  if (problems.length > 0) {
    console.error("the competence table cannot be printed — its citations do not hold:\n");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("\nRuling 68: cite by stable identity — a ticket, a benchmark with its version and");
    console.error("read date, a URL with a read date, or, for editorial, a reason. Never a location.");
    return 1;
  }
  for (const line of renderCompetence()) console.log(line);
  return 0;
}

/**
 * Ruling 47. Apache-2.0 §4(a) obliges us to give the licence to whoever
 * RECEIVES the work, and under ruling 26 that is routinely a bare binary from a
 * Homebrew tap, `curl | sh`, or a plugin directory — with no repository beside
 * it and no THIRD-PARTY.md to read. This command is how that obligation is
 * discharged for those recipients, so it must never depend on a file on disk.
 */
function licenses(): number {
  console.log(`${LICENSES.self.name} — ${LICENSES.self.license}`);
  console.log(LICENSES.self.copyright);
  console.log();

  if (LICENSES.components.length > 0) {
    console.log("Third-party components compiled into this binary:");
    console.log();
    for (const c of LICENSES.components) {
      console.log(`  ${c.name} ${c.version} — ${c.license}`);
      if (c.copyright) console.log(`    ${c.copyright}`);
      console.log(`    ${c.reason}`);
      console.log();
    }
  }

  if (flag("full")) {
    console.log("=".repeat(78));
    console.log("brigadier's own licence");
    console.log("=".repeat(78));
    console.log(LICENSES.apacheText);
    for (const c of LICENSES.components) {
      if (!c.licenseText) continue;
      console.log();
      console.log("=".repeat(78));
      console.log(`${c.name} ${c.version} — ${c.license}`);
      console.log("=".repeat(78));
      console.log(c.licenseText);
    }
  } else {
    console.log("Run `brigadier licenses --full` for the complete licence texts.");
  }

  return 0;
}

/**
 * Ruling 57. Commands that would orchestrate — spawn workers, clone, integrate.
 * Read-only introspection is deliberately still allowed inside a worker: it
 * cannot cause finding 114, and refusing it would only make the refusal look
 * arbitrary to a model trying to understand its situation.
 */
const ORCHESTRATING = new Set(["run", "plan"]);

const exitCode = await (async () => {
  // Checked before any command dispatch and before any input is read. v1's
  // nudge hook read the marker before reading stdin; that detail is deliberate.
  if (command !== undefined && ORCHESTRATING.has(command) && isInsideWorker()) {
    console.error(REFUSAL);
    return 3;
  }

  switch (command) {
    case "detect":
      return detect();
    case "agents":
      return agents();
    case "competence":
      return competence();
    case "licenses":
    case "--licenses":
      return licenses();
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
