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
 * Seven checks, all against the REAL artifact where they can be:
 *
 *   1. licences   every npm component in the production closure is allowlisted
 *   2. markers    the compiled binary contains no proprietary marker string
 *   3. pin        the `bun` that built it matches the vendored attribution
 *   4. revision   that `bun`'s own git revision matches the pin the LGPL
 *                 revisions were derived from, so the chain is not assumed
 *   5. lgpl-pin   every statically-linked LGPL library is pinned, to a real
 *                 revision, under its own name
 *   6. carried    the attribution the documents CLAIM is in the binary is
 *                 actually in the binary's bytes
 *   7. doc        RELINKING.md and vendor/pins.json name the same revisions,
 *                 in both directions
 *
 * Checks 2 and 6 inspect the binary rather than the module graph on purpose: the
 * module graph is a statement of intent and the binary is what ships. That is
 * the same principle #37 applies to the product.
 *
 * Check 6 is ruling 72's. `brigadier licenses --full` was MEASURED on 2026-08-17
 * carrying 0 hits for "GNU Lesser" and 0 for "GNU Library General Public" while
 * `strings dist/brigadier` carried 879 for "JavaScriptCore" — an LGPL library
 * shipped with no copy of its licence, which §6 requires unconditionally. Ruling
 * 62(g)'s staleness class, in the one file where being wrong is a licence
 * exposure rather than a bug: the document said the obligation was discharged.
 * A generator can only promise; this check is what makes the promise true of the
 * artifact.
 *
 * ─────────────── A LANDMINE IN THIS FILE, WRITTEN DOWN WHERE IT IS ───────────
 *
 * **This source file contains a NUL byte** — it is inside the `"\x00 the licence
 * text is missing entirely"` needle in `fingerprintsFor`, which is deliberate:
 * that string must never match anything in a real licence text. The consequence
 * is not deliberate. `file(1)` calls this file `data`, and every tool that skips
 * binary files by default — plain `grep`, and any wrapper passing `-I` — reports
 * **zero matches** here rather than an error. A search for `--require-binary`
 * across `scripts/` silently returns nothing and reads exactly like "the code is
 * not there". Use `grep -a`. A silent zero-match is the shape this repository
 * keeps being caught by, so it is recorded beside the byte that causes it.
 *
 *   bun run license-gate [--binary dist/brigadier]
 *
 * The guard's own negative controls live in `test/licenses.test.ts`. A guard
 * that always passes looks identical to a working one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  allComponents,
  isAllowed,
  npmComponents,
  pins,
  PROPRIETARY_MARKERS,
  type Component,
} from "./inventory.ts";

export interface GateFinding {
  check: "licences" | "markers" | "pin" | "revision" | "lgpl-pin" | "carried" | "doc";
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

/**
 * The `bun` that is building is the `bun` the LGPL revisions were read out of.
 *
 * Version alone is not enough for ruling 72's purpose. The WebKit and tinycc
 * revisions in `vendor/pins.json` were read out of ONE commit of oven-sh/bun —
 * the one its `bun-v1.3.14` tag points at — and `bun --revision` is what says
 * whether the binary now building came from that same commit. Without this, the
 * offer names revisions that some other build of the same version number might
 * never have contained.
 */
export function checkRevisionPin(actualRevision: string, root = REPO_ROOT): GateFinding[] {
  const pinned = pins(root)["bun-revision"];
  if (pinned === undefined) {
    return [
      {
        check: "revision",
        detail:
          "vendor/pins.json declares no `bun-revision`. The WebKit and tinycc revisions are derived " +
          "from a specific oven-sh/bun commit, and without pinning it the derivation cannot be checked.",
      },
    ];
  }
  if (pinned === actualRevision) return [];
  return [
    {
      check: "revision",
      detail:
        `bun revision ${actualRevision} is building, but vendor/pins.json pins ${pinned}. ` +
        "The LGPL source offer names revisions read out of the pinned commit's build scripts, so a " +
        "different commit means the offer may describe a WebKit and a tinycc that are not in this binary. " +
        "Re-read scripts/build/deps/{webkit,tinycc}.ts at the new commit and update the pins together.",
    },
  ];
}

const FORTY_HEX = /^[0-9a-f]{40}$/;

/**
 * Every statically-linked LGPL library is pinned, under its own name.
 *
 * "Under its own name" is the part that is easy to get wrong and impossible to
 * spot by reading: `bar/items/10-the-artifact-ships.ts` records a first draft of
 * the bar's own pin check passing on a 40-hex that belonged to a Tigerbeetle URL
 * and pinned nothing about WebKit at all. A pin that names the wrong library is
 * worse than none, because it looks like diligence.
 */
export function checkLgplPins(components: Component[], pinned: Record<string, string>): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const c of components) {
    if (!c.lgpl) continue;
    const key = c.pinKey;
    if (key === undefined) {
      findings.push({ check: "lgpl-pin", detail: `${c.name} is an LGPL library with no pinKey` });
      continue;
    }
    if (key !== c.name) {
      findings.push({
        check: "lgpl-pin",
        detail: `${c.name} is pinned under the key ${JSON.stringify(key)} — a pin must name the library it pins`,
      });
    }
    const revision = pinned[key];
    if (revision === undefined) {
      findings.push({
        check: "lgpl-pin",
        detail: `${c.name} has no entry in vendor/pins.json; an unpinned source offer is not an offer (ruling 72)`,
      });
      continue;
    }
    if (!FORTY_HEX.test(revision)) {
      findings.push({
        check: "lgpl-pin",
        detail: `${c.name} is pinned to ${JSON.stringify(revision)}, which is not a 40-character revision`,
      });
    }
    if (!c.version.includes(revision)) {
      findings.push({
        check: "lgpl-pin",
        detail: `${c.name}'s version ${JSON.stringify(c.version)} does not carry its pin ${revision}`,
      });
    }
  }
  if (components.some((c) => c.lgpl) === false) {
    findings.push({
      check: "lgpl-pin",
      detail:
        "no component declares an `lgpl` block. `bun --compile` statically links JavaScriptCore and " +
        "tinycc into every artifact (ruling 72), so an inventory with no LGPL component is an inventory " +
        "that has stopped describing the binary.",
    });
  }
  return findings;
}

/**
 * A claim the attribution makes, and the exact bytes that make it true.
 *
 * Single-line and free of anything JSON escapes, because the manifest reaches
 * the binary as a JSON-encoded string literal: a needle containing a tab, a
 * quote, a backslash or a newline would be present in the output and absent
 * from the bytes, and the check would fail for a reason that has nothing to do
 * with attribution.
 */
export interface Fingerprint {
  label: string;
  needle: string;
}

export function isSearchableNeedle(needle: string): boolean {
  return needle.length >= 24 && !/["\\\t\n\r]/.test(needle);
}

/**
 * The form a non-ASCII character takes inside the compiled artifact.
 *
 * MEASURED against `bun build --compile` 1.3.14 on 2026-08-17: the bundler
 * writes string literals with non-ASCII characters ESCAPED. `dist/brigadier`
 * contains `LGPL’d` and `—`, and contains the raw UTF-8 bytes of
 * neither. Both forms are searched because that is a property of the compiler
 * rather than of the licence, and it could change under us.
 */
export function escapeNonAscii(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 128 ? ch : `\\u${code.toString(16).padStart(4, "0")}`;
    })
    .join("");
}

/**
 * Is this text in these bytes?
 *
 * Searched as BYTES, not as a decoded string, and in both the raw and the
 * escaped form. The attribution contains a curly apostrophe and several em
 * dashes — Bun's own licence file says "LGPL’d library" — and the first draft
 * of this check reported the text missing from a binary that contained it,
 * which is the failure mode that gets guards deleted rather than fixed.
 */
export function containsText(haystack: Buffer, needle: string): boolean {
  if (haystack.indexOf(Buffer.from(needle, "utf8")) !== -1) return true;
  const escaped = escapeNonAscii(needle);
  return escaped !== needle && haystack.indexOf(Buffer.from(escaped, "utf8")) !== -1;
}

/**
 * What each component's shipped text must prove it carries.
 *
 * Derived from the text rather than hardcoded, so that a component whose licence
 * changes brings its own new fingerprints with it, and a component whose text
 * silently emptied brings none — which is itself a finding, handled below.
 */
export function fingerprintsFor(c: Component): Fingerprint[] {
  const lines = c.licenseText
    .split("\n")
    .map((l) => l.trim())
    .filter(isSearchableNeedle);
  const findLine = (label: string, pattern: RegExp): Fingerprint | undefined => {
    const line = lines.find((l) => pattern.test(l));
    return line ? { label, needle: line } : undefined;
  };

  const out: Fingerprint[] = [];
  if (c.lgpl) {
    // §6: "You must supply a copy of this License." These are the lines that
    // say a copy is really there — a title, and a line of body text that no
    // summary of the licence would contain.
    const title = findLine(`${c.name} licence title`, /GENERAL PUBLIC LICENSE/);
    const body = findLine(`${c.name} licence body`, /^(?:This library is free software|Everyone is permitted to copy)/);
    const status = findLine(`${c.name} source-offer status`, /NOT YET DISCHARGED|discharged/);
    for (const fingerprint of [title, body, status]) if (fingerprint) out.push(fingerprint);
    if (!title || !body) {
      out.push({ label: `${c.name} licence text`, needle: "  the licence text is missing entirely" });
    }
    out.push({ label: `${c.name} pinned revision`, needle: c.version });
  }
  // Every component, LGPL or not: the longest line it ships. Deterministic, and
  // it costs nothing to prove that the bulk of a licence really made it in.
  const longest = [...lines].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
  if (longest) out.push({ label: `${c.name} longest licence line`, needle: longest });
  return out;
}

/**
 * Does the compiled artifact carry the attribution the documents claim?
 *
 * This is the check ruling 47's gate models and ruling 72 extends: assert on the
 * artifact's bytes, not on the generator's intent. `THIRD-PARTY.md` and
 * `licenses --check` can agree with each other perfectly while the binary
 * carries none of it.
 */
export function checkAttributionCarried(bytes: Uint8Array, components: Component[]): GateFinding[] {
  const haystack = Buffer.from(bytes);
  const findings: GateFinding[] = [];
  for (const c of components) {
    const fingerprints = fingerprintsFor(c);
    if (fingerprints.length === 0) {
      findings.push({
        check: "carried",
        detail: `${c.name} ships no attribution text at all, so there is nothing to find in the binary`,
      });
      continue;
    }
    for (const { label, needle } of fingerprints) {
      if (!containsText(haystack, needle)) {
        findings.push({
          check: "carried",
          detail:
            `the binary does not contain ${label}: ${JSON.stringify(needle.slice(0, 60))}. ` +
            "The attribution says this is in the artifact and it is not — regenerate with `bun run licenses` and rebuild.",
        });
      }
    }
  }
  return findings;
}

/**
 * The document and the binary name the same revisions.
 *
 * `THIRD-PARTY.md` is the surface a reader with the repository sees and the
 * binary is the surface a reader with only the artifact sees. Ruling 72 requires
 * the offer to be reachable from the binary, so a revision that appears only in
 * the file is a promise made to the wrong audience.
 */
export function checkDocumentAgreesWithBinary(markdown: string, bytes: Uint8Array): GateFinding[] {
  const haystack = Buffer.from(bytes);
  const findings: GateFinding[] = [];
  for (const revision of new Set(markdown.match(/\b[0-9a-f]{40}\b/g) ?? [])) {
    if (!containsText(haystack, revision)) {
      findings.push({
        check: "carried",
        detail:
          `THIRD-PARTY.md names revision ${revision}, which is absent from the binary. Ruling 26 delivers a ` +
          "bare binary; a pin only the repository knows about is not reachable by the recipient who needs it.",
      });
    }
  }
  return findings;
}

/**
 * `RELINKING.md` and `vendor/pins.json` name the same revisions.
 *
 * `RELINKING.md` is hand-written — it is the one file in this slice that is not
 * generated, because its content is provenance and judgement rather than data —
 * and a hand-written document that quotes a revision is exactly ruling 62(g)'s
 * staleness class. Both directions are checked: a pin the document has never
 * heard of is an undocumented pin, and a revision in the document that is not
 * pinned anywhere is a revision someone will copy.
 */
export function checkDocPins(doc: string, pinned: Record<string, string>): GateFinding[] {
  const findings: GateFinding[] = [];
  const inDoc = new Set(doc.match(/\b[0-9a-f]{40}\b/g) ?? []);
  const revisions = new Set(Object.values(pinned).filter((v) => FORTY_HEX.test(v)));
  for (const revision of revisions) {
    if (!inDoc.has(revision)) {
      findings.push({
        check: "doc",
        detail: `vendor/pins.json pins ${revision}, which RELINKING.md never mentions — the provenance of a pin belongs beside it`,
      });
    }
  }
  for (const revision of inDoc) {
    if (!revisions.has(revision)) {
      findings.push({
        check: "doc",
        detail: `RELINKING.md names revision ${revision}, which is not pinned in vendor/pins.json — a stale revision in a document is one someone will copy`,
      });
    }
  }
  return findings;
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const binaryIndex = argv.indexOf("--binary");
  const binaryPath = binaryIndex === -1 ? join(REPO_ROOT, "dist", "brigadier") : (argv[binaryIndex + 1] ?? "");

  const components = allComponents();
  const findings: GateFinding[] = [
    ...checkLicences(),
    ...checkPin(Bun.version),
    ...checkRevisionPin(Bun.revision),
    ...checkLgplPins(components, pins()),
    ...checkDocPins(readFileSync(join(REPO_ROOT, "RELINKING.md"), "utf8"), pins()),
  ];

  if (existsSync(binaryPath)) {
    const bytes = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
    findings.push(...scanForProprietaryMarkers(bytes));
    findings.push(...checkAttributionCarried(bytes, components));
    findings.push(
      ...checkDocumentAgreesWithBinary(readFileSync(join(REPO_ROOT, "THIRD-PARTY.md"), "utf8"), bytes),
    );
    const carried = components.flatMap(fingerprintsFor).length;
    console.log(
      `scanned ${binaryPath} — ${(bytes.byteLength / 1_048_576).toFixed(1)} MB, ` +
        `${carried} attribution fingerprint(s) looked for in its bytes`,
    );
  } else if (argv.includes("--require-binary")) {
    // Used by CI. A skipped check is not a passing check, so the release path
    // refuses to treat "no binary here" as "the binary is clean".
    findings.push({
      check: "markers",
      detail: `${binaryPath} does not exist and --require-binary was given; the marker scan did not run`,
    });
    findings.push({
      check: "carried",
      detail:
        `${binaryPath} does not exist and --require-binary was given; nothing verified that the LGPL ` +
        "licence text this repository claims to ship is in any artifact",
    });
  } else {
    console.log(`no binary at ${binaryPath} — marker and attribution scans SKIPPED (not passed). Run \`bun run build\` first.`);
  }

  if (findings.length > 0) {
    console.error("\nLICENCE GATE FAILED — ruling 47\n");
    for (const f of findings) console.error(`  [${f.check}] ${f.detail}`);
    console.error("");
    process.exit(1);
  }

  console.log("licence gate passed");
}
