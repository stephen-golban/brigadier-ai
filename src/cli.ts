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

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { detectAll, type Detection } from "./agent/detect.ts";
import {
  artifactFingerprint,
  describeCacheUse,
  detectCachePath,
  fingerprintsNow,
  planFromCache,
  readDetectCache,
  writeDetectCache,
} from "./agent/detect-cache.ts";
import { applyOverride, noBlockingReason, overrideWarning, parseOverrides, type BridgeOverride } from "./agent/drift.ts";
import { REFUSAL, isInsideWorker } from "./agent/marker.ts";
import { ALL_AGENT_IDS, PROFILES, type AgentId } from "./agent/profiles.ts";
import { buildIdentity, embeddedStamp, renderVersion } from "./build/identity.ts";
import { ConfigUnusable, bridgesPath, configPath, loadConfig, resolve as prefer } from "./config/config.ts";
import { LICENSES } from "./generated/licenses.ts";
import { resolveVerify } from "./gate/index.ts";
import { intendedRealPath, realTempDirs } from "./isolation/index.ts";
import { PLUGIN_USAGE, contextFrom, installCommand, pluginCommand, uninstallCommand } from "./plugin/index.ts";
import { install } from "./plugin/install.ts";
import { PlannerRefused, choosePlanner, commissionPlan } from "./plan/commission.ts";
import { PlannerUnusable, looksTrivial } from "./plan/planner.ts";
import { buildBaseState } from "./isolation/base.ts";
import { buildRepoMap } from "./repomap/map.ts";
import { newRunId } from "./queue/execute.ts";
import { POSSESSION_DOCTRINE, possessionContext } from "./plugin/possess.ts";
import { binaryNameFor, doctrinePath, isAgentName, planLaunch, vendorArgs } from "./setup/launch.ts";
import { configDocument, describeSetup, describeSetupRemoval, planSetup, type DetectedAgent, type SetupRemoval } from "./setup/setup.ts";
import { shimDirectory, shimPath, shimText, profileFor, shellFrom, withBlock, withoutBlock } from "./setup/shim.ts";
import {
  admit,
  agentsOnPath,
  admissibleAfterDetection,
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

  brigadier setup [--dry-run] [--modify-path] [--home <path>] [--run-root <path>]
      Detect the fleet, write ~/.config/brigadier/config.json, write the plugin
      asset, install the launcher shim, and print what it found. Ruling 76: it
      never asks and it never runs work.
      --modify-path adds the shim's directory to your shell profile, between
                    \`# brigadier\` and \`# brigadier end\`. WITHOUT it brigadier
                    writes nothing outside its own root and prints the line for
                    you to add — which startup file is a guess, and a guess that
                    writes to a file your shell never sources reports success and
                    does nothing (ruling 77).
      Not required. \`run\` and \`plan\` still detect lazily on a machine that has
      never run this (ruling 71); what setup buys is possession.

  brigadier claude [args...]
      Start claude with brigadier on: its plugin loaded for that session only and
      the doctrine appended to — never replacing — the vendor's own system
      prompt (ruling 77). Any other vendor name launches that vendor untouched
      and says so, because possession is measured on Claude Code and nowhere
      else. Your arguments are passed through and win over brigadier's.

  brigadier run --goal "<sentence>" [--repo <path>] [--run-root <path>]
      Say what you want in English. brigadier commissions the plan from a
      workhorse, writes it to the run record, and prints ONE LINE naming the
      path -- never the plan itself, because your repository stays byte-identical
      and a session's window is not free (rulings 74 and 58).

  brigadier run --plan <path> [--repo <path>] [--run-root <path>]
      Run a plan: one isolated clone per item, one marked worker each, merged
      onto refs/heads/brigadier/<run-id> and gated on the merged result.
      --dry-run     admit the plan and stop. Nothing of the RUN is created. The
                    detection sweep admission depends on is answered from the
                    cache where it can be (ruling 71) and spawns the vendors it
                    cannot; the output says which happened.
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

  brigadier detect [--json] [--timeout <ms>] [--run-root <path>] [agent...]
      Probe which agents on this machine can actually be driven. Detection is
      two steps: a handshake proves an agent is present, a session proves it is
      usable. Both must pass.
      This command always probes and never answers from the cache, so it is also
      the repair for a wrong one (ruling 71): run it after an agent upgrade, or
      delete <run-root>/detect.json. --run-root only says which cache to write.

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
  // Resolved by `src/config/config.ts`, which owns the config-home rule for
  // BOTH files brigadier reads there. Two copies of this resolver is two places
  // for `XDG_CONFIG_HOME` to be handled differently, and an empty-but-set value
  // resolving relative to the working directory would put a file brigadier
  // trusts inside whatever repository it was invoked in — which ruling 37 is
  // precisely about.
  return bridgesPath();
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

/**
 * The one seam that reads and writes ruling 71's detection cache.
 *
 * Every caller says whether it may TRUST a stored result, and the answer is
 * ruling 63's rather than a timeout: *"a state file records intent and the world
 * records fact, and where the world can be consulted directly the world wins."*
 * A command about to spend can consult the world, so it does; a command that
 * answers a question and stops cannot without becoming the thing it is
 * predicting, so it may read what the last probe found — and says so.
 *
 * `trustCache` and `writeBack` are separate parameters and are the opposite of
 * each other at both call sites today. They stay separate because they answer
 * different questions with different authorities, and a later caller may well
 * want one without the other:
 *
 *   READING is ruling 63's call, above.
 *
 *   WRITING is ruling 71's own words — *"detection is lazy on first run and
 *   cached as state"* — plus ruling 53's ordering promise. `--dry-run`,
 *   `--estimate` and `plan` are not runs, and the checkable form of ruling 53 is
 *   that a refusal can be verified from the outside by listing the run root and
 *   finding it unchanged. A dry run that wrote a file into the run root would
 *   break that, and `test/cli-run.test.ts` asserts exactly it. So they read and
 *   never write; `run` and `detect` write.
 *
 *   WHAT THAT COSTS, stated: a machine where nobody ever gets past `plan` never
 *   warms the cache, and pays the sweep every time. The remedy is one command
 *   and it is printed rather than left to be discovered.
 *
 * `detect` is the command whose whole job is this question, so it is also the
 * repair: after an agent upgrade the operator runs the command they would have
 * run anyway, and the cache is correct again. `src/agent/detect-cache.ts`
 * carries the rest.
 *
 * A subset probe merges rather than replaces: `brigadier detect claude` must not
 * delete the five agents it never looked at.
 */
async function sweep(
  ids: AgentId[],
  options: { runRoot: string; timeoutMs: number; trustCache: boolean; writeBack: boolean },
): Promise<{ detections: Detection[]; cacheLine: string | null; probed: number; commit: () => void }> {
  const path = detectCachePath(options.runRoot);
  const artifact = artifactFingerprint();
  const fingerprints = fingerprintsNow(ids, OVERRIDES);
  const { file, problem } = readDetectCache(path);
  // A file that existed and could not be used is said out loud once. Never as
  // damage: ruling 71 makes deleting this file a supported repair, and a product
  // that calls its own repair a corruption has taught the operator not to do it.
  if (problem !== undefined) sink.errLine(problem);

  const read = planFromCache(ids, file, fingerprints, artifact, Date.now());
  const toProbe = options.trustCache ? read.stale.map((entry) => entry.id) : ids;
  const served = options.trustCache ? read.served : [];

  if (toProbe.length === 0) {
    return {
      detections: served,
      cacheLine: describeCacheUse(served, read.ageMs, 0, path),
      probed: 0,
      commit: () => {},
    };
  }

  const probes = await detectAll(toProbe, { timeoutMs: options.timeoutMs, overrides: OVERRIDES });
  // `Date.now()` HERE and not before the probe: the sweep is bounded at 20 s and
  // an age is the age of the measurement, not of the decision to take one.
  const probedAtMs = Date.now();

  // WRITING IS DEFERRED TO THE CALLER, and the reason is ruling 53's ordering
  // promise rather than tidiness. A `run` refused after this point — a ceiling
  // pair that can never act, an unresolvable verify command — must leave the run
  // root exactly as it found it, and `test/queue-ceiling.test.ts` checks that by
  // listing the directory and requiring it empty. That test went red on
  // 2026-08-20 against a version of this function that wrote here, which is the
  // whole reason the seam exists: a refusal that first creates something has
  // already done a smaller version of the thing it exists to prevent.
  const commit = options.writeBack
    ? (): void => {
        const written = writeDetectCache(sink, path, probes, fingerprints, artifact, probedAtMs, read.carried);
        // Never fatal. The cache is an optimisation; the sweep it would have
        // replaced has already run and its results are in hand.
        if (written.problem !== undefined) sink.errLine(written.problem);
      }
    : (): void => {};

  return {
    detections: [...served, ...probes],
    cacheLine: describeCacheUse(served, read.ageMs, probes.length, path),
    probed: probes.length,
    commit,
  };
}

/**
 * `brigadier claude [args…]` — launch a vendor with brigadier on.
 *
 * Ruling 75 and ruling 77. This is the half of possession that needs no install
 * into a directory another product owns: `--plugin-dir` loads brigadier's plugin
 * for that session only, and `--append-system-prompt-file` carries the doctrine
 * once rather than on every prompt.
 *
 * It **execs** rather than spawning a child and waiting. A vendor CLI is an
 * interactive program that owns the terminal, and putting brigadier in the
 * middle of that would mean proxying a pty — which is exactly the screen-scraping
 * the map lists under *Rejected tooling*, arrived at from the other direction.
 * Replacing the process leaves the vendor talking to the terminal directly, and
 * leaves nothing of ours in ruling 38's process tree.
 */
async function launchCommand(agent: AgentId): Promise<number> {
  const runRoot = absolute(value("run-root") ?? defaultRunRoot());
  const { home, env } = contextFrom(argv.slice(1));

  const binaryName = binaryNameFor(agent);
  const binary = Bun.which(binaryName);
  if (binary === null) {
    sink.errLine(`brigadier: ${binaryName} is not on PATH, so there is nothing to launch.`);
    sink.errLine("  `brigadier detect` reports which vendors are present and what each one's own remedy is.");
    return 4;
  }

  let enabled = true;
  try {
    enabled = loadConfig(configPath(env), { exists: existsSync, read: (path) => readFileSync(path, "utf8") })
      .config.possession.enabled;
  } catch (error) {
    // Unlike the hook, this path CAN refuse: a person typed this command and is
    // waiting, so a broken config is worth stopping for rather than silently
    // launching an unpossessed session they asked to be possessed.
    if (!(error instanceof ConfigUnusable)) throw error;
    sink.errLine(`refused — ${error.message}`);
    return 2;
  }

  const doctrine = doctrinePath(runRoot);
  // `setup` writes this. Re-writing it here means `brigadier claude` works on a
  // machine where setup has never run, which is ruling 71's lazy-first-contact
  // property applied to possession rather than to detection.
  if (!existsSync(doctrine)) sink.write(doctrine, `${POSSESSION_DOCTRINE}\n`);

  const plan = planLaunch({
    agent,
    userArgs: vendorArgs(argv.slice(1)),
    binary,
    pluginDirectory: join(home, ".claude", "skills", "brigadier"),
    doctrine,
    enabled,
  });
  if (plan.notice !== undefined) sink.errLine(plan.notice);
  sink.end();

  // Replace this process. Bun has no `execve`, so the closest honest thing is to
  // run the child attached to our own stdio and exit with its status — the
  // terminal is the child's for the whole of its life either way.
  const child = Bun.spawn([plan.command, ...plan.args], { stdio: ["inherit", "inherit", "inherit"] });
  return await child.exited;
}

/**
 * `brigadier hook <event>` — what a registered hook actually runs.
 *
 * Ruling 75. This is the possession channel on Claude Code, and everything about
 * it is shaped by one fact: **it runs on every prompt, forever.** Whatever it
 * prints is paid for again on every turn of a conversation that may last hours,
 * so it prints one byte-stable line or nothing at all.
 *
 * It CANNOT fail loudly and must never block a prompt. The registered command is
 * `brigadier hook user-prompt-submit 2>/dev/null || true`, so a machine where
 * `brigadier` is not on `PATH` — which is the default until `setup --modify-path`
 * or a hand-added line, ruling 77 — degrades to no possession rather than to a
 * session that cannot accept input. A hook that can wedge every prompt in a
 * vendor's product is the single worst thing this repository could ship into a
 * directory it owns, and ruling 8's whole point is that we are a guest here.
 */
function hookCommand(): number {
  const event = argv[1];
  if (event !== "user-prompt-submit") {
    sink.errLine(`unknown hook event: ${event ?? "(none)"}\n`);
    sink.errLine("  brigadier hook user-prompt-submit");
    return 2;
  }

  // Ruling 36 and ruling 57. A worker gets NOTHING — not a shorter line, not an
  // explanation. v1's finding 114 is a worker that ran the orchestrator instead
  // of working, and it reproduced unprovoked in #14; a possession hook is that
  // route with a louder voice.
  const insideWorker = isInsideWorker();

  // The toggle. A malformed config must not wedge a prompt either, so this is
  // the one place in the product where an unusable config falls back instead of
  // refusing — and the fallback is SILENCE, which is the safe direction.
  let enabled = true;
  try {
    enabled = loadConfig(configPath(), { exists: existsSync, read: (path) => readFileSync(path, "utf8") })
      .config.possession.enabled;
  } catch {
    enabled = false;
  }

  const context = possessionContext({ insideWorker, enabled });
  // Nothing at all, not an empty line: Claude Code adds stdout as context and a
  // blank line is still a byte in a window somebody is paying for.
  if (context.length > 0) sink.outLine(context);
  return 0;
}

/**
 * `brigadier setup` — ruling 76's non-interactive door.
 *
 * The order is deliberate and it is the order of what can still refuse:
 * detect, plan, then write. Nothing is created until every input is known, so a
 * machine where detection finds nothing gets a printed remedy rather than a
 * half-installed product — ruling 53's *find out before you spend*, which this
 * repository has now applied at four different layers.
 *
 * It never asks and it never runs work. That cap is ruling 76 itself.
 */
/**
 * `brigadier uninstall` — the plugin asset, and everything `setup` added.
 *
 * Ruling 26's *"uninstall is deleting the directory"* survived only while
 * nothing was installed. Ruling 77 changed that, so this removes what setup
 * writes and — crucially — **reports the shell-profile block separately**,
 * because it is the one byte brigadier ever writes outside its own root and a
 * summary that quietly covers it is how a promise becomes a lie.
 */
function uninstallEverything(): number {
  const code = uninstallCommand(argv.slice(1));
  if (code !== 0) return code;

  const { home, env } = contextFrom(argv.slice(1));
  const runRoot = absolute(value("run-root") ?? defaultRunRoot());
  const shim = shimPath(runRoot);
  const shimExisted = existsSync(shim);
  if (shimExisted) rmSync(shim, { force: true });

  const profile = profileFor(shellFrom(env), home);
  let block: SetupRemoval["block"] = "absent";
  if (profile !== undefined && existsSync(profile)) {
    const result = withoutBlock(readFileSync(profile, "utf8"));
    if (result === "unpaired") {
      // Refused rather than guessed: a start marker with no end marker means
      // somebody edited inside the block, and deleting to end-of-file on that
      // assumption is the one failure ruling 51 keeps structurally impossible.
      block = "unpaired";
    } else if (result !== undefined) {
      sink.write(profile, result);
      block = "removed";
    }
  }

  const removal: SetupRemoval = {
    shimPath: shim,
    shimExisted,
    ...(profile === undefined ? {} : { profile }),
    block,
  };
  sink.outLine("");
  for (const line of describeSetupRemoval(removal)) sink.outLine(line);
  // An unpaired marker is a thing the operator must finish by hand, and a
  // zero exit would say it was done.
  return block === "unpaired" ? 1 : 0;
}

async function setupCommand(): Promise<number> {
  // Ruling 57's refusal, pointed the second way. `install` already refuses
  // inside a worker because a worker writing brigadier's skill into the
  // operator's home changes their machine without being asked; `setup` writes
  // strictly more than `install` does, so it refuses for strictly more reason.
  if (isInsideWorker()) {
    sink.errLine("brigadier refused to set up: this session IS a brigadier worker.\n");
    sink.errLine("  Setup changes the operator's machine. Do the work you were given, and say in your");
    sink.errLine("  result that setup should be run if it should.");
    return 3;
  }

  const dryRun = flag("dry-run");
  const modifyPath = flag("modify-path");
  const { home, env } = contextFrom(argv.slice(1));
  const runRoot = absolute(value("run-root") ?? defaultRunRoot());

  const { detections, commit } = await sweep(ALL_AGENT_IDS as AgentId[], {
    runRoot,
    timeoutMs: Number(value("timeout") ?? 60_000),
    // Setup is the machine's first honest look at itself. A stored answer here
    // would be a setup that reports a fleet it did not check — and ruling 73
    // made "always probes, never answers from the cache" the property that
    // makes a command a repair.
    trustCache: false,
    writeBack: !dryRun,
  });
  if (!dryRun) commit();

  const detected: DetectedAgent[] = detections
    .map((d) => ({ id: d.id, usable: d.availability === "usable" }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const configFile = configPath(env);
  const plan = planSetup({
    configPath: configFile,
    configExists: existsSync(configFile),
    root: runRoot,
    binary: process.execPath,
    // A compiled artifact carries a build stamp; an interpreter does not. That
    // is the only honest way to ask "is `process.execPath` brigadier", and
    // without it `bun run src/cli.ts setup` writes a shim pointing at bun.
    binaryIsArtifact: embeddedStamp().stamp !== null,
    home,
    env,
    detected,
  });

  let modifiedProfile: string | undefined;
  if (!dryRun) {
    // Through the sink, not `writeFileSync`. Ruling 65 puts redaction at
    // exactly one place, and `Sink.write` additionally refuses to write through
    // a symlink or a hard link at the destination — which these paths need,
    // because they sit beside directories an agent can reach.
    if (plan.writeConfig) sink.write(configFile, configDocument(plan.config));
    const asset = install(env, home);
    if (asset.refusal !== undefined) {
      sink.errLine(asset.refusal);
      return 1;
    }
    if (plan.binaryIsArtifact) {
      const shim = shimPath(runRoot);
      sink.write(shim, shimText(process.execPath));
      // The long form the shim appends to a session's system prompt, once per
      // session. It lives under ruling 61's root beside the shim rather than in
      // a temp directory, for ruling 61's own measured reason.
      sink.write(doctrinePath(runRoot), `${POSSESSION_DOCTRINE}\n`);
      // 0o755, and only where a mode means anything. A shim nobody can execute
      // is the same failure as a shim nobody can find, one step later.
      if (process.platform !== "win32") chmodSync(shim, 0o755);
    }

    if (modifyPath && !plan.alreadyOnPath && plan.binaryIsArtifact) {
      // Ruling 77: the flag IS the authorisation. This is the only byte
      // brigadier ever writes outside its own root, and it goes between markers
      // so `uninstall` can remove exactly it.
      const profile = profileFor(shellFrom(env), home);
      if (profile === undefined) {
        sink.errLine(
          "--modify-path was passed but $SHELL names no shell brigadier knows how to edit for. " +
            "The line is printed below; nothing was written.",
        );
      } else {
        const existing = existsSync(profile) ? readFileSync(profile, "utf8") : "";
        const updated = withBlock(existing, shimDirectory(runRoot), shellFrom(env));
        try {
          if (updated !== undefined) sink.write(profile, updated);
          modifiedProfile = profile;
        } catch (error) {
          // `Sink.write` refuses to write through a symlink, and a symlinked
          // `.zshrc` is ordinary — it is what every dotfiles repository does.
          // Following the link would write into a git repository the operator
          // did not name, so the refusal is right and the remedy is to say so.
          sink.errLine(
            `--modify-path could not write ${profile} — ${error instanceof Error ? error.message : String(error)}`,
          );
          sink.errLine(
            "  If that path is a symlink into a dotfiles repository, brigadier will not write through it.",
          );
          sink.errLine("  Add the line below by hand. Nothing was changed.");
        }
      }
    }
  }

  for (const line of describeSetup(plan, detected, modifiedProfile, dryRun)) sink.outLine(line);
  // Ruling 71: nothing detected exits non-zero. A setup that reports success on
  // a machine with no drivable vendor has told the operator the product is
  // ready when it cannot run anything.
  return detected.some((agent) => agent.usable) ? 0 : 1;
}

async function detect(): Promise<number> {
  const requested = argv.slice(1).filter((a) => !a.startsWith("--") && ALL_AGENT_IDS.includes(a as AgentId));
  const ids = (requested.length > 0 ? requested : ALL_AGENT_IDS) as AgentId[];
  const timeout = Number(value("timeout") ?? 60_000);

  // `--run-root` for the same reason `run` has one: the cache lives under that
  // root, so a machine whose runs go somewhere else must be repairable there
  // too. Without it `detect` would refresh a cache no run reads.
  const { detections: results, commit } = await sweep(ids, {
    runRoot: absolute(value("run-root") ?? defaultRunRoot()),
    timeoutMs: timeout,
    // Always. This command exists to answer the question the cache stores, and
    // a `detect` that printed a stored answer would be unable to repair one.
    trustCache: false,
    writeBack: true,
  });
  // Immediately: this command has nothing left that could refuse, and recording
  // what it measured IS what it is for.
  commit();
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
    // The marker CONTRACT, printed so that the release bar can check the
    // artifact's own declaration against the vendor's real behaviour rather
    // than against a constant copied into the harness. Item 1 already reads
    // `measured` from here for exactly that reason; finding V2 is what happens
    // when a contract has no such leg — every direct profile was unstartable
    // and the only thing that knew the argv was the code that got it wrong.
    sink.outLine(`  marker     ${describeMarker(profile)}`);
    sink.outLine(`  configroot ${profile.configRootEnv ?? "none measured"}`);
    sink.outLine(`  measured   ${profile.measuredVersion}`);
    sink.outLine(`  lane       ${describeLane(profile.laneAssertion)}`);
    sink.outLine(`  usage      ${profile.emitsUsage ? "emits usage_update" : "none over ACP"}`);
    for (const caveat of profile.caveats) sink.outLine(`  ! ${caveat}`);
    sink.outLine("");
  }
  return 0;
}

/**
 * Ruling 38's marker placement, rendered as the exact argv tail it produces.
 *
 * The tail rather than the word, because `after-terminator` and `flag-value`
 * mean nothing to a reader checking whether their vendor will start, and the
 * release bar needs something it can splice onto `command` and run.
 */
function describeMarker(profile: (typeof PROFILES)[AgentId]): string {
  const placement = profile.markerPlacement;
  switch (placement.kind) {
    case "append":
      return "<marker>";
    case "after-terminator":
      return "-- <marker>";
    case "flag-value":
      return `${placement.flag} <marker>`;
  }
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
 * Everything up to `executeRun` is computed from the plan text, `PATH`, this
 * machine's memory — and, since 2026-08-20, a detection sweep. Nothing before
 * that line creates anything IN THE RUN ROOT or writes a ref, which is what lets
 * a refusal be checked from the outside by listing the run root and finding it
 * unchanged. Ruling 53 asks for exactly that and names the alternative: a
 * refusal that first creates the thing it is refusing has already done the thing
 * it exists to prevent.
 *
 * CORRECTED, because this paragraph used to say "starts a process" and that is
 * now false. Finding V1 is that `run` admitted on a `PATH` hit alone and failed
 * at the first prompt, so admission consults `detectAll`, and detection spawns
 * each vendor and opens a session with it. Two consequences, stated rather than
 * left to be found:
 *
 *   `--dry-run` and `--estimate` now spawn short-lived vendor probes. They still
 *   answer their own questions honestly and still create nothing in the run
 *   root; what changed is that "nothing was started" in their output means
 *   nothing of the RUN was started, not that no process ran. A dry run that
 *   skipped detection would answer "would this run?" from the same incomplete
 *   information that produced V1, which is a worse trade.
 *
 *   The probes cost no vendor money — `initialize` and `session/new`, never a
 *   prompt — but they are not free in time, and ruling 71 already accepted that
 *   shape while bounding it by the slowest agent rather than their sum.
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
/**
 * Turn a goal into a plan file, or an exit code explaining why not.
 *
 * Ruling 74's D2 — *"brigadier drives a planner"* — and D4: **the plan is always
 * a file and the session gets one line naming it, never the plan inline.** Bar
 * item 4 already asserts the operator's repository is byte-identical after a
 * run, so a plan written into their tree would fail an existing item.
 *
 * D3 is honoured by NOT forcing this: `--plan` still exists, and a goal that
 * `looksTrivial` says so rather than silently paying for a planning turn. That
 * heuristic only ever advises — D3's *"asks the user anyway"* needs the
 * exit-and-resume channel of ruling 75, which is Track A step 6, so today it
 * prints and proceeds.
 */
async function commission(
  goal: string,
  repo: string,
  runRoot: string,
  runId: string,
): Promise<string | number> {
  const detection = await sweep(ALL_AGENT_IDS as AgentId[], {
    runRoot,
    timeoutMs: Number(value("timeout") ?? 60_000),
    trustCache: true,
    writeBack: true,
  });
  detection.commit();
  const usable = detection.detections
    .filter((d) => d.availability === "usable")
    .map((d) => d.id)
    .sort();

  // One load, two answers: who plans (ruling 71's written proposal) and whether
  // ambient instructions are suppressed (decision 17's override). A second load
  // would be a second chance for the two to disagree.
  let configured: readonly string[] | undefined;
  let suppressAmbient = true;
  try {
    const loaded = loadConfig(configPath(), { exists: existsSync, read: (p) => readFileSync(p, "utf8") });
    configured = loaded.config.roles.builder;
    suppressAmbient = loaded.config.ambientSuppression;
  } catch {
    configured = undefined;
  }

  const planner = choosePlanner(usable, configured);
  if (planner === undefined) {
    sink.errLine("brigadier: no vendor is drivable, so there is nobody to plan with.");
    sink.errLine("  `brigadier detect` prints each vendor's own remedy — those words are theirs, not ours.");
    return 4;
  }

  // D24's line form: one line, naming a fact. Not a spinner and not a paragraph.
  sink.outLine(`brigadier: planning → ${planner}`);
  if (looksTrivial(goal)) {
    // D3. Printed rather than acted on: whether this goal needs a plan is the
    // operator's call, and brigadier cannot ask them until step 6 exists.
    sink.outLine("brigadier: this goal looks like one edit — `--plan` skips the planning turn next time");
  }

  const planDir = join(runRoot, "r", runId);
  mkdirSync(planDir, { recursive: true });
  // Ruling 50: the scratch index must be OUTSIDE the operator's repository, or
  // `git add -A` sweeps it into the base commit as an untracked file.
  const base = await buildBaseState({ repo, runId: `${runId}p`, scratchDir: planDir });
  let repoMap = "";
  try {
    repoMap = (await buildRepoMap(repo)).text;
  } catch {
    // Ruling 39 calls the map "a cheap lottery ticket with a large payout": a
    // miss costs only its own ~1,003 tokens. A planner without one is a planner
    // with its own tools, so this is degraded rather than fatal.
    repoMap = "";
  }

  const planFile = join(planDir, "plan.json");
  try {
    const commissioned = await commissionPlan({
      agent: planner,
      goal,
      repoMap,
      repoName: repo.split("/").pop() ?? repo,
      base,
      runRoot,
      // Its own id — see `commission.ts`. `p` suffixed so a sweep reading a
      // directory name can tell a planning clone from the run it planned.
      planRunId: `${runId}p`,
      timeoutMs: Number(value("timeout") ?? 300_000),
      suppressAmbient,
    });
    sink.write(planFile, `${commissioned.planJson}\n`);
    // D4, and it is the whole product surface of a plan: a PATH, never the plan.
    sink.outLine(`brigadier: plan ready → ${planFile}`);
    return planFile;
  } catch (error) {
    if (error instanceof PlannerRefused) {
      // Ruling 52's `error`, not `fail`: the planner was never allowed to
      // answer, so sending anyone to look at the plan would be sending them to
      // the wrong place.
      sink.errLine(`brigadier: ${error.message}`);
      if (error.suppressAmbient) {
        sink.errLine(
          "  brigadier redirected that vendor's config root to suppress your global instruction files",
        );
        sink.errLine(
          "  (decision 17), and on some vendors that is also where the credential lives — MEASURED on",
        );
        sink.errLine(
          "  Codex and Qwen at session/new, and on the Claude bridge at session/prompt, which is the",
        );
        sink.errLine("  metered call.");
        sink.errLine(
          '  Remedy: set `"ambientSuppression": false` in ~/.config/brigadier/config.json. Your global',
        );
        sink.errLine(
          "  instruction files will then be visible to workers, and every run says so out loud.",
        );
        sink.errLine(
          "  brigadier will NOT copy your credential into a run directory to avoid this: that is a",
        );
        sink.errLine("  decision about a credential boundary and it is the owner's, not this command's.");
      } else {
        sink.errLine(`  \`brigadier detect\` reports ${error.agent}'s own remedy text, which is theirs and not ours.`);
      }
      return 4;
    }
    if (error instanceof PlannerUnusable) {
      sink.errLine(`brigadier: ${error.message}`);
      // The raw text, because "it did not return JSON" without showing what it
      // DID return leaves an operator with nothing to act on. Bounded, because
      // ruling 58 caps what reaches a host session.
      sink.errLine(`  it said: ${error.received.slice(0, 400).replace(/\n/g, " ")}`);
      return 5;
    }
    throw error;
  }
}

async function run(): Promise<number> {
  const goal = value("goal");
  let planPath = value("plan");

  // Ruling 74's entry point. `--plan` is NOT deprecated by it: an operator who
  // already knows the plan should not pay for a planning turn to be told it, and
  // ruling 74 keeps that path as the show-me-first one.
  if (goal !== undefined && planPath !== undefined) {
    sink.errLine("--goal and --plan are two ways to say the same thing, and they disagree.");
    sink.errLine("  --goal <sentence>  brigadier commissions the plan (ruling 74).");
    sink.errLine("  --plan <path>      you wrote it. Nothing is commissioned.");
    return 2;
  }
  if (goal !== undefined && goal.trim().length === 0) {
    sink.errLine("--goal needs a sentence. An empty goal is not a goal.");
    return 2;
  }
  if (goal === undefined && planPath === undefined) {
    sink.errLine("brigadier run --goal \"<sentence>\" | --plan <path> [--repo <path>] [--run-root <path>]\n");
    sink.errLine(USAGE);
    return 2;
  }

  // Ruling 18's per-machine layer, read BEFORE any flag is interpreted, because
  // the file can set the same things the flags can and the precedence has to be
  // applied in one place. Refused here — with the other input checks, before a
  // plan is read, before a clone and before a directory exists to hold one.
  let settings;
  try {
    settings = loadConfig(configPath(), { exists: existsSync, read: (path) => readFileSync(path, "utf8") });
  } catch (error) {
    if (!(error instanceof ConfigUnusable)) throw error;
    sink.errLine(`refused — ${error.message}`);
    sink.errLine("  Nothing was spawned and nothing was cloned. Fix the file or delete it.");
    return 2;
  }
  // An unknown key is a typo the operator cannot see in their own file, and a
  // setting they believe is in force. Ruling 60 measured both silent
  // directions shipping in real manifests; this is the loud one.
  for (const warning of settings.warnings) sink.errLine(warning);

  const repo = absolute(value("repo") ?? process.cwd());
  const runRoot = absolute(prefer(value("run-root"), settings.config.runRoot, defaultRunRoot()));
  const audience = audienceFrom(value("audience"));
  const ceiling = difficultyFrom(value("max-difficulty"));
  if (ceiling === null) {
    sink.errLine(`--max-difficulty must be one of easy, medium, hard`);
    return 2;
  }

  // Refused HERE — with the other flag checks, before a plan is read, before a
  // clone and before a directory exists to hold one.
  //
  // `Number("abc")` is `NaN`, and ruling 14's arithmetic is a `Math.min` chain,
  // so an unparseable budget used to reach `planFanOut` and come back out as a
  // `NaN` worker count: printed as `NaN worker(s) in wave 1`, then handed to the
  // batch cursor in `src/queue/execute.ts`, where the loop dispatched ZERO items
  // and exited reporting success. A fraction is no better — the cursor steps by
  // the width, so 2.5 slices batches at fractional indices. MEASURED against
  // `bun 1.3.14` on 2026-08-20 by another builder driving the real module:
  // `--workers abc` gave `workers: NaN`, printed `NaN worker(s) in wave 1 — RAM
  // capped it…` and dispatched nothing; `--workers 2.5` printed `2.5 worker(s)`.
  // A run that does nothing and reports success for it is the failure `BAR.md`
  // opens on, and an ordinary typo was enough to reach it.
  //
  // `planFanOut` now throws a `RangeError` on the same inputs and `dispatchWidth`
  // cannot return a non-integer, but those are BACKSTOPS: an exception naming an
  // internal field is not a usage message, and the operator's half of the fix
  // belongs where the flag still has its name and the text they typed. Exit 2 is
  // this file's usage code — the same one a missing `--plan`, an unusable
  // `--max-difficulty` and an unknown command get.
  // A flag beats the file beats the default (ruling 18). The file's own value
  // was already validated by the same rule when it was parsed, so only the flag
  // can still be the string a person typed.
  const workers = value("workers");
  const workerBudget = workers === undefined ? settings.config.workers : Number(workers);
  if (workerBudget !== undefined && (!Number.isInteger(workerBudget) || workerBudget < 1)) {
    sink.errLine(
      `--workers must be a whole number of at least 1, and it was \`${workers}\`. ` +
        "Nothing was spawned and nothing was cloned.",
    );
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

  // Ruling 74: the goal becomes a plan file BEFORE anything else happens, and
  // from that line on this function cannot tell the difference between a plan
  // brigadier commissioned and one the operator wrote. That is the whole reason
  // the overturn is cheap — one entry point, one validator, one refusal path.
  const runId = newRunId();
  if (goal !== undefined) {
    const commissioned = await commission(goal, repo, runRoot, runId);
    if (typeof commissioned === "number") return commissioned;
    planPath = commissioned;
  }
  if (planPath === undefined) return 2;

  let spec;
  try {
    spec = parsePlan(readFileSync(planPath, "utf8"), planPath);
  } catch (error) {
    sink.errLine(error instanceof PlanUnreadable ? error.message : `could not read ${planPath}: ${String(error)}`);
    return 2;
  }

  // Ruling 69: the same override the table describes is the one that resolves.
  const resolved = agentsOnPath((command) => Bun.which(command), OVERRIDES);

  // FINDING V1. `run` used to admit on this list alone, and a `PATH` hit is
  // ruling 41's *present* rather than *usable*. Detection is the second step.
  //
  // The plan is validated TWICE, and that is deliberate rather than sloppy.
  // Ruling 69's gate is per work KIND — a blocking drift stops write work and
  // not read-only work — so the kinds have to be known before the fleet can be
  // filtered. `PlanSpec.items` is typed `unknown` on purpose, and reaching into
  // it to read `kind` would be trusting a file this module has not validated.
  // `validatePlan` is pure by this module's own contract (it starts no process,
  // creates no directory, writes no ref), so running it against the unfiltered
  // fleet first costs nothing and answers the question honestly.
  const provisional = validatePlan(spec, {
    cwd: repo,
    agents: resolved,
    ...(ceiling === undefined ? {} : { ceiling }),
  });
  // A plan that is refused outright is refused before detection spends anything
  // — ruling 53's "find out before you spend" is a promise about order.
  if (provisional.refusals.length > 0) {
    for (const line of describeRefusals(provisional.refusals, planPath)) sink.errLine(line);
    return 4;
  }
  const hasWriteWork = provisional.items.some((item) => item.kind === "write");

  // BOUNDED, and lower than `detectOne`'s own 60 s default on purpose. This
  // sweep now stands in front of every `run`, `plan` and `--dry-run`, so its
  // worst case is the worst case of asking brigadier a question. At the default
  // an unreachable vendor could make `--dry-run` sit for a minute before saying
  // anything, which is a bad answer to "would this run?".
  //
  // A vendor slower than this is reported `absent` with the timeout as its
  // remedy, which is honest — brigadier could not drive it within the time it is
  // willing to wait — and the operator can run `brigadier detect --timeout` to
  // get the unhurried answer.
  //
  // A CACHE DOES NOT REMOVE THE NEED FOR THIS BOUND. Ruling 71's cache landed on
  // 2026-08-20 and it makes the sweep rare, not cheap: a cold cache, a vendor
  // that upgraded, a replaced bridge or a new brigadier all put a real probe
  // back in front of this line. What the bound governs is the worst case, and
  // the worst case is unchanged.
  const ADMISSION_DETECT_TIMEOUT_MS = 20_000;
  // Ruling 71's cache, and ruling 63 deciding who may trust it. `--dry-run`,
  // `--estimate` and the `plan` verb spend nothing and create nothing, so they
  // may answer from the last probe and disclose that they did. A real run is
  // about to clone, spawn and spend: it can consult the world, so it does.
  // Finding V1 is `run` admitting on evidence that was not the evidence, and
  // ruling 69's blocking drift gate — the one that stops write work — is
  // therefore never decided from a stored version string. That matters most for
  // Claude and Codex, whose bridges upgrade under an unchanged `npx`.
  const stops = flag("dry-run") || flag("estimate");
  const { detections: probes, cacheLine, probed, commit: commitDetection } = await sweep(
    resolved.map((agent) => agent.id),
    { runRoot, timeoutMs: ADMISSION_DETECT_TIMEOUT_MS, trustCache: stops, writeBack: !stops },
  );
  // On stdout, beside the admission it qualifies, rather than on stderr where a
  // host-first caller reading the report would not see what the report was
  // computed from.
  if (cacheLine !== null) sink.outLine(cacheLine);
  // What detection actually DID on THIS invocation, in words that are true of
  // it. Until the cache landed, `--dry-run` and `--estimate` could say "each
  // resolved vendor was spawned" as a constant; a cache makes that a claim about
  // one run, and ruling 62 (f) makes a sentence that contradicts what happened a
  // `fail` rather than a wording preference.
  const detectionDid = (probed === 0
    ? "  No vendor was spawned: admission was answered from the detection cache (ruling 71).\n"
    : `  Detection did spawn ${probed} resolved vendor(s) to open a session — that is how admission knows\n` +
      "  which of them could have taken work.\n" +
      // Only where it is true and actionable. A run writes the cache itself, so
      // saying this there would be advice to do what just happened.
      (stops
        ? "  That sweep was not cached: this command creates nothing in the run root, the cache included\n" +
          "  (ruling 53). `brigadier detect` writes it, and the next admission answers from it.\n"
        : "")) +
    // True on both branches and the half that matters most, so it is said on
    // both rather than living inside one of them.
    "  No prompt was sent and no vendor money was spent.";
  const { admitted: agents, rejected } = admissibleAfterDetection(resolved, probes, {
    hasWriteWork,
    // Ruling 69's Q3: the operator replaced this bridge on purpose and
    // `overrideWarning` has already said what that costs. Blocking it here for
    // drifting from a version it was never going to match would make the remedy
    // useless.
    overridden: new Set(OVERRIDES.map((o) => o.agent)),
  });
  for (const rejection of rejected) {
    sink.errLine(
      `${rejection.id}: resolved on PATH but not admitted — ${rejection.because}.\n  ${rejection.detail}`,
    );
  }
  if (agents.length === 0) {
    sink.errLine(
      "refused — no agent on this machine completed a session, and nothing was started.\n" +
        "  Ruling 41: a completed handshake means present, not usable. The remedies above are the\n" +
        "  vendors' own words; `brigadier detect` prints them without starting a run.",
    );
    return 4;
  }

  const plan = validatePlan(spec, {
    cwd: repo,
    agents,
    ...(ceiling === undefined ? {} : { ceiling }),
  });
  const admission = admit({
    plan,
    agents,
    // Decision 25: the product is host-first, so brigadier normally runs inside
    // a host agent's session and that agent gets a worker's RAM budget.
    hostFirst: audience === "host-session",
    // Ruling 32's reviewer is decided at admission and printed there, so the run
    // cannot report a different answer from the one the operator was shown.
    review: flag("review"),
    // Already validated at the top of this function: a whole number ≥ 1, or absent.
    ...(workerBudget === undefined ? {} : { desirabilityCap: workerBudget }),
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
    sink.outLine(
      `nothing of this run was started: --estimate stops before the run root is created.\n${detectionDid}`,
    );
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
    sink.outLine(
      `nothing of this run was started: --dry-run stops before the run root is created.\n${detectionDid}`,
    );
    return 0;
  }

  // The merged-result gate's command. Resolved HERE, before a worker exists.
  const verify = resolveVerify(value("verify"), repo);
  if (verify.status === "missing") {
    sink.errLine(verify.refusal ?? "the verify command could not be resolved");
    return 4;
  }

  mkdirSync(runRoot, { recursive: true });
  // HERE, and not at the sweep. Ruling 71 caches detection on a first RUN, and
  // this is the line where this invocation stops being a question and becomes
  // one: every refusal is behind it and the run root is being created anyway.
  // A run refused above leaves the run root as it found it, which is the only
  // form of ruling 53's ordering promise anyone outside the process can check.
  commitDetection();
  const result = await executeRun({
    repo,
    runRoot: realpathSync(runRoot),
    planPath,
    // Shared deliberately: D4 puts the plan file inside the run record, so the
    // id has to exist before the planner runs rather than being minted by the
    // run it plans.
    runId,
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

  // A vendor's name is a launch, not a subcommand: `brigadier claude` starts
  // claude with brigadier on (ruling 77). Checked before the switch so a future
  // subcommand can never silently shadow a vendor name — and if one ever needs
  // to, that collision is a decision rather than an accident.
  if (isAgentName(command) && command !== undefined) return await launchCommand(command);

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
    case "hook":
      return hookCommand();
    case "setup":
      return await setupCommand();
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
      return uninstallEverything();
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
