// SPDX-License-Identifier: Apache-2.0
/**
 * The commands that put the asset on disk, take it off again, and say what the
 * hook surface really is.
 *
 * This module is the whole of `brigadier install`, `brigadier uninstall` and
 * `brigadier plugin hooks`. `src/cli.ts` needs three `case` labels and one
 * import; everything a reader has to believe lives here, beside the
 * measurements it rests on.
 *
 * One refusal is enforced here rather than in the dispatcher, and it is
 * deliberate. Ruling 57 makes `run` and `plan` refuse inside a worker, because
 * v1's finding 114 is a worker that orchestrated instead of working. `install`
 * is the SECOND of finding 114's three routes — the installed plugin — pointed
 * the other way: a worker that writes brigadier's skill into the operator's home
 * has changed the operator's machine without the operator asking. So `install`
 * and `uninstall` refuse inside a worker too, while `plugin hooks` stays
 * available, because reading a file cannot cause either failure and a refusal
 * that looks arbitrary teaches a model nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { isInsideWorker } from "../agent/marker.ts";
import { HOOKS_TEXT, PLUGIN_NAME } from "./asset.ts";
import { describeFinding, hooksCandidates, inspectHooks, judgeHooks } from "./check.ts";
import {
  describeInstall,
  describeUninstall,
  install,
  INSTALL_ROOTS,
  planInstall,
  plannedBinPaths,
  resolveHome,
  rootDirectory,
  uninstall,
  type InstallResult,
} from "./install.ts";
import {
  FLOOR_HOOK_EVENTS,
  HOOK_FLOOR_CLAUDE_VERSION,
  KNOWN_EVENTS_CLAUDE_VERSION,
  KNOWN_HOOK_EVENTS,
  REGISTERED_HOOK_EVENTS,
} from "./hooks.ts";

export const PLUGIN_USAGE = `brigadier install [--dry-run] [--home <path>]
      Write brigadier's skill into the two user-global directories it owns:
      ~/.agents/skills/${PLUGIN_NAME}/ (cross-vendor) and ~/.claude/skills/${PLUGIN_NAME}/.
      Nothing else on the machine is touched, and no \`bin/\` is created anywhere.

  brigadier uninstall [--home <path>]
      Delete those two directories. That is the whole of it: nothing was
      registered anywhere else, so there is nothing else to undo.

  brigadier plugin hooks [--check] [--host] [--home <path>]
      The hook surface, by NAME. --check reads every hooks.json brigadier knows
      about and reports an unrecognised event or malformed JSON — both of which
      silently discard every hook in the file. --host also asks \`claude\` itself.
`;

const WORKER_INSTALL_REFUSAL = `brigadier refused to install: this session IS a brigadier worker.

  A worker writing brigadier's skill into the operator's home changes the operator's
  machine without the operator asking, and the installed plugin is the second of the
  three routes by which a worker talks itself into orchestrating instead of working.

  Do the work you were given. If the skill should be installed, say so in your result
  and let the operator run \`brigadier install\` themselves.
`;

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/**
 * A flag's value, refusing to swallow the next flag as one.
 *
 * `--home --dry-run` must not resolve a home directory called `--dry-run` and
 * then create it. The value is a path here, so the mistake would be silent and
 * would leave real directories behind in the working directory — the one class
 * of bug this whole module is supposed to be incapable of.
 */
function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = argv[index + 1];
  return next === undefined || next.startsWith("--") ? undefined : next;
}

export interface CommandContext {
  readonly home: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * `--home` exists for one reason and it is not convenience.
 *
 * Every assertion about this feature is an assertion about paths under a home
 * directory, and a check that has to mutate the operator's real one to run is a
 * check nobody runs twice. `bar/items/10-the-artifact-ships.ts` drives it
 * through the environment instead; both routes land here.
 *
 * An explicit `--home` also CLEARS `CLAUDE_CONFIG_DIR`. Without that, naming a
 * home and then writing outside it would be the behaviour — Claude Code's own
 * lever points wherever it points — and "install everything under this
 * directory" that quietly does not is worse than no flag at all.
 */
export function contextFrom(argv: readonly string[]): CommandContext {
  const explicit = option(argv, "home");
  if (explicit === undefined) return { home: resolveHome(), env: process.env };
  const env: Record<string, string | undefined> = { ...process.env, HOME: explicit };
  delete env["CLAUDE_CONFIG_DIR"];
  delete env["USERPROFILE"];
  return { home: explicit, env };
}

export function installCommand(argv: readonly string[]): number {
  if (isInsideWorker()) {
    console.error(WORKER_INSTALL_REFUSAL);
    return 3;
  }
  const { home, env } = contextFrom(argv);
  const dryRun = flag(argv, "dry-run");
  const planned = planInstall(env, home);
  // The `bin/` guard runs on the PLAN, so `--dry-run` reaches the same verdict
  // as the real thing rather than being a second, weaker code path.
  const offending = plannedBinPaths(planned);
  const result: InstallResult = dryRun
    ? {
        written: [],
        directories: [],
        refusal:
          offending.length > 0
            ? `refused — the asset would write ${offending.join(", ")}, and ruling 42 measured that no ` +
              "`bin/`-on-PATH equivalent exists outside Claude Code. Nothing was written."
            : undefined,
      }
    : install(env, home);
  for (const line of describeInstall(result, planned, dryRun)) console.log(line);
  return result.refusal === undefined ? 0 : 1;
}

export function uninstallCommand(argv: readonly string[]): number {
  if (isInsideWorker()) {
    console.error(WORKER_INSTALL_REFUSAL);
    return 3;
  }
  const { home, env } = contextFrom(argv);
  const removed = uninstall(env, home);
  for (const line of describeUninstall(removed)) console.log(line);
  return 0;
}

/**
 * The hook surface printed as NAMES.
 *
 * Ruling 60's core instruction, and the reason there is no count anywhere in
 * this output: `.lsp.json` was measured reporting `LSP servers (1)` for
 * `{"notARealKey": 1}`, so a count that looks healthy is not evidence that
 * anything loaded.
 */
export function hooksSurface(): string[] {
  return [
    `brigadier registers ${REGISTERED_HOOK_EVENTS.length} hook event, by name:`,
    "",
    ...REGISTERED_HOOK_EVENTS.map((event) => `  ${event}`),
    "",
    `  file       hooks/hooks.json, inside ~/.claude/skills/${PLUGIN_NAME}/ — a directory brigadier owns.`,
    "  elsewhere  no hook is registered, and none can be. The trigger is model discretion there.",
    `  floor      measured against \`claude ${HOOK_FLOOR_CLAUDE_VERSION}\`. Events known to exist at the floor:`,
    `             ${FLOOR_HOOK_EVENTS.join(", ")}.`,
    `  vocabulary ${KNOWN_HOOK_EVENTS.length} events accepted by \`claude ${KNOWN_EVENTS_CLAUDE_VERSION}\`, measured one at a time:`,
    `             ${KNOWN_HOOK_EVENTS.join(", ")}.`,
    "",
    "  Why one event and not three: MEASURED that ONE unrecognised event discards EVERY hook in the",
    "  file — `Hooks (3)` becomes `Hooks (0)`, with no warning, no error and no non-zero exit. The",
    "  blast radius is the whole file, so adding an event is a breaking change for every older claude.",
    "",
    "  The file brigadier writes:",
    ...HOOKS_TEXT.trimEnd()
      .split("\n")
      .map((line) => `    ${line}`),
  ];
}

/**
 * The host's own view, asked for explicitly.
 *
 * Opt-in rather than automatic: spawning another vendor's binary as a side
 * effect of a diagnostic is a surprise, and the file half of this check is the
 * half that works on a machine with no `claude` at all. When it does run, it is
 * `missingHooks` in `hooks.ts` that reads the output — by NAME.
 */
function claudeDetails(env: Record<string, string | undefined>): string | undefined {
  const found = Bun.which("claude");
  if (found === null) return undefined;
  // The SAME environment the file half was resolved against. `claude` finds its
  // config through HOME, so consulting the host with the ambient environment
  // while checking files under a `--home` elsewhere would report on one
  // installation and print it beside another.
  const child: Record<string, string> = { NO_COLOR: "1" };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) child[key] = value;
  const proc = Bun.spawnSync([found, "plugin", "details", PLUGIN_NAME], {
    env: child,
    stdout: "pipe",
    stderr: "pipe",
  });
  const decode = new TextDecoder();
  return `${decode.decode(proc.stdout)}${decode.decode(proc.stderr)}`;
}

export function hooksCheckCommand(argv: readonly string[]): number {
  const { home, env } = contextFrom(argv);
  const candidates = hooksCandidates(env, home);
  const findings = candidates.map((candidate) =>
    inspectHooks(
      candidate.path,
      existsSync(candidate.path) ? safeRead(candidate.path) : undefined,
      candidate.ours,
    ),
  );
  const installed = INSTALL_ROOTS.every((root) => existsSync(rootDirectory(root, env, home)));
  const report = judgeHooks({
    findings,
    installed,
    detailsOutput: flag(argv, "host") ? claudeDetails(env) : undefined,
  });

  console.log(`brigadier plugin hooks --check — home ${home}`);
  console.log("");
  candidates.forEach((candidate, index) => {
    const finding = findings[index];
    if (finding === undefined) return;
    for (const line of describeFinding(finding, candidate.why)) console.log(line);
    console.log("");
  });
  for (const line of report.runLevel) console.log(line);
  console.log("");
  console.log(
    report.ok
      ? "no problem found in the files brigadier knows about."
      : "PROBLEMS ABOVE. A hooks.json outside the paths listed here was not inspected.",
  );
  return report.ok ? 0 : 1;
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** `brigadier plugin <subcommand>`. */
export function pluginCommand(argv: readonly string[]): number {
  const subcommand = argv[0];
  if (subcommand === "hooks") {
    if (flag(argv, "check")) return hooksCheckCommand(argv);
    for (const line of hooksSurface()) console.log(line);
    return 0;
  }
  console.error(`unknown command: plugin ${subcommand ?? ""}\n`);
  console.error(PLUGIN_USAGE);
  return 2;
}
