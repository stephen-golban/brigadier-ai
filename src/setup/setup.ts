// SPDX-License-Identifier: Apache-2.0
/**
 * `brigadier setup` — non-interactive, capped, and the thing ruling 71 refused
 * for a reason that did not reach it.
 *
 * Ruling 76. Ruling 71 removed v1's `init` — **1,503 lines**, at once the CLI
 * dispatch, the report renderer, the proposal prompts and the composition root,
 * *"the single file that made that codebase hard to work in"*. Its argument was
 * that decision 25 removed the premise: in host-first, stdout lands in a
 * model's context, so **an interactive propose-flow has nobody to talk to**.
 *
 * That argument is correct, it still holds, and ruling 75's `/dev/tty`
 * measurement makes it more true than ruling 71 knew — a CLI's tool children
 * have no controlling terminal at all. **It simply never reached a
 * non-interactive setup**: detect, write, print, exit needs no interlocutor.
 * Ruling 71's own accepted cost said so out loud — *"no `init` means no guided
 * setup and someone will want one."*
 *
 * THE CAP IS THE RULING, not a note attached to it:
 *
 *   setup writes files and prints. It never asks, and it never runs work.
 *
 * Every line below is one of those two things. A future reader adding a prompt
 * here is reopening ruling 71, and a future reader adding a work item here is
 * rebuilding the 1,503-line file.
 *
 * WHAT IS GENUINELY LOST, said plainly rather than argued away. Ruling 73 drew
 * a careful line for `brigadier detect`: an `init` is *"a step the user must
 * run before the product works"*, while `detect` *"creates nothing a run does
 * not create for itself"*. **`setup` does not clear that line.** Possession
 * needs a hook in brigadier's plugin directory and a `brigadier` the shell can
 * resolve, and neither installs itself from inside a session that has not
 * started. So ruling 71's promise that there is nothing to run first is
 * **overturned, not reinterpreted**.
 *
 * What survives is the narrower half, and it is the half that matters on a
 * machine nobody has set up: **`run` and `plan` still detect lazily**, exactly
 * as ruling 71 specifies. A user who never runs `setup` still has a working
 * `brigadier run`. What they do not have is possession.
 */

import { PLUGIN_NAME } from "../plugin/asset.ts";
import { DEFAULT_CONFIG, type MachineConfig } from "../config/config.ts";
import { rank, UNRANKED } from "../router/competence.ts";
import { KNOWN, ROLES, TABLE, toRow, type Role } from "../router/table.ts";
import type { AgentId } from "../agent/profiles.ts";
import { BLOCK_END, BLOCK_START, onPath, pathLine, profileFor, shellFrom, shimDirectory, type Shell } from "./shim.ts";

/** What detection said, reduced to the two facts setup acts on. */
export interface DetectedAgent {
  readonly id: AgentId;
  readonly usable: boolean;
}

/**
 * Ruling 71's role proposal: *"proposed from what the handshake found, never
 * asked interactively."*
 *
 * Detection returns `usable` agents (ruling 41's two steps), the competence
 * table ranks them within roles (ruling 68), and brigadier **writes the
 * proposal into per-machine config as a default the operator can change**
 * rather than blocking a first run on a question it cannot ask. That is
 * decision 25's constraint producing the same answer for the fourth time —
 * ruling 23's pre-authorised ceiling, ruling 65's pre-authorised grant, ruling
 * 71's written default, and now this.
 *
 * **Unranked is proposed, not excluded.** Ruling 68's fail-open half is
 * load-bearing here: an agent the table has never heard of is eligible, sorted
 * last, and named. Dropping it would be v1's finding 87 — a model scored 85,
 * silently excluded — rebuilt in the one place a first-time user would never
 * think to look.
 */
export function proposeRoles(detected: readonly DetectedAgent[]): MachineConfig["roles"] {
  const usable = new Set(detected.filter((agent) => agent.usable).map((agent) => agent.id));
  if (usable.size === 0) return {};
  const proposal: { builder?: readonly string[]; reviewer?: readonly string[] } = {};
  for (const role of ROLES) {
    const ordered = rank(
      TABLE.filter((entry) => entry.role === role && usable.has(entry.agent)).map(toRow),
      KNOWN,
    );
    // One entry per AGENT, not per (agent, model): roles name who may hold the
    // role, and the triple is the router's business at dispatch (ruling 29).
    const seen = new Set<string>();
    const agents: string[] = [];
    for (const row of ordered) {
      if (seen.has(row.agent)) continue;
      seen.add(row.agent);
      agents.push(row.agent);
    }
    // An agent detection found but the table has never scored in this role is
    // still eligible. It goes last, which is exactly what `UNRANKED` means.
    for (const id of [...usable].sort()) if (!seen.has(id)) agents.push(id);
    if (agents.length > 0) proposal[role] = agents;
  }
  return proposal;
}

/** Everything setup will write, computed before anything is written. */
export interface SetupPlan {
  readonly configPath: string;
  readonly config: MachineConfig;
  /** False when a config already exists — setup never overwrites the operator's file. */
  readonly writeConfig: boolean;
  readonly shimDirectory: string;
  readonly shimPath: string;
  readonly binary: string;
  /**
   * False when the running program is an interpreter rather than a brigadier
   * artifact — `bun run src/cli.ts setup` during development.
   *
   * MEASURED 2026-08-21 by driving exactly that: `process.execPath` was
   * `/Users/.../.bun/bin/bun`, so a shim written from it would have exec'd
   * **bun** with the operator's arguments. It would have been created
   * successfully, reported successfully, and failed only when somebody first
   * typed `brigadier` — which is the shape of failure this repository exists to
   * catch before it ships.
   */
  readonly binaryIsArtifact: boolean;
  readonly shell: Shell;
  readonly profile?: string;
  readonly alreadyOnPath: boolean;
  readonly pathLine: string;
}

export interface PlanInput {
  readonly configPath: string;
  readonly configExists: boolean;
  readonly existingConfig?: MachineConfig;
  readonly root: string;
  readonly binary: string;
  /** See `SetupPlan.binaryIsArtifact`. Supplied by the caller, which knows. */
  readonly binaryIsArtifact: boolean;
  readonly home: string;
  readonly env: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly detected: readonly DetectedAgent[];
}

/**
 * What setup will do, decided before it does any of it.
 *
 * Separated from the doing so the whole decision surface is exercisable with no
 * filesystem, no `HOME` and no spawned vendor — the same split
 * `planInstall`/`install` already uses, and for the reason ruling 15 gives:
 * the manifest is written **before** anything is created.
 */
export function planSetup(input: PlanInput): SetupPlan {
  const platform = input.platform ?? process.platform;
  const directory = shimDirectory(input.root);
  const shell = shellFrom(input.env);
  const profile = profileFor(shell, input.home);
  // An existing config is the operator's file and setup does not touch it.
  // Overwriting it would make `setup` destructive on its second run, which is
  // the one property that would stop anyone running it twice — and ruling 73
  // already established that a repair you are afraid to run is not a repair.
  const config: MachineConfig = input.configExists
    ? (input.existingConfig ?? DEFAULT_CONFIG)
    : { ...DEFAULT_CONFIG, roles: proposeRoles(input.detected) };
  return {
    configPath: input.configPath,
    config,
    writeConfig: !input.configExists,
    shimDirectory: directory,
    shimPath: platform === "win32" ? `${directory}\\brigadier.cmd` : `${directory}/brigadier`,
    binary: input.binary,
    binaryIsArtifact: input.binaryIsArtifact,
    shell,
    ...(profile === undefined ? {} : { profile }),
    alreadyOnPath: onPath(directory, input.env["PATH"]),
    pathLine: pathLine(directory, shell),
  };
}

/**
 * The `PATH` paragraph, which is the only part of setup's output that asks the
 * operator to do something.
 *
 * It is deliberately not phrased as a warning. Ruling 77 ruled that brigadier
 * does not edit a shell profile by default, so an operator who reads this and
 * does nothing has made a legitimate choice — they get `brigadier run` and no
 * possession, which is a supported configuration and not a broken install.
 */
export function pathAdvice(plan: SetupPlan, modified: string | undefined): string[] {
  if (!plan.binaryIsArtifact) {
    return [
      "PATH       no shim was written, so there is nothing to put on PATH yet.",
      `           The running program is ${plan.binary}, which is an interpreter and not a brigadier`,
      "           artifact. A shim built from it would exec that instead of brigadier — created",
      "           successfully, reported successfully, and broken the first time anyone typed",
      "           `brigadier`. Run setup from the compiled binary (`bun run build`, then",
      "           `dist/brigadier setup`).",
    ];
  }
  if (plan.alreadyOnPath) {
    return [`PATH       ${plan.shimDirectory} is already on your PATH — nothing to do.`];
  }
  if (modified !== undefined) {
    return [
      `PATH       added to ${modified}, between \`# brigadier\` and \`# brigadier end\`.`,
      "           Open a new shell, or source that file, for it to take effect.",
      "           `brigadier uninstall` removes exactly that block and nothing else.",
    ];
  }
  const where = plan.profile === undefined
    ? "your shell's startup file"
    : `${plan.profile} (guessed from $SHELL, which says ${plan.shell})`;
  return [
    `PATH       ${plan.shimDirectory} is NOT on your PATH, so \`brigadier\` will not resolve.`,
    `           Add this line to ${where}:`,
    "",
    `               ${plan.pathLine}`,
    "",
    "           brigadier does not write that for you by default. Which startup file is a guess —",
    "           .zshrc, .zprofile, .zshenv, bash, fish and nushell all differ, and on macOS .zshenv",
    "           and .zprofile differ in priority — and a guess that writes to a file your shell never",
    "           sources is a change to your machine that reports success and does nothing. A missing",
    "           PATH entry fails as `command not found`, which you can see. Pass --modify-path to have",
    "           setup write it anyway, in a delimited block uninstall can remove exactly.",
  ];
}

/**
 * Everything setup prints, in one place.
 *
 * Ruling 71's four unlearnable things are here because this is now the first
 * thing a new user runs, and they must appear in **both** places or one of them
 * silently stops printing them — ruling 73's accepted cost #2, repeated
 * deliberately, and carrying ruling 73's own remedy: a repair path with no test
 * is a repair path that does not exist.
 */
export function describeSetup(
  plan: SetupPlan,
  detected: readonly DetectedAgent[],
  modifiedProfile: string | undefined,
  dryRun: boolean,
): string[] {
  const usable = detected.filter((agent) => agent.usable);
  const lines: string[] = [];
  lines.push(
    dryRun ? "brigadier setup --dry-run — brigadier wrote nothing" : "brigadier setup",
  );
  lines.push("");
  lines.push(
    `agents     ${usable.length}/${detected.length} usable${usable.length === 0 ? "" : " — " + usable.map((a) => a.id).join(", ")}`,
  );
  // Ruling 32 and ruling 71's fourth unlearnable thing. A single-vendor machine
  // is supported, common, and the first-time user's most likely configuration —
  // and a weakened check must never render as a pass, so it is said here rather
  // than discovered in a run report.
  if (usable.length === 0) {
    lines.push("           No vendor is drivable. Nothing can be run — `brigadier detect` prints each vendor's own remedy.");
  } else if (usable.length === 1) {
    lines.push("           Only one vendor is drivable, so review would run SAME-VENDOR and every run will say so.");
  } else {
    lines.push("           Cross-vendor review is available — a reviewer of a different vendor can be routed.");
  }
  lines.push(
    `config     ${plan.configPath}${plan.writeConfig ? "" : " — already exists, left exactly as it is"}`,
  );
  if (plan.writeConfig) {
    const builder = plan.config.roles.builder ?? [];
    const reviewer = plan.config.roles.reviewer ?? [];
    lines.push(
      `           roles proposed, not asked (ruling 71) — builder: ${builder.join(", ") || "none"}; reviewer: ${reviewer.join(", ") || "none"}`,
    );
    lines.push("           Edit that file to change them. Nothing here is a question you have to answer.");
  }
  lines.push(`plugin     ~/.agents/skills/${PLUGIN_NAME}/ and ~/.claude/skills/${PLUGIN_NAME}/`);
  lines.push(
    plan.binaryIsArtifact
      ? `shim       ${plan.shimPath} → ${plan.binary}`
      : "shim       NOT written — see PATH below",
  );
  lines.push("");
  lines.push(...pathAdvice(plan, modifiedProfile));
  lines.push("");
  lines.push("Ambient instruction files (a user-global AGENTS.md and the like) are SUPPRESSED in workers by");
  lines.push("  default — decision 17. A worker will not obey them, so anything load-bearing belongs in the plan.");
  lines.push("Isolation covers the filesystem and the process tree. It does NOT cover external services: a");
  lines.push("  worker that reaches the network can still act on the world, and no clone contains that.");
  lines.push("");
  if (dryRun) {
    // Ruling 52's rule about summaries, applied to our own: the detection sweep
    // SPAWNS each vendor (ruling 41's second step is a real `session/new`), and
    // a spawned vendor writes its own files under HOME — MEASURED 2026-08-21
    // against a throwaway home, where a dry run left gemini's `installation_id`,
    // opencode's database and npm's logs behind while brigadier left nothing.
    // "Nothing was written" would be truthful about brigadier and false about
    // the home directory, and people read summaries.
    lines.push("Detection SPAWNED each vendor, because ruling 41's second step is a real session. Those");
    lines.push("  vendors write their own files under your home and --dry-run does not bind them; what it");
    lines.push("  means is that BRIGADIER created nothing.");
    lines.push("");
  }
  lines.push("This reports the machine as it is right now. An agent that updates or logs out after this");
  lines.push("  moment is not covered by anything printed above — `brigadier detect` re-reads it.");
  return lines;
}

/** Roles as they will be written, for the config file setup lays down. */
export function configDocument(config: MachineConfig): string {
  const document: Record<string, unknown> = {
    possession: config.possession,
    roles: config.roles,
    ambientSuppression: config.ambientSuppression,
    plan: config.plan,
    explorationFloor: config.explorationFloor,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The role a caller asked about, if the proposal named any agent for it. */
export function proposedFor(roles: MachineConfig["roles"], role: Role): readonly string[] {
  return roles[role] ?? [];
}

export { UNRANKED };

/** What `brigadier uninstall` found of setup's own artifacts, before removing them. */
export interface SetupRemoval {
  readonly shimPath: string;
  readonly shimExisted: boolean;
  readonly profile?: string;
  /**
   * `removed` — the block was there and came out cleanly.
   * `absent` — there was no block, which is the default configuration.
   * `unpaired` — a start marker with no end marker. **Refused, not guessed.**
   */
  readonly block: "removed" | "absent" | "unpaired";
}

/**
 * Ruling 77's accepted cost, discharged.
 *
 * Ruling 26 promised *"uninstall is deleting the directory"* on the grounds that
 * *"the docs are explicit that nothing was installed, so nothing must be
 * uninstalled."* Setup broke half of that: the shim is inside brigadier's own
 * root, so deleting the directory still covers it, but `--modify-path` writes a
 * block into a file brigadier did not create and that block outlives any
 * directory removal.
 *
 * So uninstall reports **three** things and claims nothing beyond them, and the
 * renderer below refuses to print *"no PATH edit"* on a machine where there was
 * one. v1's output was *"truthful in detail and false in summary, and people
 * read summaries"* (ruling 52); a summary that survives its own feature being
 * overturned is how that happens again.
 */
export function describeSetupRemoval(removal: SetupRemoval): string[] {
  const lines: string[] = ["what `brigadier setup` added"];
  lines.push(
    removal.shimExisted
      ? `  removed   ${removal.shimPath}`
      : `  absent    ${removal.shimPath} — nothing was there`,
  );
  switch (removal.block) {
    case "removed":
      lines.push(`  removed   the \`${BLOCK_START}\` block from ${removal.profile ?? "your shell profile"}`);
      lines.push("            Only what was between the markers. The rest of that file is untouched.");
      break;
    case "unpaired":
      lines.push(`  REFUSED   ${removal.profile ?? "your shell profile"} has a \`${BLOCK_START}\` with no \`${BLOCK_END}\``);
      lines.push("            Somebody edited inside the block, so brigadier will not guess where it ends.");
      lines.push("            Remove those lines by hand. Nothing in that file was changed.");
      break;
    case "absent":
      lines.push("  absent    no PATH edit was found — the default, since setup does not make one");
      lines.push("            unless you pass --modify-path.");
      break;
  }
  return lines;
}
