// SPDX-License-Identifier: Apache-2.0
/**
 * Seams that must not be crossed, checked rather than remembered.
 *
 * Two of them, each from a ruling that says "keep these physically separate"
 * and would otherwise be a comment. Ruling 57's classification is the reason
 * this file exists: a rule nobody enforces is a request.
 */

export interface Seam {
  /** Files matching this may not import files matching `never`. */
  readonly from: RegExp;
  readonly never: RegExp;
  readonly why: string;
  /** True when the ban runs in both directions. */
  readonly mutual?: boolean;
}

export const SEAMS: readonly Seam[] = [
  {
    from: /^src\//,
    never: /probes\//,
    why: "probes/ are throwaway measurement scripts held to no product standard (AGENTS.md); a reach across is how an unmaintained one becomes load-bearing without anyone deciding to",
  },
  {
    // Decision 22, made mechanical by ruling 66.
    from: /^src\/(router|routing)\//,
    never: /\/cost\//,
    mutual: true,
    why: "decision 22: the learning loop calibrates cost predictions ONLY and must never influence competence rankings — a prediction is falsifiable and a competence score is editorial, and decision 10 keeps the latter hand-maintained on purpose",
  },
];

export interface Crossing {
  file: string;
  seam: Seam;
  specifier: string;
}

const IMPORT = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

export function importsIn(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => m[1]!);
}

/**
 * Every crossing in a set of files.
 *
 * `mutual` seams are checked in both directions, because "the cost store must
 * not import the router" and "the router must not import the cost store" are
 * different mistakes and only one of them reads naturally.
 */
export function crossings(files: ReadonlyMap<string, string>): Crossing[] {
  const found: Crossing[] = [];
  for (const [file, source] of files) {
    const specifiers = importsIn(source);
    for (const seam of SEAMS) {
      const forward = seam.from.test(file);
      const backward = seam.mutual === true && seam.never.test(`/${file}`);
      for (const specifier of specifiers) {
        if (forward && seam.never.test(specifier)) found.push({ file, seam, specifier });
        else if (backward && seam.from.test(specifier.replace(/^\.\.?\//, "src/"))) {
          found.push({ file, seam, specifier });
        }
      }
    }
  }
  return found;
}
