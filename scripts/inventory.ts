// SPDX-License-Identifier: Apache-2.0
/**
 * What is actually inside the shipped binary, and under what licence.
 *
 * Ruling 47 requires attribution to be GENERATED from the artifact rather than
 * hand-written, because a hand-written THIRD-PARTY that omits a newly-bundled
 * dependency looks identical to a correct one — the same failure shape as the
 * stale agent coordinates in #2/#45 and the invented `CLAUDE_ACP_*` table.
 *
 * Two populations, and they are gathered differently on purpose:
 *
 *   npm      the production dependency closure, walked from package.json.
 *            devDependencies are excluded because `bun --compile` does not
 *            bundle them — typescript and @types/bun are build-time only.
 *
 *   runtime  components `bun --compile` embeds that appear in no manifest.
 *            Ruling 5's runtime statically links JavaScriptCore/WebKit and
 *            tinycc — both LGPL — among ~25 others, so this population is
 *            non-empty even with zero npm dependencies. Each one's licence text
 *            is a verbatim upstream copy under `vendor/`, pinned to a revision
 *            the gate verifies.
 *
 * Ruling 72 added the two LGPL libraries as components in their own right
 * rather than as a sentence inside Bun's row. That is not bookkeeping: §6 makes
 * supplying a copy of THEIR licence unconditional, and a component that is only
 * described in prose has no licence text for the generator to ship or for the
 * gate to look for in the binary.
 *
 * This module is deliberately in `scripts/` and NOT imported by `src/`. It
 * carries proprietary marker strings for the gate, and anything it touches
 * would end up inside the very binary it is meant to police.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");

export interface Component {
  /** Package or component name, as a recipient would search for it. */
  name: string;
  version: string;
  /** SPDX expression where the component declares one; raw text where it does not. */
  license: string;
  /** Verbatim licence text, where the component ships one. */
  licenseText: string;
  /** Copyright holder, read from the licence text rather than assumed. */
  copyright: string | undefined;
  origin: "npm" | "runtime";
  /** Why this component is in the binary at all. */
  reason: string;
  /** Key in `vendor/pins.json` this component's version must agree with, where it has one. */
  pinKey?: string;
  /**
   * Set on the statically-linked LGPL libraries, and only on those.
   *
   * Ruling 72: §6 makes supplying a copy of the licence unconditional, and the
   * corresponding source must be offered from the same place as the binary,
   * pinned. What that means in practice is written out per library rather than
   * summarised, because the two libraries are under different versions of the
   * licence and the clause letters differ between them.
   */
  lgpl?: {
    library: string;
    upstream: string;
    licenceFile: string;
    licenceName: string;
    samePlaceClause: string;
    /**
     * Changes applied on top of the pinned revision, where there are any.
     *
     * §6a asks for the corresponding source "including whatever changes were
     * used in the work", so a patch that is not named is a gap in the offer
     * rather than a detail.
     */
    modifications?: string;
  };
}

/**
 * Licences permitted in a redistributed, signed binary.
 *
 * Permissive only. This list is the gate's whole judgement: anything outside it
 * stops the build rather than being waved through, because the failure mode of
 * a wrong licence is legal rather than functional — no test goes red, no user
 * reports it, and the defect ships signed.
 *
 * LGPL is deliberately ABSENT even though ruling 5's runtime carries it. That
 * is not an oversight: the LGPL components arrive through the toolchain, not
 * through a dependency someone added, and they are handled by the vendored
 * attribution and the pin check instead. An LGPL package appearing in the npm
 * closure would be a genuinely new fact and should stop the build.
 */
export const ALLOWED_LICENSES = [
  "Apache-2.0",
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
] as const;

/**
 * Strings that must never appear in the shipped binary.
 *
 * MEASURED against `@anthropic-ai/claude-agent-sdk` 0.3.232 on 2026-08-17: its
 * `LICENSE.md` reads "© Anthropic PBC. All rights reserved." and grants no
 * redistribution right. The Claude ACP bridge DEPENDS on it, so ruling 4's
 * vendoring would embed proprietary code — except that #4 measured the bridge
 * resolving it through `import.meta.resolve`, which fails inside `/$bunfs/` and
 * leaves it out of the bundle. Ruling 44's `CLAUDE_CODE_EXECUTABLE` shim is
 * what keeps that true, and this scan is what stops it becoming untrue quietly.
 *
 * Occurrence counts MEASURED in the 0.3.232 tarball on 2026-08-17:
 *   ANTHROPIC_BEDROCK_MANTLE_BASE_URL                     sdk.mjs 2, bridge.mjs 1
 *   ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES  sdk.mjs 1
 *
 * These are a heuristic and ruling 47 says so out loud: a minifier that renamed
 * them would blind the scan. They are chosen to be strings the SDK carries as
 * DATA (environment variable names it reads) rather than identifiers, because
 * data survives minification and identifiers do not.
 */
export const PROPRIETARY_MARKERS = [
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "© Anthropic PBC. All rights reserved.",
] as const;

const LICENSE_FILENAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "COPYING"];

/**
 * CRLF to LF, on every licence text this module reads in.
 *
 * Not cosmetic and not a comparison loosener: it is the difference between an
 * attribution artifact that is a function of the DEPENDENCIES and one that is
 * also a function of whoever checked the repository out. Git-for-Windows sets
 * `core.autocrlf=true` at SYSTEM level (this project already knows brigadier
 * only empties the GLOBAL config), so on Windows `LICENSE` and `vendor/*`
 * arrive with CRLF, and their bytes are reprinted verbatim into THIRD-PARTY.md
 * and into the compiled binary. MEASURED on 2026-08-20 by cloning this repo
 * with `-c core.autocrlf=true`: the regenerated `src/generated/licenses.ts`
 * carried 1,272 `\r` escapes inside the shipped licence strings that the
 * committed one does not — the same licences, a different artifact.
 *
 * That is why this is a legal defect and not a formatting nit. `src/cli.ts`
 * imports `LICENSES` from that generated module and `bun --compile` embeds it,
 * so those escapes are inside the binary and come back out of `brigadier
 * licenses --full` — the surface ruling 47 calls the load-bearing one, because
 * under ruling 26 the delivery is often the binary alone. A licence text that
 * changes shape depending on which machine ran the build is one nobody can
 * point at and say what the recipient received.
 *
 * Only `\r\n` is touched, which is exactly what git's own filter converts. A
 * lone CR is left alone: it is content, not a line-ending artifact. Nothing
 * else about the text is altered, so two genuinely different licence texts can
 * never normalise to the same bytes.
 *
 * `.gitattributes` makes this a no-op on a correct checkout, and it is a no-op
 * today (MEASURED 2026-08-20: zero CR bytes in either committed surface, and in
 * both npm dependencies' LICENSE files). It is here for the checkout that
 * `.gitattributes` cannot reach — one made before it existed.
 */
export function normaliseEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Read a package's licence text from whichever of the conventional filenames it used. */
function readLicenseText(packageDir: string): string {
  for (const name of LICENSE_FILENAMES) {
    const path = join(packageDir, name);
    if (existsSync(path)) return normaliseEol(readFileSync(path, "utf8")).trim();
  }
  return "";
}

/**
 * Pull the copyright holder out of licence text rather than assuming it.
 *
 * This is not cosmetic. #4's table recorded the Claude bridge as "Apache text,
 * unmodified" and so missed that it carries **Zed Industries'** copyright —
 * there are two third-party holders in ruling 4's binary, not one. Reading the
 * line is how that stops being a thing anyone has to remember.
 */
export function extractCopyright(licenseText: string): string | undefined {
  const match = licenseText.match(/^.*(?:Copyright|©)\s+(?:\(c\)\s*)?\d{4}.*$/m);
  return match?.[0]?.trim().replace(/^\s*[*#/-]*\s*/, "");
}

/** Resolve a package directory the way the module resolver would: nearest node_modules upward. */
function resolvePackageDir(name: string, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Walk the production dependency closure.
 *
 * Breadth-first from package.json's `dependencies`, following each package's
 * own `dependencies`. devDependencies are excluded at the root only — a
 * production dependency's dev dependencies are not shipped either, and npm
 * does not install them.
 */
export function npmComponents(root = REPO_ROOT): Component[] {
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };

  const found = new Map<string, Component>();
  const queue: Array<{ name: string; from: string }> = Object.keys(manifest.dependencies ?? {}).map((name) => ({
    name,
    from: root,
  }));
  const seen = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (seen.has(next.name)) continue;
    seen.add(next.name);

    const dir = resolvePackageDir(next.name, next.from);
    if (!dir) {
      throw new Error(
        `${next.name} is a production dependency but is not installed. ` +
          `Run \`bun install\` — attribution generated from a partial tree is worse than none.`,
      );
    }

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      license?: string;
      dependencies?: Record<string, string>;
    };
    const licenseText = readLicenseText(dir);

    found.set(pkg.name, {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "UNDECLARED",
      licenseText,
      copyright: extractCopyright(licenseText),
      origin: "npm",
      reason: next.from === root ? "direct dependency" : `dependency of ${next.from.split("node_modules/").pop()}`,
    });

    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dependency, from: dir });
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The pinned toolchain versions the vendored licence copies describe. */
export function pins(root = REPO_ROOT): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(root, "vendor", "pins.json"), "utf8")) as Record<string, string>;
  const { _comment, ...rest } = raw;
  void _comment;
  return rest;
}

// ---------------------------------------------------------------------------
// The licence census — ruling 72's "enumerating those files' attribution
// properly is work nobody has done".
// ---------------------------------------------------------------------------

/**
 * What a source file's header says about its licence.
 *
 * Ruling 72's second correction: JavaScriptCore is NOT uniformly LGPL, and the
 * flat "LGPL-2" label we printed understated an obligation that is ours rather
 * than upstream's — the BSD majority carries its own attribution requirement,
 * which is discharged by reproducing the copyright notices and the disclaimer,
 * not by naming a licence.
 *
 * The classifier is deliberately crude and its crudeness is stated wherever its
 * numbers are printed: it reads the first 8 KiB of each file and matches on the
 * licence's own distinctive wording. That is enough to partition a tree whose
 * headers are boilerplate, and not enough to be an opinion about any one file.
 */
export type LicenceClass =
  | "LGPL"
  | "GPL"
  | "BSD-3-Clause"
  | "BSD-2-Clause"
  | "Apache-2.0"
  | "MIT-like"
  | "unclassified";

/** How much of each file is read. Stated as a constant because the census prints it. */
export const HEADER_BYTES = 8192;

export function classifyLicenceHeader(header: string): LicenceClass {
  if (/lesser general public|library general public|\bLGPL\b/i.test(header)) return "LGPL";
  if (/GNU General Public License/i.test(header)) return "GPL";
  if (/Redistribution and use in source and binary forms/i.test(header)) {
    return /neither the name|may not be used to endorse/i.test(header) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/Apache License/i.test(header)) return "Apache-2.0";
  if (/Permission is hereby granted, free of charge/i.test(header)) return "MIT-like";
  return "unclassified";
}

/**
 * "version 2 of the License, or (at your option) any later version".
 *
 * Ruling 72's first correction. Our flat "LGPL-2" label read as the strictest
 * possible version — LGPL-2.0 has no shared-library option at all — while the
 * file headers offer the recipient 2.1 or 3. Say what the headers say, and
 * count them rather than repeating a count from somewhere else.
 */
export function saysOrLater(header: string): boolean {
  // Comment furniture is stripped before the whitespace is collapsed: the
  // phrase is wrapped across two lines in real headers, and " * " left in the
  // middle of it would read as absent.
  return /at your option\)?\s*any later version/i.test(undecorate(header).replace(/\s+/g, " "));
}

/**
 * The GCC-style exception that makes a GPL file linkable into a non-GPL work.
 *
 * Kept separate from the classifier because it is the difference between "a GPL
 * file is inside the artifact" and "a GPL file with an explicit permission to be
 * linked in is inside the artifact", and only the first of those is alarming.
 */
export function hasLinkingException(header: string): boolean {
  const flat = header.replace(/\s+/g, " ");
  return /unlimited permission to link|as a special exception|linking exception|GCC Runtime Library Exception/i.test(
    flat,
  );
}

/** Strip comment furniture so a notice can be compared and reprinted. */
function undecorate(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\*+|\*+\/|\*|\/\/|#|;|<!--|-->)?\s?/, "").trimEnd())
    .join("\n");
}

/**
 * The copyright holders named in a header, with the years removed.
 *
 * Years are dropped on purpose: the same holder appears with a dozen different
 * year lists and the attribution owed is to the holder. The `©` sign is
 * normalised to `(c)` because `PROPRIETARY_MARKERS` contains a `©` string and
 * generated attribution must never be able to trip the gate that reads it.
 */
export function holdersIn(header: string): string[] {
  const found: string[] = [];
  for (const line of undecorate(header).split("\n")) {
    // Anchored at the start of the (undecorated) line on purpose: an unanchored
    // match reads Apache-2.0's "Grant of Copyright License. Subject to the
    // terms…" as a copyright holder called "License. Subject to the terms…",
    // which it did in the first run of this census.
    const match = /^(?:Portions\s+)?Copyright\s*(?:\((?:c|C)\)|©)?\s*(?:\((?:c|C)\))?\s*([0-9][0-9,\s–-]*)?(.*)$/.exec(
      line.trim(),
    );
    if (!match) continue;
    const holder = (match[2] ?? "")
      .replace(/©/g, "(c)")
      .replace(/\s+/g, " ")
      .replace(/^[\s,.:;–-]+/, "")
      .trim();
    if (holder.length < 3) continue;
    if (/^(?:\(C\)|\(c\))/.test(holder)) continue;
    found.push(holder);
  }
  return [...new Set(found)];
}

/**
 * The BSD notice block a header carries, whitespace-normalised.
 *
 * NOT byte-verbatim, and the generated attribution says so where it prints
 * these: comment markers are stripped and runs of whitespace collapsed so that
 * the same wording reflowed into a `#` comment and a `/* *\/` comment counts
 * once. The wording itself is untouched, and the file each block was taken from
 * is printed beside it so a reader can compare against the source we pin.
 */
export function noticeIn(header: string): string | undefined {
  const flat = undecorate(header).replace(/\s+/g, " ").trim();
  const start = flat.search(/Redistribution and use in source and binary forms/i);
  if (start === -1) return undefined;
  const rest = flat.slice(start);
  const end = rest.search(/SUCH DAMAGES?\./i);
  if (end === -1) return undefined;
  const stop = rest.indexOf(".", end + 5);
  return rest.slice(0, stop === -1 ? undefined : stop + 1);
}

export interface CensusPopulation {
  path: string;
  files: number;
  byClass: Record<string, number>;
}

export interface LicenceCensus {
  /** ISO date, and the tool the walk was performed with. Never present tense. */
  measuredOn: string;
  measuredWith: string;
  repo: string;
  revision: string;
  headerBytes: number;
  populations: CensusPopulation[];
  totals: Record<string, number>;
  /**
   * Of the LGPL-classified files, how many offer "or any later version" — and
   * the ones that do NOT, by name.
   *
   * Named rather than counted because they are the files where the version a
   * recipient gets is fixed rather than elected, and there are few enough to
   * list. MEASURED at the pinned WebKit revision on 2026-08-17: five, of which
   * `WTF/wtf/text/Base64.cpp` is LGPL version 2 only and the two DateMath
   * headers are under the Mozilla tri-licence.
   */
  orLater: { lgplFiles: number; sayingOrLater: number; without: string[] };
  holders: Array<{ class: LicenceClass; holder: string; files: number }>;
  notices: Array<{ files: number; example: string; text: string }>;
  /**
   * Every file whose header names the plain GPL, listed rather than counted.
   *
   * A GPL file inside a library we statically link is the one finding in this
   * census that could change what brigadier may ship, so it is never summarised
   * into a number. MEASURED 2026-08-17: tinycc's `lib/libtcc1.c` is GPL-2.0+
   * **with an explicit linking exception** — "the Free Software Foundation
   * gives you unlimited permission to link the compiled version of this file
   * into combinations with other programs" — which is exactly the distinction a
   * bare count would have hidden.
   */
  gplFiles: Array<{ path: string; linkingException: boolean }>;
  /** Licence files for third-party code nested inside the tree, e.g. Source/WTF/LICENSE-*.txt. */
  nestedLicenceFiles: string[];
  /** What the unclassified files are, by extension, so the residue is not a mystery. */
  unclassifiedByExtension: Record<string, number>;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === ".git") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walkFiles(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * Walk a source checkout and record what its headers actually say.
 *
 * Run by hand against a checkout at the pinned revision — `bun run licenses
 * --census <checkout>` — and committed as `vendor/webkit-attribution.json`, so
 * the build stays offline and the census stays reproducible by anyone holding
 * the same revision.
 */
export function censusFromCheckout(
  sourceRoot: string,
  meta: { repo: string; revision: string; measuredOn: string; measuredWith: string; paths: string[] },
): LicenceCensus {
  const totals: Record<string, number> = {};
  const holderCounts = new Map<string, number>();
  const noticeCounts = new Map<string, { files: number; example: string }>();
  const unclassifiedByExtension: Record<string, number> = {};
  const nestedLicenceFiles: string[] = [];
  const populations: CensusPopulation[] = [];
  const gplFiles: Array<{ path: string; linkingException: boolean }> = [];
  const withoutOrLater: string[] = [];
  let lgplFiles = 0;
  let sayingOrLater = 0;

  for (const relativePath of meta.paths) {
    const byClass: Record<string, number> = {};
    const files = walkFiles(join(sourceRoot, relativePath));
    for (const file of files) {
      const shown = file.slice(sourceRoot.length + 1);
      if (/(?:^|\/)(?:LICENSE|COPYING)[^/]*$/i.test(shown)) nestedLicenceFiles.push(shown);

      const header = readFileSync(file).subarray(0, HEADER_BYTES).toString("utf8");
      const cls = classifyLicenceHeader(header);
      byClass[cls] = (byClass[cls] ?? 0) + 1;
      totals[cls] = (totals[cls] ?? 0) + 1;

      if (cls === "LGPL") {
        lgplFiles++;
        if (saysOrLater(header)) sayingOrLater++;
        else withoutOrLater.push(shown);
      }
      if (cls === "GPL") gplFiles.push({ path: shown, linkingException: hasLinkingException(header) });
      if (cls === "unclassified") {
        const ext = /\.([A-Za-z0-9_+-]+)$/.exec(shown)?.[1] ?? "(no extension)";
        unclassifiedByExtension[ext] = (unclassifiedByExtension[ext] ?? 0) + 1;
        continue;
      }

      for (const holder of holdersIn(header)) {
        const key = JSON.stringify([cls, holder]);
        holderCounts.set(key, (holderCounts.get(key) ?? 0) + 1);
      }
      const notice = noticeIn(header);
      if (notice) {
        const seen = noticeCounts.get(notice) ?? { files: 0, example: shown };
        seen.files++;
        noticeCounts.set(notice, seen);
      }
    }
    populations.push({ path: relativePath, files: files.length, byClass: sortedRecord(byClass) });
  }

  return {
    measuredOn: meta.measuredOn,
    measuredWith: meta.measuredWith,
    repo: meta.repo,
    revision: meta.revision,
    headerBytes: HEADER_BYTES,
    populations,
    totals: sortedRecord(totals),
    orLater: { lgplFiles, sayingOrLater, without: withoutOrLater.sort() },
    holders: [...holderCounts]
      .map(([key, files]) => {
        const [cls, holder] = JSON.parse(key) as [LicenceClass, string];
        return { class: cls as LicenceClass, holder: holder as string, files };
      })
      .sort((a, b) => a.class.localeCompare(b.class) || b.files - a.files || a.holder.localeCompare(b.holder)),
    notices: [...noticeCounts]
      .map(([text, seen]) => ({ files: seen.files, example: seen.example, text }))
      .sort((a, b) => b.files - a.files || a.text.localeCompare(b.text)),
    gplFiles: gplFiles.sort((a, b) => a.path.localeCompare(b.path)),
    nestedLicenceFiles: nestedLicenceFiles.sort(),
    unclassifiedByExtension: sortedRecord(unclassifiedByExtension),
  };
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** The committed censuses, keyed by the component name they describe. */
export const CENSUS_FILE = "lgpl-census.json";

export function readCensuses(root = REPO_ROOT): Record<string, LicenceCensus> {
  return JSON.parse(readFileSync(join(root, "vendor", CENSUS_FILE), "utf8")) as Record<string, LicenceCensus>;
}

/**
 * Components `bun --compile` embeds that appear in no package manifest.
 *
 * Three, and two of them are the reason this file exists. Ruling 47 handled the
 * Bun runtime and stopped there; ruling 72 records that the LGPL libraries Bun
 * statically links are components brigadier REDISTRIBUTES, and that §6 makes
 * supplying a copy of their licence unconditional — Bun's own artifacts carry
 * none (MEASURED 2026-08-17: 875 hits for "JavaScriptCore", 0 for the LGPL
 * strings), so nothing upstream discharges it for us.
 */
export function runtimeComponents(root = REPO_ROOT): Component[] {
  const pinned = pins(root);
  const bunVersion = pinned["bun"];
  if (!bunVersion) throw new Error("vendor/pins.json declares no `bun` pin");

  // Trailing whitespace only. Leading indentation is part of a verbatim licence
  // text — the FSF's own files centre their title with tabs — and trimming it
  // would make "verbatim" a slightly false word in the sentence that introduces it.
  // `normaliseEol` before trimming: these are committed files, so a Windows
  // checkout hands them over with CRLF and the LGPL texts below are reprinted
  // verbatim into the binary the gate scans.
  const read = (file: string) => normaliseEol(readFileSync(join(root, "vendor", file), "utf8")).replace(/\s+$/, "");

  return [
    {
      name: "bun",
      version: bunVersion,
      license: "MIT",
      licenseText: read("bun-LICENSE.md"),
      copyright: "Copyright (c) Oven Technologies, Inc. and contributors",
      origin: "runtime",
      reason:
        "ruling 5 compiles with `bun --compile`, which embeds the Bun runtime and everything it " +
        "statically links — including JavaScriptCore/WebKit and tinycc, both LGPL, both listed below",
      pinKey: "bun",
    },
    {
      name: "javascriptcore-webkit",
      version: `oven-sh/WebKit@${requirePin(pinned, "javascriptcore-webkit")}`,
      // Ruling 72: say what the headers say. COPYING.LIB is the GNU LIBRARY GPL
      // version 2, which has no shared-library option, but the headers offer
      // "any later version" and the census below counts how many.
      license: "LGPL-2.0-or-later, with a BSD-2-Clause/BSD-3-Clause majority (see the census below)",
      licenseText: read("javascriptcore-webkit-COPYING.LIB"),
      copyright: "Copyright (C) 1991, 1999 Free Software Foundation, Inc.; and the holders enumerated below",
      origin: "runtime",
      reason:
        "statically linked into every `bun --compile` artifact — the JS engine the binary runs on; " +
        "`bun run license-gate` fails the build unless the compiled artifact carries this licence text",
      pinKey: "javascriptcore-webkit",
      lgpl: {
        library: "JavaScriptCore (WebKit)",
        upstream: "https://github.com/oven-sh/WebKit",
        licenceFile: "Source/JavaScriptCore/COPYING.LIB",
        licenceName: "GNU LIBRARY GENERAL PUBLIC LICENSE, Version 2, June 1991",
        // LGPL-2.0 letters the "same place" clause 6c; 2.1 letters it 6d.
        samePlaceClause: "§6c of LGPL-2.0 (the same clause is §6d in LGPL-2.1)",
      },
    },
    {
      name: "tinycc",
      version: `oven-sh/tinycc@${requirePin(pinned, "tinycc")}`,
      license: "LGPL-2.1-or-later",
      licenseText: read("tinycc-COPYING"),
      copyright: "Copyright (C) 1991, 1999 Free Software Foundation, Inc.; tinycc by Fabrice Bellard and contributors",
      origin: "runtime",
      reason:
        "statically linked into every `bun --compile` artifact as the backend for `bun:ffi`'s C compiler; " +
        "MODIFIED by Bun — patches/tinycc/tcc.h.patch at tag bun-v1.3.14, READ 2026-08-17",
      pinKey: "tinycc",
      lgpl: {
        library: "tinycc",
        upstream: "https://github.com/oven-sh/tinycc",
        licenceFile: "COPYING",
        licenceName: "GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1, February 1999",
        samePlaceClause: "§6d of LGPL-2.1",
        modifications:
          "Bun MODIFIES this library: patches/tinycc/tcc.h.patch in oven-sh/bun at tag bun-v1.3.14, " +
          "READ 2026-08-17. Apply it after checking out the revision above.",
      },
    },
  ];
}

function requirePin(pinned: Record<string, string>, key: string): string {
  const value = pinned[key];
  if (value === undefined) {
    throw new Error(
      `vendor/pins.json declares no \`${key}\` pin. Ruling 72 requires the LGPL libraries to be ` +
        "pinned to the exact revision this Bun was built from; an unpinned offer is not an offer.",
    );
  }
  return value;
}

/**
 * The section each LGPL library gets, in the binary and in the file alike.
 *
 * This is brigadier's own text, not upstream's, and it says so in its first
 * line — a licence-text block that quietly contains our prose would be the same
 * category of defect this whole file exists to stop.
 *
 * It is composed ONCE and used by both renderers on purpose. `licenses --check`
 * compares the committed output against a fresh render, and the gate then
 * checks that the same words are in the compiled binary's bytes; if the two
 * surfaces were written separately they could drift, and the surface that
 * matters — the one a recipient holding only the binary can read — is the one
 * nobody would notice had gone stale.
 *
 * NOT BUILT, AND DELIBERATELY SO — the gap this section fell into on 2026-08-20.
 * The class is **a claim about the world, stated in prose, inside a generated
 * surface**. These lines asserted that the source repository was unpublished
 * ("the GitHub API returns 404"); the repository was made public and the
 * sentence went on shipping inside the binary, asserting something false on a
 * licence surface. Nothing caught it: `licenses --check` compares bytes against
 * a fresh render, so a stale sentence rendered faithfully is "current"; `claims`
 * checks ruling citations and table contiguity, not truth; no test went red and
 * no user could report it. `RELINKING.md`'s §6a row carried the same sentence
 * and drifted the same way.
 *
 * The cheap mechanical check, recorded here rather than implemented:
 *
 *   1. Declare the world-fact as a STRUCTURED CONSTANT beside this text —
 *      `{ visibility: "PUBLIC", measuredOn: "2026-08-20", measuredWith: … }` —
 *      instead of leaving it dissolved in a paragraph.
 *   2. `scripts/claims.ts` asserts OFFLINE that every prose mention, here and in
 *      `RELINKING.md`, agrees with that constant. That keeps the gate's stated
 *      rule — "Deliberately offline: a gate that needs the network is a gate
 *      that fails in the wrong way" — intact, and it is the half that catches
 *      drift BETWEEN the two documents.
 *   3. A SEPARATE, NON-BLOCKING scheduled job compares the constant to reality
 *      (`gh repo view --json visibility`) and opens a ticket when they differ.
 *      Online, so it can be wrong about the network without failing a build.
 *
 * Roughly 30 lines across this file and `claims.ts`, one test file, one workflow
 * step. Left unbuilt on purpose in the slice that made this correction, so that
 * the fix and the guard are not the same commit.
 */
function lgplSection(c: Component, census: LicenceCensus | undefined, pins: Record<string, string>): string {
  const lgpl = c.lgpl;
  if (!lgpl) return c.licenseText;
  const revision = pins[c.pinKey ?? ""] ?? "UNPINNED";
  const out: string[] = [];

  out.push(
    `brigadier's notice for ${lgpl.library} — written by brigadier, not by upstream.`,
    `The verbatim licence begins below the row of "=" signs; everything above it is ours.`,
    "",
    "WHAT IS IN THE BINARY",
    `  ${lgpl.library} is statically linked into every brigadier binary, because ruling 5`,
    "  compiles with `bun --compile` and that embeds the Bun runtime whole. You did not",
    "  install it and you cannot remove it; you are nonetheless holding a copy of it.",
    "",
    "THE REVISION THIS COPY WAS BUILT FROM",
    `  ${lgpl.upstream} @ ${revision}`,
    `  Established, not assumed: \`bun --revision\` reports ${pins["bun-revision"] ?? "(unpinned)"}, which is the`,
    `  commit oven-sh/bun's tag bun-v${pins["bun"] ?? "?"} points at; that commit's build scripts name the`,
    "  revision above. `bun run license-gate` re-checks the first link of that chain on every",
    "  build — the building bun against the pinned revision — and refuses to build if it moved.",
    "  The remaining links were READ from the primary source on 2026-08-17; RELINKING.md records",
    "  each URL, each read date, and what the chain does NOT establish.",
    "",
    "THE SOURCE OFFER — STATUS: NOT YET DISCHARGED",
    ...wrap(
      `${lgpl.samePlaceClause} asks that the Library's complete corresponding source be offered from ` +
        "the SAME PLACE as the binary. brigadier publishes no release artifacts yet, so there is no such " +
        "place, and no mirror under our control exists to point you at. This notice states that rather " +
        "than implying otherwise. What IS discharged here and now: the complete licence text below, which " +
        "§6 requires unconditionally; the exact revision above; and the rebuild path beneath. What is NOT: " +
        "a copy of that source served by us. Until the first release does that, treat this as an open " +
        "obligation — and if you need the source before then, ask, and take it from upstream at exactly " +
        "the revision above:",
      88,
    ).map((line) => `  ${line}`),
    `    git clone ${lgpl.upstream}.git ${c.name} && git -C ${c.name} checkout ${revision}`,
    "",
    "HOW TO RELINK, IF YOU WANT A DIFFERENT " + lgpl.library.toUpperCase(),
    "  1. Clone the revision above and make your changes.",
    ...(lgpl.modifications === undefined
      ? []
      : wrap(`${lgpl.modifications} A rebuild that skips it is not the build that shipped.`, 85).map(
          (line) => `     ${line}`,
        )),
    "  2. Rebuild Bun against it — upstream documents the WebKit route at",
    "     https://github.com/oven-sh/webkit, and the build scripts for both libraries live in",
    "     oven-sh/bun under scripts/build/deps/ at the tag above.",
    "  3. Rebuild brigadier with your Bun: `bun run build`. brigadier's own source — the other",
    "     half of §6a, the \"work that uses the Library\" — is licensed Apache-2.0 and ships",
    "     with this repository, and that repository is now PUBLICLY READABLE: MEASURED against",
    "     gh 2.95.0 and curl 8.7.1 on 2026-08-20, `gh repo view stephen-golban/brigadier-ai",
    "     --json visibility` reports PUBLIC and an unauthenticated GET of",
    "     https://api.github.com/repos/stephen-golban/brigadier-ai returns 200.",
    "  CORRECTED 2026-08-20. Until this date these lines said the source was \"NOT yet published:",
    "     MEASURED 2026-08-17, the GitHub API returns 404 for stephen-golban/brigadier-ai and",
    "     package.json still says \"private\": true\". That measurement was TRUE ON 2026-08-17; it",
    "     is SUPERSEDED by the one above rather than deleted, because the repository was made",
    "     public on 2026-08-20. package.json does still say \"private\": true, deliberately — that",
    "     is npm's guard against `npm publish`, a different question from whether this repository",
    "     can be read, and these lines no longer offer it as evidence of either.",
    "  WHAT THAT DOES NOT SETTLE: a readable repository is NOT a discharged §6 offer, and this",
    "     notice does not claim it is. §6 attaches to DISTRIBUTION of the binary — the source has",
    "     to reach whoever holds the binary, from the same place the binary came from. brigadier",
    "     still publishes no release artifacts, so that place still does not exist. What changed",
    "     on 2026-08-20 is only that this half of §6a can now be fetched at all; whether that",
    "     discharges anything is a legal reading, and ruling 72 gates on counsel, not on us.",
    "  NOT PROVEN: nobody has yet demonstrated that this path reproduces this binary. §6",
    "  requires the shipped form of the \"work that uses the Library\" to include the data and",
    "  utility programs needed for reproducing the executable from it; the recipe is here, a",
    "  demonstration that it works is not. Ruling 72 leaves that as a bar item still to be",
    "  written, and this notice does not claim it has been.",
    "",
  );

  if (census) out.push(...censusLines(census, lgpl.licenceFile), "");

  out.push(
    "=".repeat(76),
    `${lgpl.licenceName} — verbatim, as it appears in ${lgpl.licenceFile} at the revision above`,
    "=".repeat(76),
    "",
    c.licenseText,
  );

  if (census) out.push("", ...noticeLines(census));
  return out.join("\n");
}

/**
 * The census, rendered.
 *
 * Ruling 72 named this gap as ours rather than upstream's and left it open:
 * "enumerating those files' attribution properly is work nobody has done".
 * These lines are that enumeration, generated from a walk of the pinned source
 * rather than repeated from a summary — the previous version of this file
 * carried counts (3,523 / 187 / 3,321) that do not describe the revision we
 * actually pin, which is the same staleness class ruling 62(g) is about.
 */
function censusLines(census: LicenceCensus, licenceFile: string): string[] {
  const out: string[] = [];
  out.push(
    "WHAT THIS LIBRARY ACTUALLY IS, FILE BY FILE",
    `  MEASURED against ${census.measuredWith} on ${census.measuredOn}, by reading the first`,
    `  ${census.headerBytes} bytes of every file at ${census.revision.slice(0, 12)}:`,
    "",
  );
  for (const population of census.populations) {
    const parts = Object.entries(population.byClass).map(([cls, n]) => `${cls} ${n}`);
    out.push(`    ${population.path} — ${population.files} files: ${parts.join(", ")}`);
  }
  const bsd = (census.totals["BSD-2-Clause"] ?? 0) + (census.totals["BSD-3-Clause"] ?? 0);
  const classified = Object.entries(census.totals)
    .filter(([cls]) => cls !== "unclassified")
    .reduce((sum, [, n]) => sum + n, 0);
  const holdout = census.orLater.lgplFiles - census.orLater.sayingOrLater;
  out.push(
    "",
    ...wrap(
      `So a single licence label cannot be right for this tree. ${census.totals["LGPL"] ?? 0} files carry LGPL headers; ` +
        `${census.orLater.sayingOrLater} of those ${census.orLater.lgplFiles} offer "or (at your option) any later version", so a recipient may ` +
        `elect a later LGPL for them even though ${licenceFile} itself is not "or later"` +
        (holdout > 0
          ? `. The other ${holdout} do NOT say it, and for those the version named in the file is the one you get — ` +
            "a distinction our old flat label erased in both directions. They are:"
          : "."),
      88,
    ).map((line) => `  ${line}`),
    // `?? []` so that a census written by an older schema still renders: the
    // census is regenerated by hand from a 200 MB checkout, and a generator
    // that cannot run until the census is refreshed cannot refresh it.
    ...(census.orLater.without ?? []).map((path) => `    ${path}`),
    "",
    ...wrap(
      `${bsd} of the ${classified} classified files ${bsd === 1 ? "is" : "are"} BSD-2-Clause or BSD-3-Clause. Those carry their OWN ` +
        "attribution requirement — the copyright notice and the disclaimer must be reproduced with the " +
        "binary — and it is not discharged by naming the LGPL. Every holder and every distinct wording is " +
        "enumerated after the licence text below.",
      88,
    ).map((line) => `  ${line}`),
    "",
    "  The classifier is crude and its crudeness is the reason these numbers are printed",
    "  rather than asserted: it matches each header against the licences' distinctive",
    "  wording, in the first 8 KiB only, and it reads headers rather than build graphs — it",
    "  cannot tell you which of these files are compiled into the artifact.",
  );
  const residue = Object.entries(census.unclassifiedByExtension)
    .slice(0, 6)
    .map(([ext, n]) => `${ext === "(no extension)" ? ext : `.${ext}`} ${n}`);
  out.push(
    ...wrap(
      `${census.totals["unclassified"] ?? 0} files matched nothing (mostly ${residue.join(", ")}) and are ` +
        "listed as unclassified rather than assigned a licence by guesswork.",
      88,
    ).map((line) => `  ${line}`),
  );
  if (census.gplFiles.length > 0) {
    out.push(
      "",
      `  ${census.gplFiles.length} file(s) carry a PLAIN GPL header rather than a lesser one. They are listed`,
      "  individually because a count would hide the only thing that matters about them —",
      "  whether they carry an exception permitting them to be linked into a non-GPL work:",
    );
    for (const file of census.gplFiles) {
      out.push(`    ${file.path} — linking exception in the header: ${file.linkingException ? "YES" : "NO"}`);
    }
    if (census.gplFiles.some((f) => !f.linkingException)) {
      out.push(
        "  At least one has NO such exception in its header. Whether that file is compiled into",
        "  this binary at all is not something this census can tell you — it reads headers, not",
        "  build graphs — and it is flagged here rather than resolved.",
      );
    }
  }
  if (census.nestedLicenceFiles.length > 0) {
    out.push(
      "",
      "  Third-party code nested inside this tree ships its own licence files, which are in",
      "  the source at the pinned revision and are part of what a recipient receives:",
    );
    for (const file of census.nestedLicenceFiles) out.push(`    ${file}`);
  }
  return out;
}

/** The BSD half: every holder, and every distinct disclaimer wording. */
function noticeLines(census: LicenceCensus): string[] {
  const out: string[] = [];
  out.push(
    "=".repeat(76),
    "ATTRIBUTION FOR THE NON-LGPL MAJORITY (BSD-2-Clause and BSD-3-Clause)",
    "=".repeat(76),
    "",
    "Every copyright holder named in a licence header in the tree above, with the number of",
    `files naming them. MEASURED on ${census.measuredOn}; years are omitted because the`,
    "attribution is owed to the holder, and `(c)` is written for `©` throughout.",
    "",
  );
  let currentClass = "";
  for (const holder of census.holders) {
    if (holder.class !== currentClass) {
      currentClass = holder.class;
      out.push(`  -- ${currentClass} --`);
    }
    out.push(`  ${String(holder.files).padStart(5)}  Copyright (c) ${holder.holder}`);
  }
  out.push(
    "",
    `The ${census.notices.length} distinct notice wordings those files carry, most common first. Whitespace is`,
    "collapsed and comment markers stripped so one wording counts once; the words are",
    "untouched, and the file each was taken from is named so it can be compared verbatim",
    "against the source at the pinned revision.",
    "",
  );
  for (const notice of census.notices) {
    out.push(`  [${notice.files} file(s); e.g. ${notice.example}]`);
    for (const line of wrap(notice.text, 88)) out.push(`  ${line}`);
    out.push("");
  }
  return out;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/**
 * Every component in the artifact, with the text each one actually ships.
 *
 * The composition happens HERE rather than in the generator so that the
 * generator and the gate cannot disagree about what "the attribution" is. The
 * generator writes these bytes into two files; the gate then looks for these
 * same bytes inside the compiled binary. If the gate derived its expectations
 * from anywhere else, it could pass while the artifact carried nothing.
 */
export function allComponents(root = REPO_ROOT): Component[] {
  const pinned = pins(root);
  let censuses: Record<string, LicenceCensus> = {};
  try {
    censuses = readCensuses(root);
  } catch {
    // Absent only while a census is being generated for the first time. The
    // notice still renders — minus the file-by-file enumeration — rather than
    // the build failing on a file the build itself is about to write.
    censuses = {};
  }
  return [...runtimeComponents(root), ...npmComponents(root)].map((c) =>
    c.lgpl ? { ...c, licenseText: lgplSection(c, censuses[c.name], pinned) } : c,
  );
}

/** Sanity check used by both the generator and the gate. */
export function isAllowed(license: string): boolean {
  return (ALLOWED_LICENSES as readonly string[]).includes(license);
}
