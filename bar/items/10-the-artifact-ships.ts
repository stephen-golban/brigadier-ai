// SPDX-License-Identifier: Apache-2.0
/**
 * Item 10 — The artifact ships, and says what is in it.
 *
 * Rulings 26, 42, 12, 4, 44, 47, 5, 46, 60, 72.
 *
 * This is the item that can be driven hardest today, because most of it is a
 * statement about a file rather than about a run: the licence surface, the
 * marker scan, the size, the start-up cost, and whether the thing starts with
 * node absent from `PATH`. All of those are asserted against the artifact's own
 * bytes, which is the point of ruling 47's gate — the module graph is a
 * statement of intent and the binary is what ships.
 *
 * The halves that need an installed plugin — ruling 42's discovery path, ruling
 * 60's `PreCompact` by name, and the poisoned `hooks.json` that must be
 * REPORTED rather than silently discarded — are probed against the artifact and
 * reported as the FAIL they are. A count-based hook check would pass where a
 * names-based one fails: `.lsp.json` was measured reporting `LSP servers (1)`
 * for `{"notARealKey": 1}`, which is why ruling 60 asks for the name.
 *
 * Two things this item deliberately does not claim. ChatGPT is a PERMANENT
 * BLANK — a hosted surface has no filesystem — so nothing here should be read as
 * six uniform clients. And ruling 72 leaves "the documented rebuild path
 * actually reproduces the binary" as a bar item still to be written; §6 requires
 * it and this item does not prove it.
 */

import { readFileSync, statSync } from "node:fs";
import { Checks, excerpt } from "../lib/checks.ts";
import { probeFeature } from "../lib/feature.ts";
import { combine } from "../lib/halves.ts";
import { baseEnv, pathWithout, spawnFloorMs } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/**
 * The budget, and the statistic it is a budget on.
 *
 * `MEASUREMENT-SESSION.md` records v1's shipped binary at 63 MB, 70 ms cold and
 * 10 ms warm. "No worse than the product we are replacing" is a defensible bar
 * and a round number is not — but a budget without a statistic is not a check,
 * it is a coin toss, and three independent measurements of this same artifact
 * disagreed by 60% purely because they used different ones.
 *
 * **Which MB.** This repository's own tooling settles it: `scripts/license-gate.ts`
 * prints `bytes / 1_048_576` and labels it "MB", and `NEXT-SESSION.md` records
 * the current binary as "60.5 MB" — which is 63,479,138 bytes read as MEBIbytes.
 * So 63 MB here means 63 MiB, and the budget is stated in BYTES below so no
 * reader has to infer it. The two readings genuinely disagree about the verdict
 * — 63.48 MB decimal is over a 63 MB decimal budget while 60.54 MiB is under a
 * 63 MiB one — which is exactly why it is written out rather than left implicit.
 *
 * **Which start-up number.** The MINIMUM of a large N, floor-corrected. Three
 * reasons, in the order they matter:
 *
 *   A start-up budget is a claim about the process's intrinsic cost, and
 *   scheduler noise only ever ADDS. The minimum is therefore the least biased
 *   estimator of the thing being budgeted; a median bakes in whatever else the
 *   machine was doing, which differs across the three platforms `BAR.md`
 *   mandates.
 *
 *   MEASURED on 2026-08-17 (darwin 25.5.0 arm64, bun 1.3.14, Python 3.9.6
 *   `subprocess.run`), the minimum is STABLE and small N is not. For a
 *   `bun --compile` binary whose whole program is `process.exit(0)`: min-of-5
 *   **10.01 ms** with a max of **759 ms**, min-of-40 **7.76 ms**, min-of-150
 *   **7.45 ms**. For `dist/brigadier --help`: min-of-5 **12.10 ms**, min-of-40
 *   **12.13 ms**, min-of-150 **12.07 ms**. Forty samples is where the estimate
 *   stops moving, and the first draft's best-of-5 was reading noise.
 *
 *   That measurement also answers a live objection. A verifier reported that
 *   this check "can only be satisfied by something the product is not allowed to
 *   be", since ruling 5 mandates a `bun --compile` artifact. At best-of-5 that is
 *   true. At min-of-40 the runtime floor is 7.76 ms raw and ~6.5 ms
 *   floor-corrected, against a 10 ms budget — so the budget is satisfiable with
 *   about 3.5 ms of headroom, and the artifact misses it for a real reason
 *   rather than a definitional one.
 */
export const SIZE_BUDGET_BYTES = 63 * 1_048_576;
export const COLD_START_BUDGET_MS = 70;
export const WARM_START_BUDGET_MS = 10;
/** Where the minimum stopped moving. See the measurement above. */
export const START_SAMPLES = 40;

/**
 * Ruling 47. `@anthropic-ai/claude-agent-sdk` is proprietary — "© Anthropic PBC.
 * All rights reserved.", no redistribution grant — and the Claude ACP bridge
 * depends on it. It stays out of the binary only because ruling 44's
 * `CLAUDE_CODE_EXECUTABLE` shim keeps it out, so this is a constraint that is
 * currently true by accident and needs a guard against the artifact itself.
 *
 * Listed here rather than imported from `scripts/inventory.ts` on purpose: a
 * verifier drives this harness against a downloaded release with no repository
 * beside it, and a check that needed the build tree could not run there.
 */
export const PROPRIETARY_MARKERS = [
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "© Anthropic PBC. All rights reserved.",
] as const;

export interface ArtifactObservations {
  licences: { code: number | null; stdout: string; stderr: string };
  full: { code: number | null; stdout: string; stderr: string };
  markersFound: string[];
  sizeBytes: number;
  coldMs: number;
  warmMs: number;
  /** What this harness costs to spawn anything at all, subtracted below. */
  spawnFloorMs: number;
  nodeless: { code: number | null; stdout: string; stderr: string };
  nodelessPathRemoved: string[];
  installProbe: string;
  hooksProbe: string;
}

const APACHE_BODY = "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION";
const APACHE_APPENDIX = "APPENDIX: How to apply the Apache License";
const LGPL_TITLES = [/GNU LESSER GENERAL PUBLIC LICENSE/i, /GNU LIBRARY GENERAL PUBLIC LICENSE/i];
const LGPL_BODY = [
  /This library is free software/i,
  /Version 2\.1, February 1999/i,
  /Version 2, June 1991/i,
];

export function judgeArtifact(o: ArtifactObservations): Checks {
  const checks = new Checks();
  const full = o.full.stdout;

  // Ruling 47 / Apache-2.0 §4(a): the obligation is to whoever RECEIVES the
  // work, and under ruling 26 that is routinely a bare binary from a tap or a
  // plugin directory with no repository beside it.
  checks.expect(
    "`brigadier licenses` exits 0 and names the licence",
    o.licences.code === 0 && /Apache-2\.0/.test(o.licences.stdout),
    `exit ${o.licences.code}; stdout: ${excerpt(o.licences.stdout, 240)}`,
  );
  checks.expect(
    "attribution names at least one third-party component with a version",
    /\n\s+\S+\s+\d+\.\d+\S*\s+—\s+/.test(o.licences.stdout),
    `component lines found: ${excerpt(o.licences.stdout.split("\n").filter((l) => /—/.test(l)).join(" | "), 240)}`,
  );
  checks.expect(
    "`--full` carries the complete Apache-2.0 text",
    full.includes(APACHE_BODY) && full.includes(APACHE_APPENDIX),
    `--full is ${full.length} bytes; ${APACHE_BODY}: ${full.includes(APACHE_BODY)}; appendix: ${full.includes(APACHE_APPENDIX)}`,
  );

  // Ruling 72. §6 makes supplying the Library's own licence unconditional, and
  // MEASURED on 2026-08-17: Bun's shipped binary carries 875 hits for
  // "JavaScriptCore" and 0 for "GNU Lesser/Library General Public", so nothing
  // upstream discharges it for us.
  const lgplTitle = LGPL_TITLES.find((r) => r.test(full));
  const lgplBody = LGPL_BODY.find((r) => r.test(full));
  checks.expect(
    "`--full` carries the LGPL text itself (ruling 72)",
    lgplTitle !== undefined && lgplBody !== undefined,
    `searched ${full.length} bytes of --full: title ${lgplTitle ? "found" : "ABSENT"}, body ${lgplBody ? "found" : "ABSENT"}`,
  );
  checks.expect(
    "the relink recipe is present",
    /relink/i.test(full) && /github\.com\/oven-sh\/webkit/i.test(full),
    `relink: ${/relink/i.test(full)}; oven-sh/WebKit: ${/github\.com\/oven-sh\/webkit/i.test(full)}`,
  );
  // The pin must be attached to the library it pins. A bare 40-hex anywhere in
  // the text is not evidence: the first draft of this check passed on
  // `532c8b70b9142c17e07737ab6d3da68d7500cbca`, which is a commit in a URL about
  // Tigerbeetle's IO code and pins nothing about WebKit at all.
  const webkitPin = pinNear(full, "webkit");
  const tinyccPin = pinNear(full, "tinycc");
  checks.expect(
    "WebKit's and tinycc's corresponding source is reachable, PINNED (ruling 72)",
    webkitPin !== undefined && tinyccPin !== undefined,
    `WebKit pin: ${webkitPin ?? "ABSENT"}; tinycc pin: ${tinyccPin ?? "ABSENT"} — a pin must be a 40-hex revision or a tagged reference on the same line as the library it pins`,
  );

  // Ruling 47's marker scan, on the artifact rather than the module graph.
  checks.expect(
    "the binary carries no proprietary marker",
    o.markersFound.length === 0,
    o.markersFound.length === 0
      ? `scanned ${o.sizeBytes} bytes for ${PROPRIETARY_MARKERS.length} markers, none found`
      : `found ${o.markersFound.map((m) => JSON.stringify(m)).join(", ")}`,
  );

  checks.expect(
    `binary within the measured budget of ${SIZE_BUDGET_BYTES} bytes (63 MiB)`,
    o.sizeBytes <= SIZE_BUDGET_BYTES,
    `${o.sizeBytes} bytes = ${(o.sizeBytes / 1_048_576).toFixed(2)} MiB = ${(o.sizeBytes / 1_000_000).toFixed(2)} MB decimal. ` +
      `Budget is 63 MiB (${SIZE_BUDGET_BYTES} bytes): this repository's own license-gate prints bytes/1048576 and calls it "MB", ` +
      "so v1's MEASURED 63 MB is 63 MiB. Both readings are printed because they disagree about the verdict",
  );
  // The harness's own spawn cost is subtracted, because otherwise a 10 ms
  // budget is being checked against a number that includes a millisecond of this
  // file. Both the raw and the corrected figures are printed so the correction
  // can be argued with rather than taken on trust.
  const coldNet = Math.round((o.coldMs - o.spawnFloorMs) * 100) / 100;
  const warmNet = Math.round((o.warmMs - o.spawnFloorMs) * 100) / 100;
  checks.expect(
    `first invocation within ${COLD_START_BUDGET_MS} ms`,
    coldNet <= COLD_START_BUDGET_MS,
    `${o.coldMs} ms observed − ${o.spawnFloorMs} ms spawn floor = ${coldNet} ms`,
  );
  checks.expect(
    `warm start within ${WARM_START_BUDGET_MS} ms (minimum of ${START_SAMPLES}, floor-corrected)`,
    warmNet <= WARM_START_BUDGET_MS,
    `MEASURED just now: minimum of ${START_SAMPLES} invocations ${o.warmMs} ms − ${o.spawnFloorMs} ms spawn floor = ${warmNet} ms; ` +
      `budget ${WARM_START_BUDGET_MS} ms is v1's warm figure from MEASUREMENT-SESSION.md. ` +
      `The statistic is the MINIMUM because scheduler noise only adds, and N=${START_SAMPLES} because that is where it stopped moving ` +
      "(MEASURED against bun 1.3.14 on darwin 25.5.0 arm64, 2026-08-17: min-of-5 12.10 ms, min-of-40 12.13 ms, min-of-150 12.07 ms)",
  );
  checks.note(
    "start-up caveat",
    "this harness does not control the OS page cache, and earlier items have already executed the binary, so the first figure is a FIRST-INVOCATION time and not a true cold start. The authoritative cold measurement is CI's, against a freshly downloaded artifact in a clean checkout",
  );
  checks.note(
    "is the warm budget reachable at all",
    "yes, and it was checked rather than assumed. MEASURED on 2026-08-17: a `bun --compile` binary whose whole program is `process.exit(0)` starts in 7.76 ms (min-of-40) raw, ~6.5 ms floor-corrected — so ruling 5's mandated runtime leaves about 3.5 ms of headroom under the 10 ms budget",
  );

  // Ruling 4: the bridges are vendored, and the binary must start where node is
  // not installed at all.
  checks.expect(
    "runs with node absent from PATH (ruling 4)",
    o.nodeless.code === 0 && o.nodeless.stdout.length > 0,
    `removed ${o.nodelessPathRemoved.length} PATH entries containing a \`node\`; exit ${o.nodeless.code}; stdout ${o.nodeless.stdout.length} bytes; stderr: ${excerpt(o.nodeless.stderr, 160)}`,
  );

  // Ruling 42 and ruling 60. Probed against the artifact, never assumed.
  checks.expect(
    "an install surface exists to reach ~/.agents/skills/ (ruling 42)",
    !/unknown command/i.test(o.installProbe),
    o.installProbe,
  );
  checks.expect(
    "the hook surface can be verified BY NAME, and a poisoned hooks.json is reported (ruling 60)",
    !/unknown command/i.test(o.hooksProbe),
    o.hooksProbe,
  );

  checks.note(
    "scope",
    "ChatGPT is a permanent blank — a hosted surface has no filesystem — so nothing here implies six uniform clients. And ruling 72 leaves 'the documented rebuild path reproduces the binary' as a bar item still to be written; this item does not prove it",
  );

  return checks;
}

/**
 * A pinned revision on the same line as the library it pins.
 *
 * "Same line" is the whole point: ruling 72 asks that the corresponding source
 * be reachable from the same place as the binary, PINNED, and a revision that
 * belongs to some other component is not a pin — it is a coincidence that
 * happens to be forty characters of hex.
 */
export function pinNear(text: string, library: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.toLowerCase().includes(library.toLowerCase())) continue;
    const sha = /\b[0-9a-f]{40}\b/.exec(line);
    if (sha) return sha[0];
    const tagged = /(?:@|#|\btag[:=]\s*|\bpinned to\s+)v?\d+[\w.-]*/i.exec(line);
    if (tagged) return tagged[0];
  }
  return undefined;
}

export function scanForMarkers(bytes: Buffer): string[] {
  const found: string[] = [];
  for (const marker of PROPRIETARY_MARKERS) {
    if (bytes.indexOf(Buffer.from(marker, "utf8")) !== -1 || bytes.indexOf(Buffer.from(marker, "latin1")) !== -1) {
      found.push(marker);
    }
  }
  return found;
}

const item: BarItem = {
  id: 10,
  title: "The artifact ships, and says what is in it",
  rulings: [26, 42, 12, 4, 44, 47, 5, 46, 60, 72],
  requiresLive: false,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    // Timed first, before anything else touches the binary in this item.
    const cold = await ctx.run(["--help"], { timeoutMs: 30_000 });
    let warm = Number.POSITIVE_INFINITY;
    for (let i = 0; i < START_SAMPLES; i++) {
      const run = await ctx.run(["--help"], { timeoutMs: 30_000 });
      warm = Math.min(warm, run.ms);
    }
    const floor = await spawnFloorMs();
    did.push(
      `timed \`brigadier --help\` once, then ${START_SAMPLES} more times and took the MINIMUM, and calibrated this harness's own spawn cost at ${floor} ms`,
    );

    const licences = await ctx.run(["licenses"], { timeoutMs: 30_000 });
    const full = await ctx.run(["licenses", "--full"], { timeoutMs: 60_000 });
    did.push("ran `brigadier licenses` and `brigadier licenses --full`");

    const bytes = readFileSync(ctx.binary);
    const markersFound = scanForMarkers(bytes);
    did.push(`scanned ${bytes.byteLength} bytes of the artifact for ${PROPRIETARY_MARKERS.length} proprietary markers`);

    const separator = process.platform === "win32" ? ";" : ":";
    const strippedPath = pathWithout("node");
    const before = (process.env["PATH"] ?? "").split(separator).filter((d) => d.length > 0);
    const after = new Set(strippedPath.split(separator));
    const removed = before.filter((d) => !after.has(d));
    ctx.log(`re-running with ${removed.length} PATH entries removed so no \`node\` is reachable`);
    const nodeless = await ctx.run(["licenses"], { env: baseEnv({ PATH: strippedPath }), timeoutMs: 30_000 });
    did.push(`ran \`brigadier licenses\` with a PATH from which every directory containing a \`node\` was removed`);

    const install = await probeFeature(ctx, ["install"], { timeoutMs: 30_000 });
    const hooks = await probeFeature(ctx, ["plugin", "hooks"], { timeoutMs: 30_000 });
    did.push("probed `brigadier install` and `brigadier plugin hooks` for the plugin/discovery surface");

    const checks = judgeArtifact({
      licences: { code: licences.code, stdout: licences.stdout, stderr: licences.stderr },
      full: { code: full.code, stdout: full.stdout, stderr: full.stderr },
      markersFound,
      sizeBytes: statSync(ctx.binary).size,
      coldMs: cold.ms,
      warmMs: warm,
      spawnFloorMs: floor,
      nodeless: { code: nodeless.code, stdout: nodeless.stdout, stderr: nodeless.stderr },
      nodelessPathRemoved: removed,
      installProbe: install.transcript,
      hooksProbe: hooks.transcript,
    });

    // Every assertion in this item is about a file on disk or a process that
    // needs no account, so the whole item runs on `BAR.md`'s authoritative CI
    // leg rather than waiting for a credentialed machine.
    return combine(did, checks, { kind: "none" });
  },
};

export default item;
