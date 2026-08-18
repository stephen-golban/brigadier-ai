// SPDX-License-Identifier: Apache-2.0
/**
 * Which files are worth the budget.
 *
 * Aider's published design, and the shape #23 confirmed: an edge runs from file
 * A to file B when A mentions an identifier B declares, and PageRank over that
 * graph puts the files other files depend on at the top. #23 measured PageRank
 * itself at **194 ms on a 2,425-file repository** — 2% of the map's cost, the
 * other 97% being tree-sitter parsing. It is not the thing to optimise.
 *
 * What is deliberately NOT here is Aider's 10x weight on identifiers mentioned
 * in the current context. Ruling 39 rejected it on measurement: #44 found it
 * fires on only 7–48% of items, moves the hit rate +0–2.5 points on four of
 * five repositories, and turns a per-run cost into an ~11 s per-item one. There
 * is no parameter on any function in this module through which an item's text
 * could enter, and that is the enforcement — a ranking that cannot see an item
 * cannot be made item-aware by a caller in a hurry.
 */

/** A file, and the identifiers it declares and mentions. */
export interface FileFacts {
  /** Repo-relative path, forward slashes. */
  readonly path: string;
  /** Identifiers this file declares as its public surface. */
  readonly declares: readonly string[];
  /** Every identifier-shaped token in the file, with repeats. */
  readonly mentions: readonly string[];
}

export interface RankedFile {
  readonly path: string;
  readonly rank: number;
}

/** PageRank's damping factor, and the iteration count. Aider's values. */
const DAMPING = 0.85;
const ITERATIONS = 20;

/**
 * Rank files by how much of the repository leans on them.
 *
 * Ties are broken by path so the map is byte-stable across runs: a map that
 * reshuffles between two identical runs is indistinguishable from one that
 * noticed a change, and ruling 16's brief is compared by eye.
 */
export function rankFiles(files: readonly FileFacts[]): RankedFile[] {
  const paths = files.map((f) => f.path);
  const index = new Map(paths.map((p, i) => [p, i]));

  /** identifier -> the files declaring it */
  const declaredIn = new Map<string, Set<string>>();
  for (const file of files) {
    for (const name of file.declares) {
      let where = declaredIn.get(name);
      if (!where) {
        where = new Set();
        declaredIn.set(name, where);
      }
      where.add(file.path);
    }
  }

  const out: Array<Map<number, number>> = paths.map(() => new Map());
  for (const file of files) {
    const from = index.get(file.path);
    if (from === undefined) continue;
    const counted = new Map<string, number>();
    for (const name of file.mentions) counted.set(name, (counted.get(name) ?? 0) + 1);
    for (const [name, count] of counted) {
      const targets = declaredIn.get(name);
      if (!targets) continue;
      for (const target of targets) {
        // A file citing its own export carries no signal about anyone else.
        if (target === file.path) continue;
        const to = index.get(target);
        if (to === undefined) continue;
        const edges = out[from];
        if (edges) edges.set(to, (edges.get(to) ?? 0) + count);
      }
    }
  }

  const n = paths.length;
  if (n === 0) return [];
  let rank = new Array<number>(n).fill(1 / n);
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const next = new Array<number>(n).fill((1 - DAMPING) / n);
    for (let i = 0; i < n; i++) {
      const edges = out[i] ?? new Map<number, number>();
      const current = rank[i] ?? 0;
      let total = 0;
      for (const weight of edges.values()) total += weight;
      if (total === 0) {
        // A file nothing links out of would otherwise be a rank sink.
        const share = (DAMPING * current) / n;
        for (let j = 0; j < n; j++) next[j] = (next[j] ?? 0) + share;
        continue;
      }
      for (const [j, weight] of edges) next[j] = (next[j] ?? 0) + (DAMPING * current * weight) / total;
    }
    rank = next;
  }

  return paths
    .map((path, i) => ({ path, rank: rank[i] ?? 0 }))
    .sort((a, b) => (b.rank - a.rank !== 0 ? b.rank - a.rank : a.path.localeCompare(b.path)));
}
