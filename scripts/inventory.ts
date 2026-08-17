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
 *            Ruling 5's runtime statically links JavaScriptCore/WebKit (LGPL-2)
 *            and tinycc (LGPL-2.1) among ~25 others, so this population is
 *            non-empty even with zero npm dependencies. Its licence text is a
 *            verbatim upstream copy under `vendor/`, pinned to a toolchain
 *            version the gate verifies.
 *
 * This module is deliberately in `scripts/` and NOT imported by `src/`. It
 * carries proprietary marker strings for the gate, and anything it touches
 * would end up inside the very binary it is meant to police.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/** Read a package's licence text from whichever of the conventional filenames it used. */
function readLicenseText(packageDir: string): string {
  for (const name of LICENSE_FILENAMES) {
    const path = join(packageDir, name);
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
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

/**
 * Components `bun --compile` embeds that appear in no package manifest.
 *
 * There is exactly one entry today and it is a large one: the Bun runtime, and
 * through it JavaScriptCore/WebKit and every library Bun statically links.
 */
export function runtimeComponents(root = REPO_ROOT): Component[] {
  const bunVersion = pins(root)["bun"];
  if (!bunVersion) throw new Error("vendor/pins.json declares no `bun` pin");

  const licenseText = readFileSync(join(root, "vendor", "bun-LICENSE.md"), "utf8").trim();

  return [
    {
      name: "bun",
      version: bunVersion,
      license: "MIT",
      licenseText,
      copyright: "Copyright (c) Oven Technologies, Inc. and contributors",
      origin: "runtime",
      reason:
        "ruling 5 compiles with `bun --compile`, which embeds the Bun runtime and everything it " +
        "statically links — including JavaScriptCore/WebKit (LGPL-2) and tinycc (LGPL-2.1)",
    },
  ];
}

export function allComponents(root = REPO_ROOT): Component[] {
  return [...runtimeComponents(root), ...npmComponents(root)];
}

/** Sanity check used by both the generator and the gate. */
export function isAllowed(license: string): boolean {
  return (ALLOWED_LICENSES as readonly string[]).includes(license);
}

/** Directory listing helper kept here so the gate and generator agree on what `vendor/` holds. */
export function vendoredLicenseFiles(root = REPO_ROOT): string[] {
  return readdirSync(join(root, "vendor")).filter((f) => f.endsWith("-LICENSE.md"));
}
