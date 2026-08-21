// SPDX-License-Identifier: Apache-2.0
/**
 * Possession: what a session is told, through which channel, and when it is
 * told nothing at all.
 *
 * Ruling 75. Until this module, `brigadier install` wrote one markdown file and
 * the shipped `SKILL.md` said what that bought, at line 71:
 *
 *   *"Everywhere else there is no hook, and the trigger is model discretion.
 *   brigadier is reached when the agent reading this decides the description
 *   above matches the task. That is the whole mechanism outside Claude Code,
 *   and it is not a guarantee."*
 *
 * MEASURED against `claude 2.1.238` on macOS 26.5.2 on 2026-08-21, with a
 * negative control that fires:
 *
 *   subject  a `UserPromptSubmit` hook echoing an identity instruction, loaded
 *            with `--plugin-dir`, then a goal typed at the session
 *            => the model replied `brigadier: planning`. The instruction was
 *               read and obeyed.
 *   control  the same goal with no plugin => the model knew nothing of it.
 *   also     the same instruction via `--append-system-prompt` => identical.
 *
 * So both channels carry it, and **the difference between them is cost, not
 * capability**:
 *
 *   `--append-system-prompt-file`  once per session, at launch. Reachable only
 *                                  through the shim, because it is an argv flag
 *                                  on the vendor's own binary (ruling 77).
 *   `UserPromptSubmit`             once per PROMPT, forever. Reachable with no
 *                                  shim, because it lives in a directory
 *                                  brigadier owns (ruling 27, undisturbed).
 *
 * **That asymmetry decides the split.** Ruling 21 measured a **16.5×** cache
 * lever on a byte-stable prefix, and ruling 58 measured what careless output
 * into a host session costs — ~115,000 tokens as a FLOOR for one five-item run
 * if transcripts reached it, against Copilot's measured 128,000-token window. A
 * hook that fires on every prompt is the same arithmetic in miniature: whatever
 * it emits is paid for again on every turn of a conversation that may run for
 * hours.
 *
 * So:
 *
 *   the SHIM carries the doctrine — the long form, once, in the system prompt.
 *   the HOOK carries one line — byte-identical every time, so a cache-stable
 *   prefix stays stable and the per-turn cost is a rounding error.
 *
 * **The hook's text is not user-facing and D24's one-line rule does not govern
 * it.** D24's scope is *output TO THE USER*; this is output to a model, which is
 * ruling 16's brief-shaped channel. It is one line anyway, for the token reason
 * above rather than the prose one, and the two rules must not be confused
 * because they would give different answers the day the doctrine needs two lines.
 *
 * WHEN NOTHING IS EMITTED, which is the half that matters most:
 *
 *   inside a WORKER   ruling 36 requires brigadier's own plugin to be inert in a
 *                     worker session, and ruling 57 makes the binary's refusal
 *                     the only layer that holds once a model has read the
 *                     doctrine and decided to delegate. v1's finding 114 is a
 *                     worker that ran the orchestrator instead of working — 12
 *                     minutes, zero files — and it reproduced UNPROVOKED in #14.
 *                     **A possession hook is finding 114's second route with a
 *                     louder voice**, so it emits nothing at all there.
 *   toggle OFF        D1 makes possession *"toggleable in settings"*. An
 *                     operator who turned it off and still gets the doctrine has
 *                     a setting that does not work.
 *
 * Both are silence rather than an explanatory line, and that is deliberate: a
 * hook that explains why it is being quiet is a hook that costs tokens to say
 * nothing, on every prompt, forever.
 */

/**
 * The one line a possessed session gets on every prompt.
 *
 * Byte-stable by construction — no run id, no timestamp, no path, nothing that
 * varies. The moment a varying token enters this string, ruling 21's cache lever
 * is spent on every turn of every conversation, which is the most expensive
 * possible way to be slightly more informative.
 *
 * It states a capability and a preference, not an order. The model still decides;
 * ruling 20 survives ruling 74 intact in exactly this sense — brigadier is a pipe
 * that can be asked to think, and the asking happens in the session.
 */
export const POSSESSION_LINE =
  "brigadier is active here: for a goal that is more than one edit, run `brigadier run --goal \"<the goal>\"` " +
  "rather than doing the work yourself — it researches, plans, and fans the work out across the coding agents " +
  "on this machine, and returns a path plus a short report.";

/**
 * The longer form, injected once per session by the shim.
 *
 * This one may grow; the hook's line may not. Anything a session needs to know
 * that is not worth paying for on every prompt belongs here.
 */
export const POSSESSION_DOCTRINE = [
  "You are wearing brigadier.",
  "",
  "brigadier is an ACP hub installed on this machine. It drives the coding agents that are",
  "actually present here, isolates each unit of work in its own clone, and composes them — one",
  "vendor builds, a different vendor reviews where the machine has one.",
  "",
  "When the person you are talking to states a goal for a codebase:",
  "",
  "  - If it is a single obvious edit, just do it. brigadier is not a tax on small work.",
  "  - Otherwise run `brigadier run --goal \"<their goal>\"`. It works out whether the goal needs",
  "    research or a plan, asks before spending on either, splits the work, and routes each piece.",
  "  - Show them the lines brigadier prints, as it prints them. Do not paraphrase a run report and",
  "    do not paste a plan into the conversation — the plan is a file and brigadier gives you its",
  "    path. The report is already compacted to fit this window and re-rendering it costs more than",
  "    it says.",
  "  - If brigadier exits asking a question, put that question to them in your own words, in this",
  "    conversation, and continue with `brigadier resume <run-id> --answer \"<their answer>\"`.",
  "",
  "You are the conductor: the request, the progress, the report. The arguing with workhorses happens",
  "where nobody pays for it.",
].join("\n");

/** Everything the possession decision needs, and nothing that would make it need a filesystem. */
export interface PossessionInput {
  /** Ruling 57's environment marker — `BRIGADIER_WORKER` set to anything. */
  readonly insideWorker: boolean;
  /** D1's settings toggle. */
  readonly enabled: boolean;
}

/**
 * What the `UserPromptSubmit` hook writes to stdout, which the model reads.
 *
 * An empty string means *emit nothing*, and the caller must print nothing at
 * all rather than an empty line — Claude Code adds stdout as context, and a
 * blank line is still a byte in a window somebody is paying for.
 */
export function possessionContext(input: PossessionInput): string {
  if (input.insideWorker) return "";
  if (!input.enabled) return "";
  return POSSESSION_LINE;
}

/**
 * Why nothing was emitted, for `brigadier plugin hooks --check` and for a human
 * wondering where their possession went.
 *
 * Deliberately NOT printed by the hook itself. This is the diagnostic path; the
 * hook path stays silent, because the two have opposite cost profiles — this is
 * read once by a person who asked, and that one is paid for on every prompt.
 */
export function possessionSilence(input: PossessionInput): string | undefined {
  if (input.insideWorker) {
    return (
      "silent — this session is a brigadier WORKER (BRIGADIER_WORKER is set). Ruling 36 requires " +
      "brigadier's plugin to be inert in a worker, and v1's finding 114 is a worker that ran the " +
      "orchestrator instead of working: 12 minutes, zero files."
    );
  }
  if (!input.enabled) {
    return "silent — possession is turned off in ~/.config/brigadier/config.json (`possession.enabled: false`).";
  }
  return undefined;
}
