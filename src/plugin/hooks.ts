// SPDX-License-Identifier: Apache-2.0
/**
 * The hook events brigadier's plugin may register, and the floor they are
 * measured against.
 *
 * Ruling 60. MEASURED against `claude 2.1.233` on macOS 26.5.2 on 2026-08-17
 * (probes/plugin-manifests.sh, 14 checks, 14 passed):
 *
 *   ONE unrecognised event in hooks/hooks.json discards EVERY hook in the file.
 *   `Hooks (3)` becomes `Hooks (0)`. No warning, no error, no non-zero exit.
 *
 * So the blast radius of this file is the whole file, and therefore:
 *
 *   Adding a hook event is a BREAKING CHANGE for every older `claude`, and is
 *   treated as one. A new event may only be added together with raising the
 *   floor below.
 *
 * The other manifests do NOT behave this way, and the differences matter enough
 * to write down — the same probe measured them:
 *
 *   .mcp.json  unknown top-level keys are ignored ALONGSIDE `mcpServers`, but
 *              with no `mcpServers` wrapper a bogus key is COUNTED as a server.
 *   .lsp.json  the top-level keys ARE the servers. A `lspServers` wrapper is
 *              itself counted as a server named `lspServers`, and
 *              `{ "notARealKey": 1 }` alone reports `LSP servers (1)`.
 *   all three  malformed JSON is a silent zero.
 *
 * The two silent failures point in OPPOSITE directions — hooks.json drops
 * everything, .lsp.json accepts anything — so a non-zero count is a valid
 * signal for hooks and a misleading one for LSP, and no generic "did my plugin
 * load?" check can be written. Each manifest needs its own assertion on
 * expected NAMES.
 */

/**
 * The `claude` version the event set below was measured against.
 *
 * Pinned the way `vendor/pins.json` pins `bun` for ruling 47's toolchain check,
 * and for the same reason: the failure this guards is silent, so it cannot be
 * left to be noticed.
 */
export const HOOK_FLOOR_CLAUDE_VERSION = "2.1.233";

/**
 * Events verified to exist at the floor, measured against the real binary.
 *
 * `profiles.ts` discipline: a stale entry here fails silently rather than
 * loudly, which is exactly why the version is recorded beside it.
 */
export const FLOOR_HOOK_EVENTS: readonly string[] = [
  "PreCompact",
  "UserPromptSubmit",
  "SubagentStop",
];

/**
 * What brigadier's plugin actually registers.
 *
 * ONE event, and that is the minimum possible blast radius for a total-discard
 * failure. It is decision 28's recovery of decision 8's accepted cost — the
 * PreCompact handoff nudge — and ruling 57 removed the other candidate reason
 * to add hooks, since the plugin-inert mechanism is the binary's refusal and
 * not a hook.
 */
export const REGISTERED_HOOK_EVENTS: readonly string[] = ["PreCompact"];

/** `bun run build` fails on a non-empty result. Ruling 60's build gate. */
export function eventsAboveFloor(events: readonly string[] = REGISTERED_HOOK_EVENTS): string[] {
  return events.filter((event) => !FLOOR_HOOK_EVENTS.includes(event));
}

/**
 * The self-check, run at first-run and after any plugin update.
 *
 * Asserts NAMES, never a count. MEASURED that `claude plugin details` prints
 * them — `Hooks (1)  PreCompact` — and measured that a count alone is not a
 * usable signal, because `.lsp.json` inflates its count with unknown keys.
 *
 * Under ruling 52 a missing hook is a check with an outcome rather than a
 * silent nothing; under ruling 58 it is reported as a RUN-LEVEL line, because
 * it is a property of the installation rather than of any item.
 *
 * Accepted cost, stated in ruling 60: this parses human-readable CLI output,
 * whose format is not a contract. A reformat turns it into a false negative —
 * which blocks rather than passes, so it fails safe and noisily.
 */
export function missingHooks(detailsOutput: string, expected = REGISTERED_HOOK_EVENTS): string[] {
  const line = detailsOutput.split("\n").find((l) => /^\s*Hooks \(\d+\)/.test(l)) ?? "";
  const names = line
    .replace(/^\s*Hooks \(\d+\)\s*/, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .split(/[,\s]+/)
    .filter(Boolean);
  return expected.filter((event) => !names.includes(event));
}

/** Ruling 58: run-level, because it is a property of the installation. */
export function hookWarning(missing: readonly string[]): string {
  if (missing.length === 0) return "";
  return `brigadier's ${missing.join(", ")} hook${missing.length > 1 ? "s are" : " is"} not registered on this claude — one unrecognised event discards every hook in the file (ruling 60).`;
}
