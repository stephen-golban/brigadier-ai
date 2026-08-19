#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal entry point.
 *
 * Decision 25: this is the engine's real interface, but it is a power-user and
 * debugging surface — the product is the host-first path where a model invokes
 * `brigadier` from inside its own session. Documentation leads with that; this
 * file is what it calls.
 *
 * TWO THINGS IN HERE ARE NOT CONVENIENCE.
 *
 * ONE SINK (ruling 65). Every byte this process writes — every line of every
 * subcommand, and the run report — goes through the `Sink` built below, which
 * redacts the FINAL bytes against the run's inventory. There is deliberately no
 * `console.log` left in this file: `sink.outLine(result.report)` was the one that
 * mattered, because the report is composed from run text and in decision 25's
 * host-first path it lands in a model's context window permanently. `sink.end()`
 * runs before every exit, because the sink holds back a tail that a later write
 * could complete and a fragment nobody flushed is a lost line.
 *
 * ONE SIGNAL HANDLER (ruling 63). Registering one DISABLES default termination,
 * so it is a duty rather than a feature, and the duty is to give the default
 * back on demand. `src/run/interrupt.ts` is the state machine: nothing in
 * flight exits immediately with the signal's own status; the first interrupt
 * during a run drains it; the second restores `SIG_DFL` and RE-RAISES, so the
 * exit status a parent shell sees is the signal's rather than a number we made
 * up that happens to look like one.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { detectAll, type Detection } from "./agent/detect.ts";
import { applyOverride, noBlockingReason, overrideWarning, parseOverrides, type BridgeOverride } from "./agent/drift.ts";
import { REFUSAL, isInsideWorker } from "./agent/marker.ts";
import { ALL_AGENT_IDS, PROFILES, type AgentId } from "./agent/profiles.ts";
import { buildIdentity, renderVersion } from "./build/identity.ts";
import { LICENSES } from "./generated/licenses.ts";
import { resolveVerify } from "./gate/index.ts";
import { intendedRealPath, realTempDirs } from "./isolation/index.ts";
import { PLUGIN_USAGE, installCommand, pluginCommand, uninstallCommand } from "./plugin/index.ts";
import {
  admit,
  agentsOnPath,
  ceilingRefusal,
  describeAdmission,
  describeEstimate,
  describeRefusals,
  estimatePlan,
  executeRun,
  parsePlan,
  PlanUnreadable,
  recordRefusal,
  validatePlan,
  type Difficulty,
} from "./queue/index.ts";
import { defaultRunRoot, isTempRooted } from "./repo/layout.ts";
import { estimateTokens, type Audience } from "./report/index.ts";
import { SERVE_USAGE, serveCommand } from "./serve/index.ts";
import { abandon, initialState, onSignal, type InterruptState } from "./run/interrupt.ts";
import { renderCompetence, tableProblems, unlistedModels } from "./router/table.ts";
import { Sink, type Grant } from "./secrets/sink.ts";

const USAGE = `brigadier — an ACP hub

  brigadier run --plan <path> [--repo <path>] [--run-root <path>]
      Run a plan: one isolated clone per item, one marked worker each, merged
      onto refs/heads/brigadier/<run-id> and gated on the merged result.
      --dry-run     admit the plan and stop. Nothing is created.
      --estimate    a cost RANGE with its provenance, and stop (ruling 66).
      --review      route a reviewer, of a DIFFERENT vendor where one exists and
                    of the builder's own where none does (ruling 32: cross-vendor
                    is preferred, not required). The report says which ran, and a
                    reviewer that produces no verdict is an error, which blocks.
      --planted <n> how many defects an independent verifier planted in this
                    run's diffs. The denominator of the published catch rate; the
                    numerator is what reviewers named AND that appears in the diff
                    they were handed. Without it a count is printed, not a rate.
      --verify <c>  the command to run on the MERGED result (ruling 52). It is
                    resolved on PATH before a single worker exists, and it comes
                    from you — a brigadier.json committed in the repository is
                    never read (ruling 37).
      --secret-env <NAME>   grant this variable to workers, and redact its value
                    from every persisted artifact, in every encoding (ruling 65).
                    Repeatable.
      --audience terminal|acp-client|host-session   default host-session, where
                    the report is hard-capped because a model pays for it forever.
      --max-difficulty easy|medium|hard   the ceiling items are clamped DOWN to.
      --xhigh <item-id>     raise ONE item's effort ceiling from high to xhigh.
                    Ruling 30's declared edge case. A plan may not set effort at
                    all (ruling 31): it is derived from (kind, difficulty), and
                    this is the only channel that moves the ceiling. Repeatable.
      --workers <n> the per-run concurrency budget (ruling 54's third filter).

  brigadier plan --plan <path> [...]
      Everything run decides before it spends anything. The same as
      run --dry-run.

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

  brigadier version
      The build identifier: the commit this artifact was compiled from, whether
      that tree was dirty, the bun that compiled it, and the sha256 of the
      running executable's own bytes. Cite it beside any number measured against
      this binary — four warm-start figures for "this binary" exist with no
      artifact named against any of them, and they cannot be compared.

${SERVE_USAGE}

  ${PLUGIN_USAGE.trimEnd()}

Agents: ${ALL_AGENT_IDS.join(", ")}
`;

const argv = Bun.argv.slice(2);
const command = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
/**
 * Every occurrence of a repeatable flag.
 *
 * Ruling 65 grants secrets by NAME, and an operator with two of them who is
 * silently given one has a leak they cannot see: the second value is never
 * added to the inventory, so nothing redacts it.
 */
const values = (name: string): string[] => {
  const found: string[] = [];
  argv.forEach((entry, index) => {
    if (entry !== `--${name}`) return;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) found.push(next);
  });
  return found;
};

/**
 * The process's one writer, built before the first line can be printed.
 *
 * At module scope rather than inside a function because `loadOverrides` below
 * prints on stderr while it is still being evaluated, and a sink that came into
 * existence after the first write would not be the only writer.
 */
const sink = new Sink();

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
    sink.errLine(`could not read ${path}: ${String(error)} — no bridge override is in force`);
    return [];
  }
  const { overrides, problems } = parseOverrides(text);
  for (const problem of problems) sink.errLine(`${path}: ${problem}`);
  // Loud, every time. An overridden bridge invalidates every measured fact in
  // that agent's launch profile, and the operator chose it, so the operator
  // gets the consequences stated rather than discovered. On stderr so that
  // `--json` stays machine-readable without the warning being lost — a warning
  // that exists only in the human rendering is one the host-first path never
  // sees.
  for (const override of overrides) sink.errLine(`! ${overrideWarning(override)}`);
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
    sink.outLine(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      const symbol = SYMBOL[result.availability] ?? "?";
      const version = result.version ? ` ${result.version}` : "";
      sink.outLine(
        `${symbol} ${result.id.padEnd(9)} ${result.availability.padEnd(9)}${version.padEnd(10)} ${result.milliseconds}ms`,
      );
      // The remedy is the whole point of the second step: the vendor's own
      // error names the fix, so it is printed rather than swallowed.
      if (result.availability !== "usable" && result.remedy) {
        sink.outLine(`  ${result.remedy.split("\n")[0]?.slice(0, 160) ?? ""}`);
      }
      for (const line of driftLines(result)) sink.outLine(`  ${line}`);
      // Ruling 68's maintenance trigger: mechanical, because a review cadence
      // nobody enforces is a request. Detection already read these ids back.
      for (const model of unlistedModels(result.id, result.models ?? [])) {
        sink.outLine(
          `  model ${model} is not in the competence table — unranked, still eligible, sorted last (ruling 68)`,
        );
      }
    }
    const usable = results.filter((r) => r.availability === "usable").length;
    sink.outLine(`\n${usable}/${results.length} usable`);
    // Decision 32: with one vendor, cross-vendor review cannot run, and a
    // weakened check must never be reported as a pass. Ruling 71 makes the
    // other two cases explicit too — "is cross-vendor review available at all"
    // is one of the four things a first run cannot learn anywhere else, and
    // silence on a two-vendor machine answers it only by implication.
    if (usable === 0) sink.outLine("No vendor is drivable — nothing can be run and no review is available.");
    else if (usable === 1) sink.outLine("Only one vendor is drivable — review would run same-vendor.");
    else sink.outLine("Cross-vendor review is available — a reviewer of a different vendor can be routed.");
    for (const line of FIRST_RUN) sink.outLine(line);
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
    sink.outLine(`${profile.id} — ${profile.name}`);
    sink.outLine(`  command    ${profile.command} ${profile.args.join(" ")}`);
    sink.outLine(`  measured   ${profile.measuredVersion}`);
    sink.outLine(`  lane       ${describeLane(profile.laneAssertion)}`);
    sink.outLine(`  usage      ${profile.emitsUsage ? "emits usage_update" : "none over ACP"}`);
    for (const caveat of profile.caveats) sink.outLine(`  ! ${caveat}`);
    sink.outLine("");
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
    sink.errLine("the competence table cannot be printed — its citations do not hold:\n");
    for (const problem of problems) sink.errLine(`  ${problem}`);
    sink.errLine("\nRuling 68: cite by stable identity — a ticket, a benchmark with its version and");
    sink.errLine("read date, a URL with a read date, or, for editorial, a reason. Never a location.");
    return 1;
  }
  for (const line of renderCompetence()) sink.outLine(line);
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
  sink.outLine(`${LICENSES.self.name} — ${LICENSES.self.license}`);
  sink.outLine(LICENSES.self.copyright);
  sink.outLine("");

  if (LICENSES.components.length > 0) {
    sink.outLine("Third-party components compiled into this binary:");
    sink.outLine("");
    for (const c of LICENSES.components) {
      sink.outLine(`  ${c.name} ${c.version} — ${c.license}`);
      if (c.copyright) sink.outLine(`    ${c.copyright}`);
      sink.outLine(`    ${c.reason}`);
      sink.outLine("");
    }
  }

  if (flag("full")) {
    sink.outLine("=".repeat(78));
    sink.outLine("brigadier's own licence");
    sink.outLine("=".repeat(78));
    sink.outLine(LICENSES.apacheText);
    for (const c of LICENSES.components) {
      if (!c.licenseText) continue;
      sink.outLine("");
      sink.outLine("=".repeat(78));
      sink.outLine(`${c.name} ${c.version} — ${c.license}`);
      sink.outLine("=".repeat(78));
      sink.outLine(c.licenseText);
    }
  } else {
    sink.outLine("Run `brigadier licenses --full` for the complete licence texts.");
  }

  return 0;
}

/**
 * `brigadier version` — which artifact is this?
 *
 * A measurement whose subject is unnamed cannot be compared with anything. This
 * binary's warm start has been recorded four times against four artifacts and
 * no record tied a figure to a build, so the question this command answers is
 * not cosmetic. `src/build/identity.ts` carries the full reasoning and the
 * reproducibility trade-off; the short version is that the commit, the tree
 * state and the compiling bun are stamped in at compile time, and the sha256 is
 * taken of the running executable when it is asked for — a file cannot contain
 * its own digest, and a digest taken at run time is one an outside checker can
 * recompute without trusting the stamp.
 *
 * It is a command rather than a flag on every command because the digest costs
 * a read of the whole artifact. Nothing on the start-up path pays for it, which
 * matters: `bar/items/10` grades this binary's start-up in milliseconds.
 */
async function version(): Promise<number> {
  for (const line of renderVersion(await buildIdentity())) sink.outLine(line);
  return 0;
}

/**
 * `brigadier run`, and the order that makes `--dry-run` a real answer.
 *
 * Everything up to `executeRun` is computed from the plan text, `PATH` and this
 * machine's memory. Nothing before that line creates a directory, starts a
 * process or writes a ref — which is what lets a refusal be checked from the
 * outside by listing the run root and finding it unchanged. Ruling 53 asks for
 * exactly that and names the alternative: a refusal that first creates the
 * thing it is refusing has already done the thing it exists to prevent.
 *
 * THE VERIFY COMMAND COMES FROM THE OPERATOR AND NOWHERE ELSE. Ruling 37: a
 * `brigadier.json` committed in the repository is never read, so a hostile one
 * never runs — not because it is filtered, but because nothing looks at it.
 * The command arrives on this command line or in the plan the operator handed
 * over.
 *
 * `--dry-run` and `--estimate` differ in what they are for: the first answers
 * "would this run?", the second answers "what would it cost?", and ruling 66
 * makes the second a RANGE because #44 measured two identical runs 15× apart.
 * Both stop before anything is spent.
 */
async function run(): Promise<number> {
  const planPath = value("plan");
  if (planPath === undefined) {
    sink.errLine("brigadier run --plan <path> [--repo <path>] [--run-root <path>]\n");
    sink.errLine(USAGE);
    return 2;
  }

  const repo = absolute(value("repo") ?? process.cwd());
  const runRoot = absolute(value("run-root") ?? defaultRunRoot());
  const audience = audienceFrom(value("audience"));
  const ceiling = difficultyFrom(value("max-difficulty"));
  if (ceiling === null) {
    sink.errLine(`--max-difficulty must be one of easy, medium, hard`);
    return 2;
  }

  let spec;
  try {
    spec = parsePlan(readFileSync(planPath, "utf8"), planPath);
  } catch (error) {
    sink.errLine(error instanceof PlanUnreadable ? error.message : `could not read ${planPath}: ${String(error)}`);
    return 2;
  }

  // Ruling 61, before anything is created rather than at the first clone. #41
  // measured the Codex bridge building its sandbox with `/tmp` and `$TMPDIR`
  // writable BY DESIGN, and a worker there writing into another clone's tracked
  // file — so the conventional home for scratch directories is exactly the
  // region that makes concurrent workers non-isolated. Judged by realpath,
  // never lexically: macOS's /var → /private/var symlink is why the ruling says so.
  const intendedRoot = intendedRealPath(runRoot);
  if (isTempRooted(intendedRoot, realTempDirs())) {
    sink.errLine(
      `refused — the run root ${intendedRoot} is inside a temp region, and nothing was started.\n` +
        "  Ruling 61: brigadier's run directories live outside every temp root. #41 measured a worker\n" +
        "  under a temp root writing into another clone's tracked file, because the Codex ACP bridge\n" +
        "  builds its sandbox with the temp roots writable by design.\n" +
        `  Remedy: pass --run-root somewhere outside it, or omit it and get ${defaultRunRoot()}.`,
    );
    return 4;
  }

  // Ruling 69: the same override the table describes is the one that resolves.
  const agents = agentsOnPath((command) => Bun.which(command), OVERRIDES);
  const plan = validatePlan(spec, {
    cwd: repo,
    agents,
    ...(ceiling === undefined ? {} : { ceiling }),
  });
  const workers = value("workers");
  const admission = admit({
    plan,
    agents,
    // Decision 25: the product is host-first, so brigadier normally runs inside
    // a host agent's session and that agent gets a worker's RAM budget.
    hostFirst: audience === "host-session",
    // Ruling 32's reviewer is decided at admission and printed there, so the run
    // cannot report a different answer from the one the operator was shown.
    review: flag("review"),
    ...(workers === undefined ? {} : { desirabilityCap: Number(workers) }),
  });

  if (admission.refusals.length > 0) {
    for (const line of describeRefusals(admission.refusals, planPath)) sink.errLine(line);
    return 4;
  }

  // Ruling 66's structural rule on the pair, checked here because here is
  // before anything is created: *the gap between the ceilings must exceed the
  // most expensive item that could be in flight, or the soft ceiling never
  // prevents the hard one firing.* A soft ceiling that cannot stop a hard one
  // is a line in a report rather than a control, and this is the last moment
  // that costs nothing to say so.
  const gap = ceilingRefusal(
    value("soft-ceiling") === undefined ? undefined : Number(value("soft-ceiling")),
    value("hard-ceiling") === undefined ? undefined : Number(value("hard-ceiling")),
    admission.fanOut[0]?.workers ?? 1,
  );
  // Two answers, and only one of them stops the run. A pair whose soft ceiling
  // can never act first is refused and nothing is created; a pair whose gap is
  // merely too narrow is a WEAKENED soft ceiling, said out loud before anything
  // is spent and carried into the report — because refusing there left the
  // operator with no run, no record and no blocking check at all.
  if (gap !== null) {
    for (const line of gap.lines) sink.errLine(line);
    if (gap.refuse) {
      sink.errLine("nothing was started.");
      return 4;
    }
  }

  if (flag("estimate")) {
    const estimate = estimatePlan(
      plan.items,
      admission.fanOut[0]?.workers ?? 1,
      admission.agents.map((agent) => agent.id),
    );
    for (const line of describeEstimate(estimate)) sink.outLine(line);
    sink.outLine("nothing was started: --estimate stops before the run root is created.");
    return 0;
  }

  // The AUDIENCE travels with it. Ruling 58's ceiling is on everything this
  // process writes to stdout, not on the report alone — a fifty-item run
  // measured 3,682 tokens against a 2,000-token ceiling with the report already
  // inside its budget, because these lines were never counted against anything.
  const admitted = describeAdmission(admission, planPath, audience);
  for (const line of admitted) sink.outLine(line);
  // What those lines cost, measured on the bytes that were actually written, and
  // handed to the run so the report spends what is LEFT of the ceiling.
  const prologueTokens = estimateTokens(admitted.join("\n"));

  if (flag("dry-run")) {
    sink.outLine("nothing was started: --dry-run stops before the run root is created.");
    return 0;
  }

  // The merged-result gate's command. Resolved HERE, before a worker exists.
  const verify = resolveVerify(value("verify"), repo);
  if (verify.status === "missing") {
    sink.errLine(verify.refusal ?? "the verify command could not be resolved");
    return 4;
  }

  mkdirSync(runRoot, { recursive: true });
  const result = await executeRun({
    repo,
    runRoot: realpathSync(runRoot),
    planPath,
    admission,
    audience,
    // Ruling 58: what the admission block above already charged to this stdout,
    // so the report spends what is LEFT of the ceiling rather than all of it.
    prologueTokens,
    verify,
    review: flag("review"),
    ...(value("planted") === undefined ? {} : { planted: Number(value("planted")) }),
    secretEnv: values("secret-env"),
    // Ruling 30's declared edge case, and ruling 31's reason it is here rather
    // than in the plan: the operator raises a ceiling, never the plan.
    xhigh: values("xhigh"),
    ...(value("soft-ceiling") === undefined ? {} : { softCeiling: Number(value("soft-ceiling")) }),
    ...(value("hard-ceiling") === undefined ? {} : { hardCeiling: Number(value("hard-ceiling")) }),
    // Ruling 65: the process's ONE sink, handed down rather than rebuilt, so
    // there is one inventory and one writer for the report as well as for the
    // record. `executeRun` hands the same object back.
    sink,
    // Ruling 63: this is what makes a signal mean "drain" rather than "die".
    onInFlight: inFlight,
  });
  // The report is not returned as a string for this function to print — ruling
  // 65: a caller holding the bytes owns the write, and that is the shape the
  // sink exists to remove. `executeRun` wrote it through the sink already.
  for (const line of describeGrant(result.grant)) sink.errLine(line);
  interruptedBy = result.interruptedBy;
  return result.exitCode;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/** Decision 25's default: a model is reading this, and it pays for every byte. */
function audienceFrom(name: string | undefined): Audience {
  if (name === "terminal" || name === "acp-client") return name;
  return "host-session";
}

function difficultyFrom(name: string | undefined): Difficulty | undefined | null {
  if (name === undefined) return undefined;
  if (name === "easy" || name === "medium" || name === "hard") return name;
  return null;
}

/**
 * Ruling 57. Commands that would orchestrate — spawn workers, clone, integrate.
 * Read-only introspection is deliberately still allowed inside a worker: it
 * cannot cause finding 114, and refusing it would only make the refusal look
 * arbitrary to a model trying to understand its situation.
 *
 * `serve` IS ORCHESTRATION, and it is here because of what it is FOR rather
 * than what it currently does. A worker that starts an ACP server has handed a
 * driving surface for brigadier to whatever is on the other end of its stdio —
 * which is finding 114 with an extra hop, and a hop is not a mitigation. It
 * does not matter that this build's `session/prompt` stops at admission: the
 * command exists so that an editor can drive brigadier, and admitting it inside
 * a worker would mean the guard has to be re-argued the day execution is wired.
 * Ruling 57's refusal is binary on purpose, and `version`, `detect`, `agents`,
 * `competence` and `licenses` stay out of this set because none of them can
 * drive anything.
 */
const ORCHESTRATING = new Set(["run", "plan", "serve"]);

/**
 * Ruling 63, wired. One handler, one state machine, three behaviours.
 *
 * `initialState(false)`: nothing is in flight yet, so the FIRST signal here
 * abandons immediately — there is nothing to clean up and a handler that delays
 * is pure downside. `run` calls `inFlight` before the first clone exists, which
 * moves the machine to `draining`; from there the first signal drains the run
 * and the second abandons.
 *
 * `abandon` is `SIG_DFL` plus a re-raise, and that is the whole point:
 * `process.exit(130)` imitates a signal-terminated status and is not one. A
 * re-raised signal is reported as such by a parent shell, attributed correctly
 * by a CI runner, and distinguishable from an ordinary non-zero exit by a
 * supervisor. `sink.end()` runs first — flushing a tail is not cleanup, it is
 * the last bytes of what already happened, and the alternative is losing a line
 * the operator was already owed.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-18: a process that removes its own
 * `SIGINT` listener and then calls `process.kill(process.pid, "SIGINT")` is
 * reaped with a null exit code and a `SIGINT` wait status — the same status a
 * process with no handler at all gets, and distinguishable by a shell from any
 * exit code the program could have chosen. `test/cli-interrupt.test.ts` asserts
 * on that status rather than on a number.
 */
let interrupts: InterruptState = initialState(false);
let drainRun: ((signal: NodeJS.Signals) => void) | null = null;

function raise(signal: NodeJS.Signals): void {
  process.kill(process.pid, signal);
}

function onInterrupt(signal: NodeJS.Signals): void {
  interrupts = onSignal(interrupts, signal);
  if (interrupts.phase === "abandoning") {
    sink.end();
    abandon(signal, raise);
    return;
  }
  drainRun?.(signal);
}

/** Called by `executeRun` before the first clone. From here a signal drains. */
function inFlight(drain: (signal: NodeJS.Signals) => void): void {
  drainRun = drain;
  interrupts = initialState(true);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => onInterrupt(signal));

/**
 * What `--secret-env` actually did, BY NAME.
 *
 * `tooShort` is `MINIMUM_SECRET_LENGTH`'s hole said out loud instead of left to
 * be discovered: a granted value under 8 characters IS delivered to the worker
 * and is NOT inventoried, so nothing redacts it out of anything. Redacting every
 * occurrence of a three-character string would destroy more than it protects, so
 * the floor stays — but an operator who granted a short value is owed the
 * sentence, and stderr is where a warning survives `--audience host-session`.
 */
function describeGrant(grant: Grant): string[] {
  const lines: string[] = [];
  if (grant.tooShort.length > 0) {
    lines.push(
      `! ${grant.tooShort.join(", ")} — granted and delivered, and NOT redacted from anything: a value ` +
        "shorter than 8 characters is deliberately not inventoried, because redacting every occurrence " +
        "of a short string destroys more than it protects (ruling 65).",
    );
  }
  if (grant.unset.length > 0) {
    lines.push(
      `! ${grant.unset.join(", ")} — named by --secret-env and unset or empty in this environment, so ` +
        "nothing was delivered and nothing is inventoried under that name.",
    );
  }
  return lines;
}

let interruptedBy: NodeJS.Signals | null = null;

const exitCode = await (async () => {
  // Checked before any command dispatch and before any input is read. v1's
  // nudge hook read the marker before reading stdin; that detail is deliberate.
  if (command !== undefined && ORCHESTRATING.has(command) && isInsideWorker()) {
    sink.errLine(REFUSAL);
    // RULING 59, AND THE ORDER IS DELIBERATE: refuse FIRST, count second.
    //
    // Ruling 57's binary refusal is the guard and it is unconditional; the
    // ledger is an observation about it. `recordRefusal` never throws for
    // exactly that reason — a run whose ledger is unwritable must still exit 3,
    // because bar item 9 measured that exit as the thing that stops finding
    // 114, and turning it into a crash would trade the guard for its own
    // telemetry. A worker spawned by an older brigadier carries ruling 57's
    // bare `"1"` and lands on `no-home`: refused, uncounted, and said so.
    // Through the process's ONE sink (ruling 65), which is what redacts the
    // composed line and carries the append-only, `O_NOFOLLOW`, whole-line
    // guarantees. `src/secrets/audit.ts`'s ratchet caught the first draft of
    // this writing its own bytes; the comment explaining why that was careful
    // was true and it was still a second writer.
    const recorded = recordRefusal(command, sink);
    if (recorded.kind === "no-home" || recorded.kind === "unwritable") {
      sink.errLine(
        `this refusal was NOT counted: ${recorded.kind === "no-home" ? recorded.why : recorded.why}. The run's ` +
          "report will therefore under-count refused delegations (ruling 59).",
      );
    }
    return 3;
  }

  switch (command) {
    case "run":
      return run();
    // Ruling 53's whole point, as its own verb: everything `run` decides before
    // it spends anything, and nothing it decides afterwards.
    case "plan":
      argv.push("--dry-run");
      return run();
    // Ruling 2's server half. Every frame goes through the process's ONE sink
    // (ruling 65) — `sink.out` and not a second writer on stdout, which is what
    // `src/secrets/audit.ts` ratchets against and which would be the worst
    // possible bypass, because a frame is composed from run text and then
    // JSON-escaped. The sink sees the final bytes.
    //
    // On stdout the sink is now the FRAME stream, so nothing else may print
    // there for the life of the command; `serveCommand` puts all prose inside
    // `session/update` frames and leaves warnings on stderr. It registers no
    // signal handler: ruling 63's one handler above already covers a server
    // that holds no run, and its `idle` branch re-raises rather than inventing
    // an exit code.
    case "serve":
      return serveCommand({
        writeLine: (line) => sink.out(`${line}\n`),
        cwd: absolute(value("repo") ?? process.cwd()),
        ...(value("run-root") === undefined ? {} : { runRoot: absolute(value("run-root")!) }),
        overrides: OVERRIDES,
        // stderr, never stdout: on stdout the sink is the frame stream.
        warn: (text) => sink.errLine(text),
      });
    case "detect":
      return detect();
    case "agents":
      return agents();
    case "competence":
      return competence();
    case "licenses":
    case "--licenses":
      return licenses();
    // Deliberately outside `ORCHESTRATING`: reporting which artifact is running
    // spawns nothing and creates nothing, and a worker that cannot name the
    // binary it is inside cannot report what it measured either.
    case "version":
    case "--version":
    case "-V":
      return version();
    // The plugin surface. Deliberately NOT in `ORCHESTRATING`: `install` and
    // `uninstall` carry their own worker refusal inside `src/plugin/index.ts`,
    // because a worker writing brigadier's skill into the operator's home is
    // finding 114's second route rather than an orchestration; and
    // `plugin hooks` must stay readable inside a worker, since reading a file
    // cannot cause either failure and an arbitrary-looking refusal teaches a
    // model nothing.
    case "install":
      return installCommand(argv.slice(1));
    case "uninstall":
      return uninstallCommand(argv.slice(1));
    case "plugin":
      return pluginCommand(argv.slice(1));
    case undefined:
    case "-h":
    case "--help":
      sink.outLine(USAGE);
      return 0;
    default:
      sink.errLine(`unknown command: ${command}\n`);
      sink.errLine(USAGE);
      return 2;
  }
})();

// The tail the sink is holding is flushed before ANY exit. It is held back
// precisely because a pattern could straddle it, so the last line of a run is
// exactly the line that goes missing without this.
sink.end();

// Ruling 63: a run that was interrupted exits as the SIGNAL, not as a number.
if (interruptedBy !== null) abandon(interruptedBy, raise);

process.exit(exitCode);
