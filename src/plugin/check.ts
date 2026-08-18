// SPDX-License-Identifier: Apache-2.0
/**
 * Reading `hooks.json` files back, and saying out loud what `claude` will not.
 *
 * Ruling 60 is the whole reason this module exists. MEASURED against
 * `claude 2.1.233` on 2026-08-17 and re-measured against `claude 2.1.234` on
 * 2026-08-18: **one unrecognised event discards EVERY hook in the file, with no
 * warning, no error and no non-zero exit** — `Hooks (3)` becomes `Hooks (0)`.
 * Malformed JSON does the same thing just as quietly. A user whose hooks stopped
 * firing has nothing to read.
 *
 * So brigadier reads the files itself and reports the cause BY NAME. Three
 * properties of that report are load-bearing rather than stylistic:
 *
 *   **Names, never a count.** A count is not a usable signal here and that was
 *   measured, not assumed: `.lsp.json` reported `LSP servers (1)` for
 *   `{"notARealKey": 1}`, so a non-zero count is evidence of nothing. The same
 *   probe measured `claude plugin details` printing the names —
 *   `Hooks (1)  PreCompact` — which is what `missingHooks` in `hooks.ts` asserts
 *   on.
 *
 *   **The unrecognised key is quoted back.** "This file has a problem" sends the
 *   reader to a file that looks fine, because every line in it looks like every
 *   other line. The key is what they can act on.
 *
 *   **Flagging is measured against the NEWEST `claude`, not the floor.** These
 *   are other people's files. `KNOWN_HOOK_EVENTS` is deliberately the widest
 *   measured vocabulary so that a real event is never reported as poison; see
 *   the note beside it in `hooks.ts`.
 *
 * Reading is not writing. Ruling 8 bars brigadier from WRITING into a file
 * another product owns, and nothing here writes anything at all — an inspection
 * that reported a problem by fixing it would be exactly the violation.
 */

import { join } from "node:path";
import { PLUGIN_NAME } from "./asset.ts";
import { hookWarning, missingHooks, REGISTERED_HOOK_EVENTS, unrecognisedEvents } from "./hooks.ts";
import { claudeConfigDir, resolveHome } from "./install.ts";

export type HooksStatus = "absent" | "unreadable" | "malformed" | "not-an-object" | "healthy" | "poisoned";

/**
 * How the event names were located in the file.
 *
 * Two shapes are accepted and only ONE of them is measured, which is stated here
 * rather than left for a reader to discover. `hooks/hooks.json` inside a plugin
 * wraps its events in a `hooks` object — that is the shape
 * `probes/plugin-manifests.sh` drove. A standalone `hooks.json` in a config
 * directory is read as a bare event map, which is an inference from its
 * contents and is labelled as one in the output.
 */
export type HooksShape = "wrapped" | "bare" | "none";

export interface HooksFinding {
  readonly path: string;
  /** True when brigadier owns this file. Only ours can be a self-check. */
  readonly ours: boolean;
  readonly status: HooksStatus;
  readonly shape: HooksShape;
  readonly events: string[];
  readonly unrecognised: string[];
  /** What was actually seen, recorded on a healthy file as well as a broken one. */
  readonly detail: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Judge one file's bytes.
 *
 * Pure, and takes the text rather than the path, so every branch below is driven
 * by a test instead of by whatever happens to be on the machine running it.
 * `undefined` means the file is not there, which is a different observation from
 * an empty one and is reported differently.
 */
export function inspectHooks(path: string, text: string | undefined, ours: boolean): HooksFinding {
  const base = { path, ours, events: [] as string[], unrecognised: [] as string[] };
  if (text === undefined) {
    return { ...base, status: "absent", shape: "none", detail: "not present" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ...base,
      status: "malformed",
      shape: "none",
      detail:
        `malformed JSON (${error instanceof Error ? error.message : String(error)}) — MEASURED that claude reports ` +
        "this as a silent zero: every hook in the file is discarded and nothing is printed",
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ...base,
      status: "not-an-object",
      shape: "none",
      detail: `top level is ${Array.isArray(parsed) ? "an array" : typeof parsed}, not an object — no events can be read from it`,
    };
  }

  const wrapped = isPlainObject(parsed["hooks"]);
  const shape: HooksShape = wrapped ? "wrapped" : "bare";
  const events = Object.keys(wrapped ? (parsed["hooks"] as Record<string, unknown>) : parsed);
  const unrecognised = unrecognisedEvents(events);
  const where =
    shape === "wrapped"
      ? "events read from the `hooks` object (the MEASURED plugin shape)"
      : "no `hooks` wrapper, so the top-level keys are read as event names";

  if (unrecognised.length > 0) {
    return {
      ...base,
      status: "poisoned",
      shape,
      events,
      unrecognised,
      detail: `${events.length} key(s): ${events.join(", ")} — ${where}`,
    };
  }
  return {
    ...base,
    status: "healthy",
    shape,
    events,
    unrecognised,
    detail: `${events.length} event(s): ${events.join(", ")} — ${where}`,
  };
}

/** The files brigadier knows to look at under one home. */
export interface HooksCandidate {
  readonly path: string;
  readonly ours: boolean;
  readonly why: string;
}

/**
 * Where a `hooks.json` that matters is looked for.
 *
 * A fixed list rather than a filesystem sweep, and the reason is ruling 8's
 * neighbour rather than performance: a sweep of a user's home would read files
 * this product has no business reading, and it would report on them with a
 * confidence it has not earned. The output says plainly that a hooks file
 * outside this list was not inspected.
 */
export function hooksCandidates(
  env: Record<string, string | undefined> = process.env,
  home = resolveHome(env),
): HooksCandidate[] {
  const claude = claudeConfigDir(env, home);
  return [
    {
      path: join(claude, "skills", PLUGIN_NAME, "hooks", "hooks.json"),
      ours: true,
      why: "brigadier's own hook file — the only one brigadier writes",
    },
    {
      path: join(claude, "hooks.json"),
      ours: false,
      why: "a user-global hooks file in Claude Code's config directory",
    },
    {
      path: join(claude, "hooks", "hooks.json"),
      ours: false,
      why: "a user-global hooks directory in Claude Code's config directory",
    },
    {
      path: join(home, ".agents", "skills", PLUGIN_NAME, "hooks", "hooks.json"),
      ours: true,
      why: "brigadier does NOT write here — a file at this path is inert and is reported as such",
    },
  ];
}

export interface HookReport {
  readonly findings: readonly HooksFinding[];
  /** Ruling 58: properties of the INSTALLATION, not of any one file. */
  readonly runLevel: readonly string[];
  readonly ok: boolean;
}

/**
 * Ruling 58 in its literal form: a missing `PreCompact` is a run-level line.
 *
 * It is a property of the installation rather than of an item, so it is not
 * folded into any single file's row — a reader scanning rows would find every
 * row healthy and the hook still absent, which is the failure this whole module
 * exists to make audible.
 */
export function judgeHooks(input: {
  readonly findings: readonly HooksFinding[];
  /** `claude plugin details brigadier`, when a real `claude` could be run. */
  readonly detailsOutput: string | undefined;
  readonly installed: boolean;
}): HookReport {
  const runLevel: string[] = [];
  let ok = true;

  if (!input.installed) {
    ok = false;
    runLevel.push(
      "brigadier is not installed under this home — there is no brigadier hook file to check. " +
        "Run `brigadier install` first.",
    );
  }

  for (const finding of input.findings) {
    if (finding.status === "poisoned" || finding.status === "malformed" || finding.status === "not-an-object") {
      ok = false;
    }
  }

  // The file-level view, from brigadier's own hook file.
  const own = input.findings.find((f) => f.ours && f.status !== "absent" && f.shape !== "none");
  if (own !== undefined) {
    const missing = REGISTERED_HOOK_EVENTS.filter((event) => !own.events.includes(event));
    if (missing.length > 0) {
      ok = false;
      runLevel.push(hookWarning(missing));
    }
  }

  // The authoritative view, from the host itself. Ruling 60: names, never a count.
  if (input.detailsOutput !== undefined) {
    const missing = missingHooks(input.detailsOutput);
    if (missing.length > 0) {
      ok = false;
      runLevel.push(hookWarning(missing));
    } else {
      runLevel.push(
        `claude reports brigadier's ${REGISTERED_HOOK_EVENTS.join(", ")} hook registered, asserted by NAME — ` +
          'a count is not evidence here, because `{"notARealKey": 1}` was measured reporting `LSP servers (1)`.',
      );
    }
  } else {
    runLevel.push(
      "`claude` was not run, so this is a check of the FILES only. The host's own view — " +
        "`claude plugin details brigadier`, which prints the hook NAMES — was not consulted.",
    );
  }

  return { findings: input.findings, runLevel, ok };
}

/** One file's row, plus its remedy where it has one. */
export function describeFinding(finding: HooksFinding, why: string): string[] {
  const lines = [`${finding.status.toUpperCase().padEnd(13)} ${finding.path}`, `  ${why}`, `  ${finding.detail}`];
  if (finding.status === "poisoned") {
    lines.push(
      `  UNRECOGNISED EVENT(S): ${finding.unrecognised.join(", ")}`,
      "  One unrecognised event DISCARDS EVERY HOOK IN THIS FILE — silently, with no warning and no",
      "    non-zero exit. MEASURED against `claude 2.1.233` on 2026-08-17 and `claude 2.1.234` on",
      "    2026-08-18. Remedy: delete or correct the key(s) named above.",
    );
  }
  if (finding.status === "malformed" || finding.status === "not-an-object") {
    lines.push("  Every hook in this file is discarded. Remedy: fix the JSON.");
  }
  if (finding.ours && finding.status !== "absent" && finding.path.includes(`.agents`)) {
    lines.push(
      "  brigadier does not write this file, and nothing reads hooks from here — MEASURED that Claude",
      "    Code does not discover ~/.agents/skills/ at all. It is inert wherever it came from.",
    );
  }
  return lines;
}
