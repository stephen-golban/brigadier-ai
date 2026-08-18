// SPDX-License-Identifier: Apache-2.0
/**
 * Proof that a run happened, taken with `git` rather than from stdout.
 *
 * This module exists because of one reproduced finding: a fake brigadier whose
 * whole behaviour was `console.log` plus a hand-written 41-byte
 * `.git/refs/heads/brigadier/run-0001` scored 10 of 13 against this harness's
 * first draft. The ref FILE existed. Nothing behind it did.
 *
 * So nothing here reads a ref file. Every assertion goes through a real `git`
 * process run by the harness, in this order, because each step catches
 * something the previous one cannot:
 *
 *   `rev-parse`     the ref resolves to an object id at all
 *   `cat-file -t`   that object exists in the store, and is a commit
 *   `fsck`          the commit's tree and parents are reachable — this is the
 *                   one a hand-written ref file fails, and it fails loudly
 *   `merge-base`    each sha the RECORD claims for an item is a commit the
 *                   deliverable branch can actually reach
 *   `cat-file blob` the merged tree holds the exact bytes a worker was asked to
 *                   write, which are a token generated after the binary was
 *                   built and cannot be baked into it
 *
 * The last step is the load-bearing one. A liar can create a ref by doing real
 * git work — and if it does real git work with the worker's real output in it,
 * it has done the work, which is the whole point of the bar.
 *
 * THE RECORD IS AN INDEX, NOT A WITNESS. `merge-base` replaced a check that
 * searched commit SUBJECTS for the plan's string ids — the product routes items
 * by ordinal number, so that check was reading an incidental rendering, and a
 * forger satisfied it by naming its commits after the plan. Reading the record
 * is what makes the harness ask the right question; `git` is still the only
 * thing allowed to answer it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { Checks, excerpt } from "./checks.ts";
import { parseRecord, recordPathFrom, type RunRecord } from "./contract.ts";
import { RUN_MARKER_FLAG, type Flight } from "./inflight.ts";
import { exec } from "./proc.ts";

async function git(repo: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await exec(["git", ...args], { cwd: repo, timeoutMs: 120_000 });
  return { ok: result.code === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

export async function revParse(repo: string, ref: string): Promise<string | undefined> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.ok && result.out.length === 40 ? result.out : undefined;
}

export async function objectType(repo: string, sha: string): Promise<string | undefined> {
  const result = await git(repo, ["cat-file", "-t", sha]);
  return result.ok ? result.out : undefined;
}

/**
 * The check a hand-written ref cannot survive.
 *
 * `--connectivity-only` walks from every ref to every object it names. A ref
 * pointing at an object id that was never written comes back as
 * `broken link` / `missing commit`, and no amount of printing fixes it.
 */
export async function fsck(repo: string): Promise<string> {
  const result = await git(repo, ["fsck", "--no-progress", "--connectivity-only", "--strict"]);
  const noise = /dangling|notice:/i;
  const problems = `${result.out}\n${result.err}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !noise.test(l));
  return problems.join("; ");
}

export async function commitSubjects(repo: string, ref: string): Promise<string[]> {
  const result = await git(repo, ["log", "--format=%s", ref]);
  return result.ok ? result.out.split("\n").filter((l) => l.length > 0) : [];
}

/**
 * Does `ancestor` really lie in `descendant`'s history?
 *
 * `git merge-base --is-ancestor` walks the object graph and answers with an
 * exit code, so it cannot be satisfied by a name. This is how a record's claim
 * "item `alpha` landed as commit X" is put to the world: X has to be a commit
 * that the deliverable branch can actually reach.
 */
export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await exec(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repo,
    timeoutMs: 60_000,
  });
  return result.code === 0;
}

export async function commitParents(repo: string, sha: string): Promise<string[]> {
  const result = await git(repo, ["rev-list", "--parents", "-n", "1", sha]);
  return result.ok ? result.out.split(/\s+/).slice(1) : [];
}

/** Every path in a ref's tree, with its bytes. Used for content and secret scans. */
export async function treeFiles(repo: string, ref: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const listing = await git(repo, ["ls-tree", "-r", "--name-only", ref]);
  if (!listing.ok) return files;
  for (const path of listing.out.split("\n").filter((l) => l.length > 0)) {
    const blob = await git(repo, ["cat-file", "blob", `${ref}:${path}`]);
    if (blob.ok) files.set(path, blob.out);
  }
  return files;
}

export async function refList(repo: string): Promise<string[]> {
  const result = await git(repo, ["for-each-ref", "--format=%(refname)"]);
  return result.ok ? result.out.split("\n").filter((l) => l.length > 0) : [];
}

/**
 * Ruling 61: by `realpath`, never lexically — macOS's `/var` → `/private/var`
 * symlink is the whole reason the ruling says so.
 *
 * A path that does not exist still has to be resolvable, and getting that wrong
 * is not academic: a report naming a run directory that was never created is
 * precisely what a fabricating binary produces, and an early version of this
 * function let exactly that case through. `realpathSync` throws on a missing
 * path, so this resolves the nearest ancestor that DOES exist and re-appends the
 * rest.
 */
export function resolveThroughSymlinks(path: string): string {
  const parts = path.split("/");
  for (let i = parts.length; i > 0; i--) {
    const head = parts.slice(0, i).join("/") || "/";
    try {
      const real = realpathSync(head);
      const tail = parts.slice(i);
      return tail.length === 0 ? real : `${real}/${tail.join("/")}`;
    } catch {
      // Not there either; try a shorter prefix.
    }
  }
  return path;
}

export function insideTempRoot(path: string): string | undefined {
  const roots = [tmpdir(), "/tmp", process.env["TMPDIR"] ?? ""].filter((r) => r.length > 0);
  const real = resolveThroughSymlinks(path);
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(`${realRoot}/`)) return `${real} is under ${realRoot}`;
  }
  return undefined;
}

export interface RunEvidence {
  report: string;
  recordPath: string | undefined;
  recordExists: boolean;
  record: RunRecord | undefined;
  refSha: string | undefined;
  refType: string | undefined;
  fsckProblems: string;
  /**
   * Every commit the record CLAIMS for an item, put to `git` one item at a
   * time.
   *
   * Keyed by the record's own `id`. `type` is what `git cat-file -t` answered,
   * `reachable` is what `git merge-base --is-ancestor` answered against the
   * resolved integration sha. The record says which sha to look at; these two
   * fields are the world's reply, and an item asserts on the reply.
   */
  itemCommits: Map<string, { sha: string | undefined; type: string | undefined; reachable: boolean }>;
  subjects: string[];
  /** Ruling 51: integration MERGES; a chain of single-parent commits is not one. */
  mergeParents: Array<{ sha: string; parents: string[] }>;
  files: Map<string, string>;
  refsAfter: string[];
}

/** Every commit on `ref` with its parents, so the history's SHAPE can be read. */
export async function historyShape(repo: string, ref: string): Promise<Array<{ sha: string; parents: string[] }>> {
  const result = await exec(["git", "rev-list", "--parents", ref], { cwd: repo, timeoutMs: 60_000 });
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [sha = "", ...parents] = line.trim().split(/\s+/);
      return { sha, parents };
    });
}

/**
 * Everything downstream assertions need, gathered once with real `git`.
 *
 * Deliberately tolerant: every field can be absent, because a run that did not
 * happen must produce an EVIDENCED failure rather than an exception. An item
 * that throws has measured nothing.
 */
export async function gatherRunEvidence(repo: string, report: string): Promise<RunEvidence> {
  const recordPath = recordPathFrom(report);
  const recordExists = recordPath !== undefined && existsSync(recordPath);
  const record = recordExists && recordPath ? parseRecord(readFileSync(recordPath, "utf8")) : undefined;
  const ref = record?.integrationRef;
  const refSha = ref ? await revParse(repo, ref) : undefined;

  const shape = ref && refSha ? await historyShape(repo, ref) : [];

  // The record names shas; git says whether they exist and whether the
  // deliverable can reach them. Done here, once, so every item asserts on the
  // same answers.
  const itemCommits = new Map<string, { sha: string | undefined; type: string | undefined; reachable: boolean }>();
  for (const entry of record?.items ?? []) {
    const sha = typeof entry.commit === "string" && entry.commit.length > 0 ? entry.commit : undefined;
    const type = sha === undefined ? undefined : await objectType(repo, sha);
    const reachable = sha !== undefined && type === "commit" && refSha !== undefined && (await isAncestor(repo, sha, refSha));
    itemCommits.set(entry.id, { sha, type, reachable });
  }

  return {
    report,
    recordPath,
    recordExists,
    record,
    refSha,
    refType: refSha ? await objectType(repo, refSha) : undefined,
    fsckProblems: await fsck(repo),
    itemCommits,
    subjects: ref && refSha ? await commitSubjects(repo, ref) : [],
    mergeParents: shape.filter((c) => c.parents.length >= 2),
    files: ref && refSha ? await treeFiles(repo, ref) : new Map(),
    refsAfter: await refList(repo),
  };
}

export interface WorkExpectation {
  /**
   * Path → the value the merged tree must carry.
   *
   * DERIVED, never handed over. The previous version put this value in the plan
   * and then asked for it back, which reduced the whole spine to an echo plus
   * `commit-tree`; the values here are hashes of nonces that exist only inside
   * the clone.
   */
  expected: Map<string, string>;
  /** Plan item ids that must appear as commits in the integration history. */
  itemIds: string[];
  /**
   * In-flight facts, where the item sampled them. A residue can be constructed
   * at leisure; a live process tree cannot.
   */
  flight?: Flight;
  /** How many workers really had to exist. Checked against the process table. */
  expectedWorkers?: number;
}

/**
 * The positive half every item needs: a run genuinely happened.
 *
 * Without this an item like "no foreign config file changed" passes trivially,
 * because nothing ran between the two hashes. An absence that predates the run
 * proves nothing, and that was true of five items in the first draft.
 */
export function proofOfWork(e: RunEvidence, expect: WorkExpectation): Checks {
  const checks = new Checks();

  checks.expect(
    "the run names a record on disk, and it is there",
    e.recordExists && e.record !== undefined,
    `run-record: ${e.recordPath ?? "NOT NAMED in the report"}; exists: ${e.recordExists}; parsed: ${e.record !== undefined}`,
  );
  checks.expect(
    "the integration ref resolves to a real commit object",
    e.refSha !== undefined && e.refType === "commit",
    `${e.record?.integrationRef ?? "no ref named"} -> ${e.refSha ?? "unresolvable"} (git cat-file -t: ${e.refType ?? "no object"})`,
  );
  // The check a 41-byte hand-written ref file cannot pass.
  checks.expect(
    "the repository survives `git fsck --connectivity-only --strict`",
    e.fsckProblems.length === 0,
    e.fsckProblems.length === 0 ? "no broken links, no missing objects" : e.fsckProblems,
  );

  // WHAT THE RECORD SAYS, PUT TO THE WORLD.
  //
  // This check used to look for each plan item's string `id` inside a commit
  // SUBJECT. That was the "assert on a flag" mistake with more characters: a
  // subject is a rendering, the product identifies items by ordinal number, and
  // `bar/fakes/forger.ts` satisfied it for free by writing `-m "<id>:
  // integrated"` over commits it chained without cloning anything. The same
  // promise — every plan item contributed work that reached the deliverable —
  // is now read out of the record and then checked against `git`.
  const claimed = new Map((e.record?.items ?? []).map((entry) => [entry.id, entry]));
  const unaccounted = expect.itemIds.filter((id) => {
    const entry = claimed.get(id);
    return entry === undefined || entry.status !== "integrated" || !Number.isInteger(entry.number) || (entry.number ?? 0) < 1;
  });
  checks.expect(
    "the record accounts for every plan item, by the ordinal the product routes it under",
    expect.itemIds.length > 0 && unaccounted.length === 0,
    `expected ${expect.itemIds.join(", ")} integrated; record.items gave ${
      [...claimed.values()].map((i) => `${i.id}#${i.number ?? "NO NUMBER"}=${i.status}`).join(", ") || "no items at all"
    }`,
  );
  // The record hands over shas; `git cat-file -t` says whether they are commits
  // and `git merge-base --is-ancestor` says whether the deliverable can reach
  // them. Distinct, because one tip reused for every item is a chain somebody
  // wrote at leisure rather than N pieces of work that were merged.
  const landings = expect.itemIds.map((id) => ({ id, seen: e.itemCommits.get(id) }));
  const shas = landings.map((l) => l.seen?.sha).filter((s): s is string => s !== undefined);
  checks.expect(
    "each item's recorded commit is a real object the deliverable branch can reach",
    expect.itemIds.length > 0 &&
      landings.every((l) => l.seen?.type === "commit" && l.seen.reachable) &&
      new Set(shas).size === expect.itemIds.length,
    landings
      .map(
        (l) =>
          `${l.id} -> ${l.seen?.sha?.slice(0, 12) ?? "NO COMMIT RECORDED"} (git cat-file -t: ${
            l.seen?.type ?? "no object"
          }, ancestor of ${e.refSha?.slice(0, 12) ?? "no integration sha"}: ${l.seen?.reachable ?? false})`,
      )
      .join("; ") + `; distinct commits: ${new Set(shas).size} of ${expect.itemIds.length}`,
  );
  // Ruling 51: the deliverable is the SHA, not the name. A record that names a
  // branch it never published is the one-level-up form of ruling 52's "a
  // missing result rendering as a satisfied requirement".
  checks.expect(
    "the record's integrationSha is what `git rev-parse` answers in the operator's repository",
    e.record?.integrationSha !== undefined && e.refSha !== undefined && e.record.integrationSha === e.refSha,
    `record claimed ${e.record?.integrationSha ?? "NO integrationSha — the record named a branch without evidence it exists"}; ` +
      `git rev-parse ${e.record?.integrationRef ?? "<no ref>"} answered ${e.refSha ?? "nothing"}`,
  );
  // Ruling 51: integration is a MERGE of work done elsewhere, not a commit made
  // on the spot. A forger that hashes the answers and chains single-parent
  // commits produces a history with the right subjects and the wrong shape, so
  // the parents are read rather than assumed.
  checks.expect(
    "each integration commit MERGES a second parent — work done in a clone",
    e.mergeParents.length >= expect.itemIds.length &&
      e.mergeParents.every((p) => p.parents.length >= 2) &&
      e.mergeParents.every((p) => p.parents.length === new Set(p.parents).size),
    e.mergeParents.length === 0
      ? "no integration commit had more than one parent — nothing was merged in"
      : e.mergeParents.map((p) => `${p.sha.slice(0, 8)} <- ${p.parents.length} parent(s)`).join("; "),
  );

  // The bytes. These tokens are generated after the binary was built, so they
  // cannot be baked in, and they are reachable only through the object store.
  const wrong: string[] = [];
  for (const [path, token] of expect.expected) {
    const actual = e.files.get(path);
    if (actual === undefined) wrong.push(`${path}: absent from the merged tree`);
    else if (!actual.includes(token)) wrong.push(`${path}: ${excerpt(actual, 60)} does not contain ${token}`);
  }
  checks.expect(
    "the merged tree contains every worker's actual output",
    expect.expected.size > 0 && wrong.length === 0,
    wrong.length === 0
      ? `${expect.expected.size} path(s) verified with \`git cat-file blob\`: ${[...expect.expected.keys()].join(", ")}`
      : wrong.join("; "),
  );

  const runRoot = e.record?.runRoot;
  checks.expect(
    "the run directory is outside every temp root (ruling 61, by realpath)",
    runRoot !== undefined && insideTempRoot(runRoot) === undefined,
    runRoot === undefined ? "the record names no run root" : (insideTempRoot(runRoot) ?? `${runRoot} is outside /tmp and $TMPDIR`),
  );

  // The in-flight half. Everything above can be constructed at leisure by
  // something that never cloned and never spawned; none of this can.
  const flight = expect.flight;
  if (flight !== undefined) {
    const wanted = expect.expectedWorkers ?? expect.itemIds.length;
    checks.expect(
      "clones really existed while the run was in flight",
      flight.clonesSeen.size > 0,
      `${flight.samples} samples taken during the run; clone directories seen: ${[...flight.clonesSeen.keys()].join(", ") || "NONE — nothing was ever cloned"}`,
    );
    // Only clones ever OBSERVED as repositories are judged: a directory caught
    // mid-`git clone` is the sampler's luck, not the product's behaviour.
    const settled = [...flight.clonesSeen.values()].filter((c) => c.isGitRepo);
    const bad = settled.filter((c) => !c.originRemoved || !c.hasBaseRef);
    checks.expect(
      "each clone was a real git repository with `origin` removed, started from a scratch base",
      settled.length > 0 && bad.length === 0,
      settled.length === 0
        ? "no directory under the run root was ever a git repository"
        : `${settled.length} settled clone(s); non-conforming: ${bad.map((c) => `${c.path} origin-removed=${c.originRemoved} scratch-base=${c.hasBaseRef} (refs HEAD descends from: ${c.baseRefsSeen.join(", ") || "NONE"})`).join("; ") || "none"}`,
    );
    checks.expect(
      "processes carrying ruling 38's COMMAND-LINE marker really ran",
      flight.peakMarkedProcesses > 0,
      `peak processes carrying ${RUN_MARKER_FLAG}: ${flight.peakMarkedProcesses}; command lines: ${flight.markedCommandLines.slice(0, 3).join(" | ") || "none"}`,
    );
    if (wanted > 1) {
      checks.expect(
        `at least 2 clones existed CONCURRENTLY (${wanted} items fanned out)`,
        flight.peakConcurrentClones >= 2,
        `peak concurrent clone directories: ${flight.peakConcurrentClones} across ${flight.samples} samples — "N clones existed in total" is not isolation`,
      );
    }
  }

  return checks;
}

/** Bytes on disk at a path, or `undefined`. Ruling 63 reports a retained clone with both. */
export function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
