// SPDX-License-Identifier: Apache-2.0
/**
 * The one rule this directory enforces on itself.
 *
 * `bar/` may import nothing from `src/`. A harness built out of the product's
 * own modules shares the product's bugs and cannot detect them — and this is not
 * a hypothetical: `BAR.md` opens by recording that v1's worst defect survived
 * 740 tests, four gates, two adversarial review lenses and twenty-two work
 * orders, and was found only by pushing to CI. Every one of those checks was
 * assembled from the same modules as the thing under test.
 *
 * Written here rather than reused from `scripts/forbidden-imports.ts` for the
 * same reason: a rule that says "share nothing with the code under test" should
 * not be implemented by sharing code with it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => m[1] ?? "");
}

/**
 * Does this specifier reach into `src/`?
 *
 * Both spellings are caught, because they are different mistakes and only one of
 * them looks wrong: a relative climb (`../src/…`, `../../src/…`) and a rooted
 * one (`src/…`, `@/src/…`). A check that only knew the first would pass a file
 * that took the second.
 */
export function reachesIntoSrc(specifier: string): boolean {
  const normalised = specifier.split("\\").join("/");
  return /(^|\/)src\//.test(normalised);
}

export interface ImportViolation {
  file: string;
  specifier: string;
}

export function violations(files: ReadonlyMap<string, string>): ImportViolation[] {
  const found: ImportViolation[] = [];
  for (const [file, source] of files) {
    for (const specifier of importSpecifiers(source)) {
      if (reachesIntoSrc(specifier)) found.push({ file, specifier });
    }
  }
  return found;
}

/** Every `.ts` file under `root`, keyed by its path relative to `root`. */
export function typescriptFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === "node_modules") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts")) {
        files.set(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"));
      }
    }
  };
  walk(root);
  return files;
}

/** Ruling 47: the first line, after a shebang where there is one. */
export const SPDX_LINE = "// SPDX-License-Identifier: Apache-2.0";

export function hasSpdxHeader(source: string): boolean {
  const lines = source.split("\n");
  const first = lines[0]?.startsWith("#!") ? lines[1] : lines[0];
  return first?.trim() === SPDX_LINE;
}
