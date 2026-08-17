// SPDX-License-Identifier: Apache-2.0
/**
 * The competence table's schema, and the rules that keep it auditable.
 *
 * Ruling 68. Decision 10 accepts the maintenance burden and requires that the
 * auditability "must not depend on line anchors" — because v1's `METHODOLOGY.md`
 * existed solely to be checkable by someone who does not trust its author,
 * carried 44 `src/file.ts:N` anchors, and **a single comment-only sweep
 * invalidated 8 while 4 were already wrong before that.** An anchor that breaks
 * on an unrelated edit defeats the document's entire purpose.
 *
 * The fix is the one #38 already built for ruling citations: **cite by stable
 * IDENTITY, never by location.** A ticket number, a benchmark name with its
 * version and the date it was read, a URL with a read date — all survive an
 * edit to the file they describe. A line number does not.
 *
 * DELIBERATELY NOT AN EVIDENCE CLASS: local outcomes. Decision 22 is explicit
 * that the learning loop calibrates cost predictions ONLY and must never
 * influence competence rankings, and ruling 66 turned that into a gate. A
 * prediction is falsifiable by measurement; a competence score is editorial, and
 * decision 10 keeps it hand-maintained on purpose.
 */

/**
 * What backs a score. Rendered WITH the score, never in a footnote — a reader
 * seeing `claude: 90` cannot tell whether that was measured or invented.
 */
export type EvidenceClass =
  /** A measurement in this repository. Cites the ticket that made it. */
  | "measured"
  /** A published benchmark. Cites name, version and the date it was read. */
  | "benchmark"
  /** A published vendor capability claim. Cites a URL and a read date. */
  | "vendor"
  /** The maintainer's judgement, with a one-line reason. Decision 10's default. */
  | "editorial";

/**
 * A row may not mix classes: if a score is part measured and part judgement it
 * is `editorial`, because the weakest input governs. Same rule as ruling 52's
 * blocking outcomes — the strongest label a mixed thing may carry is its
 * weakest part.
 */
export const CLASS_STRENGTH: Record<EvidenceClass, number> = {
  measured: 3,
  benchmark: 2,
  vendor: 1,
  editorial: 0,
};

export function governingClass(classes: readonly EvidenceClass[]): EvidenceClass {
  return classes.reduce(
    (weakest, c) => (CLASS_STRENGTH[c] < CLASS_STRENGTH[weakest] ? c : weakest),
    "measured" as EvidenceClass,
  );
}

export interface CompetenceRow {
  agent: string;
  model: string;
  role: string;
  /** Editorial by decision 10. Ranks; never compared against anything numeric. */
  score: number;
  evidence: EvidenceClass;
  /** A stable identifier. Never a line anchor — see `citationProblems`. */
  citation: string;
}

/**
 * A citation must survive an edit to whatever it describes.
 *
 * This is v1's defect written as a predicate. `src/router.ts:120` is the shape
 * that rotted; `#45`, `FrontierCode v2 (read 2026-08-17)` and a URL with a read
 * date are the shapes that do not.
 */
export function citationProblems(row: CompetenceRow): string[] {
  const problems: string[] = [];
  if (/[\w/.-]+\.(ts|js|md):\d+/.test(row.citation)) {
    problems.push(
      `${row.agent}/${row.model}: citation "${row.citation}" is a line anchor — v1 lost 8 of 44 to one comment-only sweep`,
    );
  }
  if (row.citation.trim() === "") {
    problems.push(`${row.agent}/${row.model}: no citation`);
  }
  if (row.evidence !== "editorial" && !/\d/.test(row.citation)) {
    // A ticket number, a version, or a date. An `editorial` row cites a reason
    // rather than a source, so it is exempt.
    problems.push(
      `${row.agent}/${row.model}: ${row.evidence} citation "${row.citation}" carries no ticket, version or date`,
    );
  }
  return problems;
}

/**
 * How a score renders. The class is part of the string, per ruling 52 — a
 * qualifier in a footnote is a qualifier nobody reads.
 */
export function renderRow(row: CompetenceRow): string {
  return `${row.agent}/${row.model} ${row.role}: ${row.score} (${row.evidence}: ${row.citation})`;
}

/**
 * Ruling 68: an unranked model is NOT excluded.
 *
 * It is eligible and sorts last, and the report names it. Silent exclusion is
 * v1's finding-87 shape — a model scored 85 was silently excluded from every
 * `hard` item — and a router that refuses what it has not heard of excludes
 * every new model forever.
 *
 * NOTE THE DELIBERATE ASYMMETRY WITH RULING 53, which says an unmeasured
 * CAPABILITY does not satisfy a requirement. These point opposite ways on
 * purpose: **a capability is a permission and fails closed; a ranking is a
 * preference and fails open.** Refusing an unmeasured capability protects the
 * operator; refusing an unranked model protects nobody and silently freezes the
 * fleet. A later refactor that "unifies" them would break one of the two.
 */
export const UNRANKED = Number.NEGATIVE_INFINITY;

export function rank(rows: readonly CompetenceRow[], known: ReadonlySet<string>): CompetenceRow[] {
  return [...rows].sort((a, b) => {
    const sa = known.has(`${a.agent}/${a.model}`) ? a.score : UNRANKED;
    const sb = known.has(`${b.agent}/${b.model}`) ? b.score : UNRANKED;
    return sb - sa;
  });
}
