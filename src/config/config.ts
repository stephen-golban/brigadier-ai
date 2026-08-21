// SPDX-License-Identifier: Apache-2.0
/**
 * The per-machine settings file — ruling 18's first layer, built at last.
 *
 * Ruling 18 specified three configuration layers and a state file. Ruling 71
 * named them concretely as *"three files with three lifetimes"*: per-machine
 * config, state, and a per-repo declarative file. **Only state was ever
 * built.** Until this module, the sole file brigadier read was
 * `bridges.json` — ruling 69's bridge-coordinate escape hatch, which is one
 * key for one purpose and was never the config layer.
 *
 * Every knob was therefore a CLI flag, and ruling 75 is what makes that
 * untenable: under D1 a person types a goal in English and never learns a
 * command, so a flag is something the *model* would have to remember to pass.
 * A setting nobody can reach is a setting that does not exist.
 *
 * WHAT MAY LIVE HERE, and it is a short list on purpose. Ruling 18: *"A setting
 * must justify its layer or it is not added."* The three layers are not
 * interchangeable, and the boundaries below are security properties rather than
 * tidiness:
 *
 *   per-machine (this file)  what brigadier cannot determine and that varies by
 *                            person: roles, consents, budget defaults, the
 *                            ambient-suppression toggle. Authored by the
 *                            operator, hand-editable, written once.
 *   per-repo (committed)     DECLARATIVE only — ruling 37. Paths never to
 *                            touch, conventions, work-kind defaults.
 *   per-run (flags)          overrides for one invocation.
 *   state (never here)       the detection cache and run records. Regenerable,
 *                            never hand-edited, safe to delete (ruling 71).
 *
 * **Ruling 37 is why `verify.command` is in this file and can never be in the
 * other one.** A verify command is a thing brigadier EXECUTES, and ruling 18
 * had originally put it in the committed layer — which made it
 * attacker-controlled for any repository the operator did not write, so cloning
 * a hostile repo and running brigadier would execute its command with the
 * operator's privileges. Capability comes from the human, never from data.
 *
 * WHERE IT LIVES, and why not beside the run root. `layout.ts` deliberately
 * keeps run directories out of XDG paths, because `$XDG_STATE_HOME/...` is
 * longer and #5 measured a clone target failing at 198 characters. **That
 * reason does not reach this file**: it is one path opened once, never a clone
 * target and never a prefix of one, so it sits under the operator's config home
 * beside `bridges.json` — one config home, two files, one resolver, rather than
 * a second convention for the same kind of thing.
 *
 * HOW IT FAILS, which is the half ruling 60 measured the hard way. That ruling
 * drove three manifest formats and found the two silent failures pointing in
 * OPPOSITE directions: one unrecognised event in `hooks.json` discards EVERY
 * hook in the file, while `.lsp.json` COUNTS an unknown key as a server and
 * reports `LSP servers (1)` for `{"notARealKey": 1}`. Both are silent, and both
 * leave an operator believing something is in force. So this file splits the
 * two cases rather than picking one behaviour for both:
 *
 *   an UNKNOWN key    is reported by name on stderr and ignored. A typo
 *                     (`possesion`) is exactly this case, and reporting it is
 *                     the only thing that distinguishes a typo from a setting
 *                     that took effect. Ignoring rather than refusing keeps an
 *                     older brigadier able to read a newer file.
 *   a KNOWN key with  is a REFUSAL. There is no reading under which falling
 *   the wrong type    back to the default is right: the operator wrote that key
 *                     on purpose, and running with the default while they
 *                     believe otherwise is the failure this whole module exists
 *                     to avoid.
 *   an ABSENT file    is silent. It is the normal case and always will be —
 *                     ruling 71's promise is that `run` works with nothing
 *                     configured.
 *   an UNREADABLE or  is a REFUSAL, for `bridges.json`'s stated reason: an
 *   unparseable file  operator who wrote one believes it is in force.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the operator's config home is, for every file brigadier reads there.
 *
 * `XDG_CONFIG_HOME` when set and non-empty, else `~/.config`, on every platform
 * including Windows — which is what `bridges.json` has always done, so this is
 * the existing behaviour named rather than a new one introduced.
 */
export function configHome(env: Record<string, string | undefined> = process.env): string {
  const home = env["XDG_CONFIG_HOME"];
  return home !== undefined && home.length > 0 ? home : join(homedir(), ".config");
}

/** Ruling 18's per-machine layer. One file, one purpose. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  return join(configHome(env), "brigadier", "config.json");
}

/** Ruling 69's bridge escape hatch, resolved by the same rule as everything else here. */
export function bridgesPath(env: Record<string, string | undefined> = process.env): string {
  return join(configHome(env), "brigadier", "bridges.json");
}

/**
 * Ruling 81's exploration floor: the share of eligible items that go to a
 * vendor the ranking did not pick.
 *
 * **A JUDGEMENT, NOT A MEASUREMENT**, and it is printed beside every ranking it
 * protects rather than buried here — the same discipline `BAR.md` applies to its
 * own 2.5 MiB contribution budget.
 *
 * It is anchored rather than invented. The map records Google Research finding
 * diminishing returns beyond **five** concurrent agents, which is this project's
 * own ceiling on a wave. One in five is therefore *one slot in a maximal wave*
 * — the smallest floor that is guaranteed to be visible at the fan-out width
 * the product actually reaches, rather than a fraction that rounds to zero on
 * every real run.
 *
 * What it is for, from ruling 81: without a floor a single early failure
 * entrenches itself. v1's finding 87 is the shape — **a model scored 85,
 * silently excluded from every `hard` item**. Ruling 67 refused v1's numeric
 * score floors for that reason, and this must not reintroduce the same silent
 * exclusion through the other door.
 */
export const DEFAULT_EXPLORATION_FLOOR = 0.2;

/**
 * A role proposal, or the absence of one.
 *
 * Ruling 71: roles are *"proposed from what the handshake found, never asked
 * interactively"* — brigadier writes a default the operator can change rather
 * than blocking a first run on a question it cannot ask. An absent list means
 * *not yet proposed*, which is different from *empty*, and only the first is
 * the shape of a machine setup has never run on.
 */
export interface Roles {
  readonly builder?: readonly string[];
  readonly reviewer?: readonly string[];
}

/**
 * Ruling 75's possession toggle.
 *
 * D1: *"Start any CLI and that session is brigadier — toggleable in settings,
 * forceable per session."* This is the toggle half. The forceable-per-session
 * half is the shim's `--plugin-dir` flag and lives nowhere near a file, which
 * is the point of it — a per-session override that a stale settings file cannot
 * countermand.
 */
export interface Possession {
  readonly enabled: boolean;
}

/**
 * Ruling 37's one legal home for something brigadier executes.
 *
 * D19: **brigadier never requires a verify command.** Nothing here pushes the
 * operator toward having tests, nothing warns them for not having them, and a
 * repository with no test suite is a normal repository. Ruling 52 already
 * settles what an absent one renders as: `unconfigured`, which does not block
 * and is printed *"in the same slot with the same prominence as a result"*.
 */
export interface Verify {
  readonly command?: readonly string[];
}

/**
 * D16: the plan file is deleted by default, and keeping it is the toggle.
 *
 * Ruled **against the recommendation**, which was the opposite. The cost is
 * recorded where the setting lives: with `keep` false, the record of how
 * brigadier split a task is gone by the time the split turns out to have been
 * wrong.
 */
export interface PlanRetention {
  readonly keep: boolean;
}

/**
 * Everything the per-machine layer holds, fully resolved.
 *
 * Every field is present and typed after `loadConfig`, so no caller ever writes
 * `config.plan?.keep ?? false` and no caller can disagree with another about
 * what a default is. Optionality inside the structure means *the operator has
 * not chosen*, which is a fact callers legitimately need — an absent `roles`
 * is what setup fills in, and an absent `verify.command` is ruling 52's
 * `unconfigured`.
 */
export interface MachineConfig {
  readonly possession: Possession;
  readonly roles: Roles;
  /** Ruling 17. Suppressed by default, and first-run states that out loud. */
  readonly ambientSuppression: boolean;
  /** Ruling 61: *"Per-machine configurable; the length check is what guarantees correctness."* */
  readonly runRoot?: string;
  /** Ruling 14's desirability filter — the per-run budget an owner sets, defaulted here. */
  readonly workers?: number;
  readonly verify: Verify;
  readonly plan: PlanRetention;
  /** Ruling 81. Printed beside the ranking it protects, never applied silently. */
  readonly explorationFloor: number;
}

export const DEFAULT_CONFIG: MachineConfig = {
  possession: { enabled: true },
  roles: {},
  ambientSuppression: true,
  verify: {},
  plan: { keep: false },
  explorationFloor: DEFAULT_EXPLORATION_FLOOR,
};

/**
 * A config file that cannot be honoured as written.
 *
 * Carries the path, because the operator's first question is always *which
 * file*, and there are two brigadier reads in that directory.
 */
export class ConfigUnusable extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path} cannot be used as written — ${detail}`);
    this.name = "ConfigUnusable";
  }
}

/**
 * What a load produced, including the things that did not stop it.
 *
 * `warnings` is not decoration. It is the entire mechanism that distinguishes a
 * typo from a setting in force, and a caller that drops it has rebuilt
 * `.lsp.json`'s silent accept — which ruling 60 measured reporting
 * `LSP servers (1)` for `{"notARealKey": 1}`.
 */
export interface LoadedConfig {
  readonly config: MachineConfig;
  readonly warnings: readonly string[];
  /** False when no file exists — the normal case, and never a warning. */
  readonly present: boolean;
}

const KNOWN_KEYS = [
  "possession",
  "roles",
  "ambientSuppression",
  "runRoot",
  "workers",
  "verify",
  "plan",
  "explorationFloor",
] as const;

/**
 * The nearest known key to a misspelled one, or nothing.
 *
 * Deliberately crude — a single edit-distance pass over a list of eight. The
 * point is not to be clever about typos; it is that `possesion` and
 * `possession` differ by one character and an operator staring at their own
 * file will not see it. Anything more elaborate would be a guess presented with
 * more confidence than it has earned.
 */
function nearest(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Two edits on an eight-item list is where a suggestion stops being a help
  // and starts being noise: `verify` is three edits from `plan`.
  return bestDistance <= 2 ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unknown keys INSIDE a known object, warned about by their full path.
 *
 * A nested key is still a key, and `{"possession": {"enabld": true}}` is the
 * same operator mistake as `{"possesion": …}` one level down — the setting does
 * not take effect and nothing says so. Reporting only top-level typos would
 * make this module's promise true of the outer layer and false of the inner
 * one, which is the shape of a summary that is truthful in detail (ruling 52).
 */
function warnNested(
  path: string,
  key: string,
  raw: Record<string, unknown>,
  known: readonly string[],
  warnings: string[],
): void {
  for (const nested of Object.keys(raw)) {
    if (known.includes(nested)) continue;
    const suggestion = nearest(nested, known);
    warnings.push(
      `${path}: \`${key}.${nested}\` is not a brigadier setting and was ignored` +
        (suggestion === undefined ? "." : ` — did you mean \`${key}.${suggestion}\`?`),
    );
  }
}

/** A known key carrying the wrong type refuses; see the module comment. */
function wrongType(path: string, key: string, wanted: string, got: unknown): ConfigUnusable {
  return new ConfigUnusable(
    path,
    `\`${key}\` must be ${wanted}, and it is ${describe(got)}. Nothing was defaulted: a key you wrote ` +
      "on purpose is not a key brigadier may quietly ignore.",
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function stringList(path: string, key: string, raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw wrongType(path, key, "an array of strings", raw);
  }
  return raw as readonly string[];
}

/**
 * Parse one config document into a fully-resolved `MachineConfig`.
 *
 * Separate from reading the file so the whole validation surface is exercisable
 * against a string, with no filesystem and no `HOME` — the property
 * `scripts/claims.ts` had to be rebuilt to have, and the reason its check 5 can
 * be driven against synthetic drift at all.
 */
export function parseConfig(text: string, path: string): LoadedConfig {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ConfigUnusable(path, `it is not valid JSON — ${(error as Error).message}`);
  }
  if (!isRecord(document)) {
    throw new ConfigUnusable(path, `the top level must be a JSON object, and it is ${describe(document)}`);
  }

  const warnings: string[] = [];
  for (const key of Object.keys(document)) {
    if ((KNOWN_KEYS as readonly string[]).includes(key)) continue;
    const suggestion = nearest(key, KNOWN_KEYS);
    warnings.push(
      `${path}: \`${key}\` is not a brigadier setting and was ignored` +
        (suggestion === undefined ? "." : ` — did you mean \`${suggestion}\`?`),
    );
  }

  let possession = DEFAULT_CONFIG.possession;
  if ("possession" in document) {
    const raw = document["possession"];
    if (!isRecord(raw)) throw wrongType(path, "possession", "an object", raw);
    warnNested(path, "possession", raw, ["enabled"], warnings);
    if ("enabled" in raw) {
      if (typeof raw["enabled"] !== "boolean") throw wrongType(path, "possession.enabled", "true or false", raw["enabled"]);
      possession = { enabled: raw["enabled"] };
    }
  }

  let roles: Roles = DEFAULT_CONFIG.roles;
  if ("roles" in document) {
    const raw = document["roles"];
    if (!isRecord(raw)) throw wrongType(path, "roles", "an object", raw);
    warnNested(path, "roles", raw, ["builder", "reviewer"], warnings);
    const next: { builder?: readonly string[]; reviewer?: readonly string[] } = {};
    if ("builder" in raw) next.builder = stringList(path, "roles.builder", raw["builder"]);
    if ("reviewer" in raw) next.reviewer = stringList(path, "roles.reviewer", raw["reviewer"]);
    roles = next;
  }

  let ambientSuppression = DEFAULT_CONFIG.ambientSuppression;
  if ("ambientSuppression" in document) {
    const raw = document["ambientSuppression"];
    if (typeof raw !== "boolean") throw wrongType(path, "ambientSuppression", "true or false", raw);
    ambientSuppression = raw;
  }

  let runRoot: string | undefined;
  if ("runRoot" in document) {
    const raw = document["runRoot"];
    if (typeof raw !== "string" || raw.length === 0) throw wrongType(path, "runRoot", "a non-empty string", raw);
    runRoot = raw;
  }

  let workers: number | undefined;
  if ("workers" in document) {
    const raw = document["workers"];
    // The same refusal `--workers` already makes, and for the reason measured
    // there: `Number("abc")` is `NaN`, ruling 14's arithmetic is a `Math.min`
    // chain, and a `NaN` width printed `NaN worker(s) in wave 1` and dispatched
    // nothing while reporting success. A config file reaches the identical
    // arithmetic, so it gets the identical guard rather than trusting the flag
    // path to hold the line for both.
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      throw wrongType(path, "workers", "a whole number of at least 1", raw);
    }
    workers = raw;
  }

  let verify: Verify = DEFAULT_CONFIG.verify;
  if ("verify" in document) {
    const raw = document["verify"];
    if (!isRecord(raw)) throw wrongType(path, "verify", "an object", raw);
    warnNested(path, "verify", raw, ["command"], warnings);
    if ("command" in raw) {
      const command = stringList(path, "verify.command", raw["command"]);
      if (command.length === 0) {
        throw new ConfigUnusable(
          path,
          "`verify.command` is an empty array. Ruling 52 distinguishes a gate that is UNCONFIGURED from " +
            "one that could not run, and an empty command is neither — omit the key to be unconfigured.",
        );
      }
      verify = { command };
    }
  }

  let plan: PlanRetention = DEFAULT_CONFIG.plan;
  if ("plan" in document) {
    const raw = document["plan"];
    if (!isRecord(raw)) throw wrongType(path, "plan", "an object", raw);
    warnNested(path, "plan", raw, ["keep"], warnings);
    if ("keep" in raw) {
      if (typeof raw["keep"] !== "boolean") throw wrongType(path, "plan.keep", "true or false", raw["keep"]);
      plan = { keep: raw["keep"] };
    }
  }

  let explorationFloor = DEFAULT_CONFIG.explorationFloor;
  if ("explorationFloor" in document) {
    const raw = document["explorationFloor"];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw wrongType(path, "explorationFloor", "a number between 0 and 1", raw);
    }
    explorationFloor = raw;
  }

  // Built key by key rather than with `runRoot,` in the literal, because
  // `exactOptionalPropertyTypes` is on and it is right to be: an ABSENT
  // `runRoot` means *the operator has not chosen* and a present `undefined`
  // would mean *the operator chose nothing*, which is not a thing they can do.
  // The distinction is the same one `Roles` rests on, and the compiler holding
  // it is cheaper than a comment asking callers to.
  const config: MachineConfig = {
    possession,
    roles,
    ambientSuppression,
    verify,
    plan,
    explorationFloor,
    ...(runRoot === undefined ? {} : { runRoot }),
    ...(workers === undefined ? {} : { workers }),
  };
  return { present: true, warnings, config };
}

/** What `loadConfig` needs from the world, so tests need no `HOME` and no disk. */
export interface ConfigSource {
  exists(path: string): boolean;
  read(path: string): string;
}

/**
 * Read and resolve the per-machine config.
 *
 * An absent file is the normal case and returns the defaults silently. Ruling
 * 71's promise is that there is nothing to run first, and after ruling 76 that
 * promise survives for `run` and `plan` even though `setup` exists — so a
 * machine setup has never touched must load exactly as though it had run and
 * changed nothing.
 */
export function loadConfig(path: string, source: ConfigSource): LoadedConfig {
  if (!source.exists(path)) return { config: DEFAULT_CONFIG, warnings: [], present: false };
  let text: string;
  try {
    text = source.read(path);
  } catch (error) {
    throw new ConfigUnusable(path, `it could not be read — ${String(error)}`);
  }
  return parseConfig(text, path);
}

/**
 * Ruling 18's precedence, in one place so no caller invents a second one:
 * **a per-run flag beats the file, and the file beats the default.**
 *
 * Written as a function rather than left to `??` at each call site because
 * `0` and `false` are legitimate values for settings here, and `flag ?? file`
 * is correct while `flag || file` is not — a distinction that is invisible at a
 * glance and wrong exactly once.
 */
export function resolve<T>(flag: T | undefined, file: T | undefined, fallback: T): T {
  if (flag !== undefined) return flag;
  if (file !== undefined) return file;
  return fallback;
}
