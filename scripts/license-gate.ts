// SPDX-License-Identifier: Apache-2.0
/**
 * The gate: does the compiled binary contain anything it may not redistribute?
 *
 * Ruling 47. This exists because the constraint it enforces is currently true
 * by accident. `@anthropic-ai/claude-agent-sdk` is proprietary — "© Anthropic
 * PBC. All rights reserved.", no redistribution grant — and the Claude ACP
 * bridge depends on it. It stays out of the binary only because the bridge
 * resolves it through `import.meta.resolve`, which fails inside `/$bunfs/`
 * (measured in #4, and diagnosed there as a bug). Ruling 44's
 * `CLAUDE_CODE_EXECUTABLE` shim is what makes that permanent.
 *
 * A bridge upgrade that switched to a static import would silently begin
 * shipping proprietary code in a signed, redistributed binary. **No test would
 * go red and no user would report it** — the failure is legal, not functional.
 * That is precisely the defect class this project keeps recording, so it gets a
 * guard rather than a note.
 *
 * Three checks, all against the REAL artifact where they can be:
 *
 *   1. licences   every npm component in the production closure is allowlisted
 *   2. markers    the compiled binary contains no proprietary marker string
 *   3. pin        the `bun` that built it matches the vendored attribution
 *
 * Check 2 inspects the binary rather than the module graph on purpose: the
 * module graph is a statement of intent and the binary is what ships. That is
 * the same principle #37 applies to the product.
 *
 *   bun run license-gate [--binary dist/brigadier]
 *
 * The guard's own negative controls live in `test/licenses.test.ts`. A guard
 * that always passes looks identical to a working one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, isAllowed, npmComponents, pins, PROPRIETARY_MARKERS } from "./inventory.ts";

export interface GateFinding {
  check: "licences" | "markers" | "pin";
  detail: string;
}

/**
 * Scan raw binary bytes for proprietary markers.
 *
 * Exported so the negative control can drive it directly with a planted marker.
 * Latin-1 rather than UTF-8 so arbitrary binary bytes decode without throwing
 * or silently substituting; the markers themselves are ASCII apart from the
 * copyright sign, which is handled by searching the bytes for both encodings.
 */
export function scanForProprietaryMarkers(bytes: Uint8Array): GateFinding[] {
  const latin1 = Buffer.from(bytes).toString("latin1");
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const findings: GateFinding[] = [];
  for (const marker of PROPRIETARY_MARKERS) {
    if (latin1.includes(marker) || utf8.includes(marker)) {
      findings.push({
        check: "markers",
        detail: `binary contains ${JSON.stringify(marker)} — proprietary code appears to be bundled`,
      });
    }
  }
  return findings;
}

export function checkLicences(root = REPO_ROOT): GateFinding[] {
  return npmComponents(root)
    .filter((c) => !isAllowed(c.license))
    .map((c) => ({
      check: "licences" as const,
      detail: `${c.name}@${c.version} is ${c.license}, which is outside the allowlist`,
    }));
}

export function checkPin(actualBunVersion: string, root = REPO_ROOT): GateFinding[] {
  const pinned = pins(root)["bun"];
  if (pinned === actualBunVersion) return [];
  return [
    {
      check: "pin",
      detail:
        `bun ${actualBunVersion} is building, but vendor/bun-LICENSE.md is pinned to ${pinned}. ` +
        `Refresh the vendored copy from https://github.com/oven-sh/bun/blob/main/LICENSE.md ` +
        `and update vendor/pins.json, or the attribution describes a runtime that is not in the binary.`,
    },
  ];
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const binaryIndex = argv.indexOf("--binary");
  const binaryPath = binaryIndex === -1 ? join(REPO_ROOT, "dist", "brigadier") : (argv[binaryIndex + 1] ?? "");

  const findings: GateFinding[] = [...checkLicences(), ...checkPin(Bun.version)];

  if (existsSync(binaryPath)) {
    const bytes = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
    findings.push(...scanForProprietaryMarkers(bytes));
    console.log(`scanned ${binaryPath} — ${(bytes.byteLength / 1_048_576).toFixed(1)} MB`);
  } else if (argv.includes("--require-binary")) {
    // Used by CI. A skipped check is not a passing check, so the release path
    // refuses to treat "no binary here" as "the binary is clean".
    findings.push({
      check: "markers",
      detail: `${binaryPath} does not exist and --require-binary was given; the marker scan did not run`,
    });
  } else {
    console.log(`no binary at ${binaryPath} — marker scan SKIPPED (not passed). Run \`bun run build\` first.`);
  }

  if (findings.length > 0) {
    console.error("\nLICENCE GATE FAILED — ruling 47\n");
    for (const f of findings) console.error(`  [${f.check}] ${f.detail}`);
    console.error("");
    process.exit(1);
  }

  console.log("licence gate passed");
}
