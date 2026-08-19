// SPDX-License-Identifier: Apache-2.0
/**
 * What this binary is, so that a number measured against it can be attributed.
 *
 * THE DEFECT THIS EXISTS FOR. The warm-start figure for this artifact has now
 * been recorded four times — 11.29 ms, 16.13 ms, 13.99 ms, and a contended
 * reading taken on a loaded machine — and **nothing tied any figure to any
 * artifact**. The three quiet-machine readings sit in `bar/items/10` next to
 * each other looking like a series, and they are not one: the artifact was not
 * held constant across them, and no record said what it was at any point. A
 * measurement whose subject is unnamed cannot be compared with anything, cannot
 * be reproduced, and cannot be argued with. That is a measurement-integrity
 * defect and not a cosmetic one, and this module is the fix: every artifact
 * carries a name, and `brigadier version` prints it.
 *
 * FOUR FACTS, AND WHY EACH ONE.
 *
 *   `commit`         the source the artifact was compiled from. Without it the
 *                    only thing a figure identifies is a filename.
 *   `tree`           whether that source was the commit. `clean` means the
 *                    commit fully determines the bytes; `dirty` means it does
 *                    NOT, and a reading taken against a dirty artifact is
 *                    attributable to a machine at a moment and to nothing else.
 *                    Printed rather than suppressed for exactly that reason.
 *   `bun`            the compiler. Ruling 5 compiles with `bun --compile`, so
 *                    the bun that built is part of what shipped — most of the
 *                    artifact IS bun — and `bun-revision` pins which build of
 *                    that version number, which `vendor/pins.json` already
 *                    treats as a distinct fact from the version.
 *   `binary-sha256`  the bytes themselves. The first three describe a build;
 *                    only this one identifies an artifact, and it is the field
 *                    an outside checker can recompute without trusting a word
 *                    of the other three.
 *
 * THE SELF-HASH IS COMPUTED AT RUN TIME, NOT EMBEDDED. A file cannot contain
 * its own digest — writing it in changes it. So the digest is taken of
 * `process.execPath` when it is asked for, which under `bun --compile` is the
 * standalone executable that is running.
 *
 * WHAT THAT DIGEST PROVES, AND WHAT IT DOES NOT. It proves exactly one thing:
 * **the process you ran is the file that was hashed.** It is not a signature and
 * it is not a witness to the other three fields. An earlier draft of this
 * comment said a stamp copied forward from an earlier build "does not survive
 * contact with the artifact", and that was FALSE, demonstrated rather than
 * argued: a copy of `dist/brigadier` with one byte of its usage string patched
 * and re-signed with `codesign -f -s -` reported the original `commit=…` and
 * `tree=dirty` beside the TAMPERED file's own true digest, and every check in
 * `bar/items/10` passed. The commit and the tree state are assertions by
 * whoever compiled, and nothing in a bare binary can check them.
 *
 * The digest still earns its place, against four things it does defeat: a
 * version surface that is absent or broken; a digest that is hardcoded or
 * fabricated rather than computed; a future regression that stamps the digest at
 * compile time (it would then name the PREVIOUS build and the check goes red);
 * and a report stitched together from two different binaries, where a figure
 * timed against one artifact is printed beside another's identity. Detecting a
 * false `commit` needs a signature over the stamp by whoever built, which this
 * does not have and does not claim.
 *
 * IT IS NEVER COMPUTED ON THE HOT PATH. Hashing tens of megabytes costs far
 * more than this binary's entire start-up, and item 10 grades start-up. So
 * nothing here runs at import: this module evaluates to function declarations,
 * and the digest is read only by the `version` command that prints it.
 *
 * ───────────────────────── THE REPRODUCIBILITY TRADE-OFF ─────────────────────
 *
 * Embedding a changing value in an artifact is the classic way to destroy
 * byte-for-byte reproducibility, and ruling 72 leaves "the documented rebuild
 * path actually reproduces the binary" as a bar item still to be written. So
 * the trade-off is stated rather than discovered:
 *
 *   WHAT IS EMBEDDED is a pure function of (the commit, whether the tree
 *   matched it, the bun that compiled). Every one of those is already fixed by
 *   the sentence "rebuild commit X with bun Y". Rebuilding the same commit with
 *   the same bun therefore produces the same stamp and the same bytes: the
 *   rebuild path still reproduces, and the yet-to-be-written bar item is not
 *   made harder to write.
 *
 *   WHAT IS DELIBERATELY NOT EMBEDDED: a build timestamp, a hostname, a build
 *   user, a working directory, a build counter. Any one of them would make two
 *   builds of one commit differ, which is the usual reason "reproducible" fails,
 *   and none of them is needed to attribute a measurement.
 *
 *   THE COST THAT REMAINS, PLAINLY: the artifact's bytes now depend on the
 *   commit sha, so a commit that changes only a document changes the binary.
 *   "Same source tree, same binary" still holds; "same `src/`, same binary"
 *   does not, and it did before. That is the price of attribution and it is
 *   paid knowingly — the alternative is what the four unattributed timings
 *   already cost.
 *
 *   THE LICENCE GATE IS UNAFFECTED. `scripts/license-gate.ts` checks the bun
 *   that builds against `vendor/pins.json`, scans the artifact for proprietary
 *   markers, and checks that every revision `THIRD-PARTY.md` names is present in
 *   the bytes. The stamp adds no dependency, no marker, and removes no string;
 *   it adds one JSON object of six short fields.
 *
 *   WHAT THE STAMP'S `bun` FIELD IS, STATED EXACTLY. It is the `Bun.version` and
 *   `Bun.revision` of the process that ran `scripts/build.ts`, and that is only
 *   the compiler because `scripts/build.ts` spawns `process.execPath` — its own
 *   interpreter — rather than the string `"bun"`. The earlier draft spawned
 *   `"bun"`, resolved through `PATH`, and this comment claimed the gate read the
 *   same version "in the same process chain". Both were wrong: with a `bun` shim
 *   first on `PATH`, the stamp read 1.3.14 from the launching process while the
 *   shim did the compiling, and `license-gate` — which also reads its OWN
 *   `Bun.version` — could not see it either. Ruling 47's gate does not close that
 *   hole and never did; spawning `process.execPath` is what closes it, and it is
 *   a property of this file rather than of the gate.
 */

/**
 * The stamp, injected at compile time by `scripts/build.ts`.
 *
 * A bare identifier substituted by `bun build --define`, not `process.env`:
 * a define is constant-folded away before the artifact exists, so there is no
 * runtime lookup left for an environment variable to answer. An identifier a
 * caller could set is not an identity.
 *
 * `typeof` on an undeclared identifier is legal and does not throw, which is
 * what makes the un-stamped path — `bun run src/cli.ts` — safe rather than a
 * `ReferenceError`.
 */
declare const BRIGADIER_BUILD_STAMP: string | undefined;

export interface BuildStamp {
  /** The commit compiled, 40 hex. */
  commit: string;
  /** Whether the working tree matched that commit when it was compiled. */
  tree: "clean" | "dirty";
  /**
   * How many paths `git status --porcelain` listed. 0 iff `tree` is `clean`.
   *
   * INCLUDING UNTRACKED ONES, which is deliberate and has a consequence worth
   * naming: on a dirty tree this count — and therefore the stamp, and therefore
   * the artifact's bytes — moves when an unrelated scratch file appears beside
   * the source. Two builds of identical source in the same dirty checkout can
   * differ for that reason alone. On a clean checkout, which is what CI and the
   * documented rebuild path use, the count is 0 and the question does not arise.
   * Counting only tracked modifications would be tidier and would call a tree
   * with an uncommitted, compiled-in file "clean", which is the worse error.
   */
  dirty: number;
  /** `Bun.version` of the compiling bun. */
  bun: string;
  /** `Bun.revision` of it, without the version prefix — 40 hex. */
  bunRevision: string;
  /** `package.json`'s version field, for a human. */
  package: string;
}

/** The digest of an artifact's own bytes, or why there is not one. */
export interface BinaryDigest {
  path: string;
  sha256?: string;
  bytes?: number;
  problem?: string;
}

export interface BuildIdentity {
  /** `null` when this is not a stamped artifact. Never fabricated. */
  stamp: BuildStamp | null;
  /** Why there is no stamp, when there is none. */
  unstampedBecause?: string;
  /** What was found wrong with a stamp that was present but unusable. */
  problems: string[];
  digest: BinaryDigest;
}

const FORTY_HEX = /^[0-9a-f]{40}$/;
const SEMVERISH = /^\d+\.\d+\.\d+/;

/**
 * Every field the canonical line carries, by NAME.
 *
 * Exported because the assertion that matters is "which fields are missing",
 * and a count of fields is a check that passes when the wrong four are present.
 */
export const STAMP_FIELDS = ["commit", "tree", "dirty", "bun", "bunRevision", "package"] as const;

/**
 * Read a stamp, strictly, naming everything wrong with it.
 *
 * Strict on purpose: a half-parsed stamp is worse than no stamp, because it
 * renders as an identity and identifies nothing. Anything that does not validate
 * comes back as `null` with the offending field NAMED, and the caller prints
 * `unstamped` rather than a partial line.
 */
export function parseStamp(raw: string | undefined): { stamp: BuildStamp | null; problems: string[] } {
  // Absent is not malformed. No stamp at all yields no problems, so a caller can
  // tell "this was never a build" from "this was a build and the stamp is wrong",
  // which are different failures wanting different sentences.
  if (raw === undefined || raw === "") return { stamp: null, problems: [] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { stamp: null, problems: [`the stamp is not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { stamp: null, problems: ["the stamp is not an object"] };
  }
  const o = value as Record<string, unknown>;
  const problems: string[] = [];

  const commit = o["commit"];
  if (typeof commit !== "string" || !FORTY_HEX.test(commit)) {
    problems.push(`commit is ${JSON.stringify(commit)}, which is not a 40-character revision`);
  }
  const tree = o["tree"];
  if (tree !== "clean" && tree !== "dirty") {
    problems.push(`tree is ${JSON.stringify(tree)}, which is neither "clean" nor "dirty"`);
  }
  const dirty = o["dirty"];
  if (typeof dirty !== "number" || !Number.isInteger(dirty) || dirty < 0) {
    problems.push(`dirty is ${JSON.stringify(dirty)}, which is not a count`);
  } else if ((tree === "clean") !== (dirty === 0)) {
    // The two fields are one fact stated twice, and a disagreement between them
    // means the stamp was assembled rather than measured.
    problems.push(`tree is ${JSON.stringify(tree)} but ${dirty} path(s) differed — the two disagree`);
  }
  const bun = o["bun"];
  if (typeof bun !== "string" || !SEMVERISH.test(bun)) {
    problems.push(`bun is ${JSON.stringify(bun)}, which is not a version`);
  }
  const bunRevision = o["bunRevision"];
  if (typeof bunRevision !== "string" || !FORTY_HEX.test(bunRevision)) {
    problems.push(`bunRevision is ${JSON.stringify(bunRevision)}, which is not a 40-character revision`);
  }
  const pkg = o["package"];
  if (typeof pkg !== "string" || pkg === "") {
    problems.push(`package is ${JSON.stringify(pkg)}, which is not a version string`);
  }

  if (problems.length > 0) return { stamp: null, problems };
  return {
    stamp: {
      commit: commit as string,
      tree: tree as "clean" | "dirty",
      dirty: dirty as number,
      bun: bun as string,
      bunRevision: bunRevision as string,
      package: pkg as string,
    },
    problems: [],
  };
}

/** Serialise a stamp for `--define`. Key order is fixed, so the bytes are too. */
export function serialiseStamp(stamp: BuildStamp): string {
  return JSON.stringify({
    commit: stamp.commit,
    tree: stamp.tree,
    dirty: stamp.dirty,
    bun: stamp.bun,
    bunRevision: stamp.bunRevision,
    package: stamp.package,
  });
}

/** The stamp this artifact was compiled with, if it was compiled at all. */
export function embeddedStamp(): { stamp: BuildStamp | null; problems: string[] } {
  const raw = typeof BRIGADIER_BUILD_STAMP === "string" ? BRIGADIER_BUILD_STAMP : undefined;
  return parseStamp(raw);
}

/**
 * sha256 of a file, streamed.
 *
 * Streamed rather than `arrayBuffer()` because the subject is a sixty-megabyte
 * executable and there is no reason to hold all of it at once.
 */
export async function digestOf(path: string): Promise<BinaryDigest> {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    for await (const chunk of Bun.file(path).stream()) {
      const view = chunk as Uint8Array;
      hasher.update(view);
      bytes += view.byteLength;
    }
    if (bytes === 0) return { path, problem: "the file is empty, so there is nothing to identify" };
    return { path, sha256: hasher.digest("hex"), bytes };
  } catch (error) {
    return { path, problem: `could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * This artifact's identity.
 *
 * `read` is a parameter so the rendering can be tested against fabricated
 * digests without a sixty-megabyte fixture, and so a test can prove the
 * unreadable-artifact path prints a problem instead of a hash.
 */
export async function buildIdentity(
  execPath: string = process.execPath,
  read: (path: string) => Promise<BinaryDigest> = digestOf,
): Promise<BuildIdentity> {
  const { stamp, problems } = embeddedStamp();
  if (stamp === null) {
    // No digest is taken, and that is the point rather than an optimisation:
    // with no stamp there is nothing saying `process.execPath` is an artifact of
    // this repository at all — under `bun run src/cli.ts` it is a `bun` — and
    // printing that file's sha256 under the name `binary-sha256` would offer a
    // real-looking identity for something that may not be this artifact.
    return {
      stamp: null,
      unstampedBecause:
        problems.length > 0
          ? "a stamp was compiled in and it does not parse"
          : // What is OBSERVED, and nothing beyond it. An earlier draft asserted
            // this was "source running under a `bun` on PATH", which is a guess
            // and is false of a compiled artifact built by any route other than
            // `bun run build`. Which of the two this is cannot be told from here.
            "no build stamp was compiled into this executable. That is what `bun run src/cli.ts` looks like, " +
            "and it is equally what a compiled artifact built by some route other than `bun run build` looks " +
            "like; which of those this is, is not observable from inside it",
      problems,
      digest: {
        path: execPath,
        problem: "no digest was taken: without a stamp this executable is not known to be a brigadier artifact",
      },
    };
  }
  return { stamp, problems, digest: await read(execPath) };
}

/**
 * The one line everything else keys on: `BUILD-ID …`.
 *
 * One line, `field=value`, so a harness can assert on field NAMES rather than
 * on the shape of a paragraph, and so an operator can paste it beside a number
 * without deciding what to quote. The un-stamped rendering deliberately shares
 * no field with the stamped one — it carries no `commit=` at all — so a checker
 * looking for the fields cannot be satisfied by a binary that has none.
 */
export function buildIdLine(identity: BuildIdentity): string {
  const digest =
    identity.digest.sha256 === undefined
      ? `binary-sha256=unavailable binary-bytes=unavailable (${identity.digest.problem ?? "no reason given"})`
      : `binary-sha256=${identity.digest.sha256} binary-bytes=${identity.digest.bytes}`;

  if (identity.stamp === null) {
    const why = [identity.unstampedBecause, ...identity.problems].filter((p) => p !== undefined).join("; ");
    return `BUILD-ID unstamped — ${why}. No measurement may be attributed to this process.`;
  }
  const s = identity.stamp;
  return (
    `BUILD-ID commit=${s.commit} tree=${s.tree} bun=${s.bun} bun-revision=${s.bunRevision} ${digest}`
  );
}

/** The human block `brigadier version` prints, of which `buildIdLine` is the first line. */
export function renderVersion(identity: BuildIdentity): string[] {
  const lines = [buildIdLine(identity), ""];
  if (identity.stamp === null) {
    lines.push(
      "There is no build identifier here, and one has NOT been invented. Run `bun run build`;",
      "the artifact it writes carries the commit it was built from, whether that tree was dirty,",
      "the bun that compiled it, and the sha256 of its own bytes.",
    );
    if (identity.problems.length > 0) {
      lines.push("", "a stamp WAS compiled in, and it is unusable:");
      for (const problem of identity.problems) lines.push(`  ${problem}`);
    }
    return lines;
  }
  const s = identity.stamp;
  lines.push(
    `brigadier ${s.package}`,
    `  commit    ${s.commit} (${s.tree})`,
    `  compiler  bun ${s.bun}, revision ${s.bunRevision}`,
    `  artifact  ${identity.digest.path}`,
    identity.digest.sha256 === undefined
      ? `  sha256    unavailable — ${identity.digest.problem ?? "no reason given"}`
      : `  sha256    ${identity.digest.sha256} (${identity.digest.bytes} bytes)`,
    "",
  );
  if (s.tree === "dirty") {
    lines.push(
      `THIS ARTIFACT WAS BUILT FROM A DIRTY TREE — ${s.dirty} path(s) differed from ${s.commit.slice(0, 12)}.`,
      "The commit above does NOT determine these bytes, so this build cannot be reproduced from it and",
      "a measurement taken against it is attributable to the sha256 alone.",
      "",
    );
  }
  lines.push(
    "Cite this line beside any figure measured against this artifact. Four warm-start readings",
    "of this binary exist with no artifact named against any of them, and they cannot be compared.",
  );
  return lines;
}
