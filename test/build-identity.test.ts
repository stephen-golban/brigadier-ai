// SPDX-License-Identifier: Apache-2.0
/**
 * The build identifier, and the guards that must be able to fail.
 *
 * Round 15 of this project audited seven bar items and found all seven
 * reporting green on something they were not checking. The question every test
 * below is written to answer is therefore the same one: **would this still pass
 * if the property vanished?** So each guard is driven in both directions — the
 * truthful case, and the case where the thing it checks is absent, stale or
 * malformed.
 *
 * The identity surface has three failure modes worth naming, and one of each
 * appears below:
 *
 *   ABSENT   nothing was stamped in. The surface must say so and must NOT
 *            invent a commit, and it must not offer the hash of whatever
 *            `process.execPath` happens to be as though it were this artifact.
 *   STALE    a stamp is present and describes some other build. Only the
 *            run-time digest can catch this, which is why the digest is
 *            recomputed rather than stamped.
 *   MALFORMED a stamp is present and does not parse. Half an identity renders
 *            as an identity and identifies nothing, so it is refused whole.
 */

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildIdLine,
  buildIdentity,
  digestOf,
  parseStamp,
  renderVersion,
  serialiseStamp,
  type BuildIdentity,
  type BuildStamp,
} from "../src/build/identity.ts";
import { artifactCandidates, compileArgv, mtimeOf, readStamp, resolveArtifact } from "../scripts/build.ts";
import { resolveBinary } from "../scripts/license-gate.ts";

const COMMIT = "a".repeat(40);
const REVISION = "0d9b296af33f2b851fcbf4df3e9ec89751734ba4";
const GOOD: BuildStamp = {
  commit: COMMIT,
  tree: "clean",
  dirty: 0,
  bun: "1.3.14",
  bunRevision: REVISION,
  package: "0.0.0",
};

const fakeDigest = (sha: string) => async (path: string) => ({ path, sha256: sha, bytes: 62_914_560 });

/**
 * A stamped identity, assembled here rather than obtained from `buildIdentity`.
 *
 * `buildIdentity` can only ever be un-stamped inside `bun test` — a test process
 * is not a compiled artifact — so the stamped renderings are tested against a
 * value written out in full. That is also the honest way round: a formatter
 * checked against input its own module produced agrees with itself for free.
 */
const stamped = (stamp: BuildStamp, digest: BuildIdentity["digest"]): BuildIdentity => ({
  stamp,
  problems: [],
  digest,
});

describe("the stamp is parsed strictly, and says which field is wrong", () => {
  test("a well-formed stamp round-trips", () => {
    const { stamp, problems } = parseStamp(serialiseStamp(GOOD));
    expect(problems).toEqual([]);
    expect(stamp).toEqual(GOOD);
  });

  test("absent is not malformed — no stamp yields no complaints, and no stamp", () => {
    expect(parseStamp(undefined)).toEqual({ stamp: null, problems: [] });
    expect(parseStamp("")).toEqual({ stamp: null, problems: [] });
  });

  // NEGATIVE CONTROL, one field at a time. Each of these is a stamp that LOOKS
  // like an identity, and every one of them must be refused whole rather than
  // parsed down to the fields that happened to survive.
  const broken: [string, Record<string, unknown>, RegExp][] = [
    ["a commit that is not a revision", { commit: "HEAD" }, /^commit is/],
    ["a truncated commit", { commit: "a".repeat(39) }, /^commit is/],
    ["a tree state that is neither", { tree: "probably-clean" }, /^tree is/],
    ["a bun that is not a version", { bun: "latest" }, /^bun is/],
    ["a bun revision that is not a revision", { bunRevision: "0d9b296af" }, /^bunRevision is/],
    ["no package version", { package: "" }, /^package is/],
  ];
  for (const [what, override, complaint] of broken) {
    test(`it refuses ${what}, and names the field`, () => {
      const { stamp, problems } = parseStamp(JSON.stringify({ ...GOOD, ...override }));
      expect(stamp).toBeNull();
      // The FIELD is named. Which field it was is the whole value of the
      // complaint — "the stamp is bad" sends a reader nowhere.
      expect(problems.some((p) => complaint.test(p))).toBe(true);
    });
  }

  test("it refuses a stamp whose tree state and dirty count disagree", () => {
    const { stamp, problems } = parseStamp(JSON.stringify({ ...GOOD, tree: "clean", dirty: 4 }));
    expect(stamp).toBeNull();
    expect(problems.some((p) => p.includes("the two disagree"))).toBe(true);
  });

  test("it refuses text that is not JSON, and an array pretending to be an object", () => {
    expect(parseStamp("not json at all").stamp).toBeNull();
    expect(parseStamp("[]").stamp).toBeNull();
    expect(parseStamp("[]").problems).toEqual(["the stamp is not an object"]);
  });
});

describe("the BUILD-ID line", () => {
  test("carries the commit, the tree state, the bun and the artifact's own digest", () => {
    const line = buildIdLine(stamped(GOOD, { path: "/artifact", sha256: "b".repeat(64), bytes: 62_914_560 }));
    expect(line).toContain(`commit=${COMMIT}`);
    expect(line).toContain("tree=clean");
    expect(line).toContain("bun=1.3.14");
    expect(line).toContain(`bun-revision=${REVISION}`);
    expect(line).toContain(`binary-sha256=${"b".repeat(64)}`);
  });

  test("an unstamped process is rendered as unstamped, and carries NO commit field", async () => {
    const identity = await buildIdentity("/some/bun", fakeDigest("c".repeat(64)));
    const line = buildIdLine(identity);
    // The negative control that matters most: the fallback must not be able to
    // be mistaken for an identity by anything that greps for the fields.
    expect(identity.stamp).toBeNull();
    expect(line).toContain("BUILD-ID unstamped");
    expect(line).not.toContain("commit=");
    expect(line).not.toContain("binary-sha256=");
  });

  test("an unstamped process does not hash whatever it is running as", async () => {
    let read = 0;
    const identity = await buildIdentity("/some/bun", async (path) => {
      read += 1;
      return { path, sha256: "d".repeat(64), bytes: 1 };
    });
    // Hashing `process.execPath` when there is no stamp would print the digest
    // of a `bun` on someone's PATH under the name `binary-sha256`.
    expect(read).toBe(0);
    expect(identity.digest.sha256).toBeUndefined();
    expect(identity.digest.problem).toContain("no digest was taken");
  });

  test("a digest that could not be taken says so instead of going missing", () => {
    const line = buildIdLine(stamped(GOOD, { path: "/artifact", problem: "could not be read: ENOENT" }));
    expect(line).toContain("binary-sha256=unavailable");
    expect(line).toContain("ENOENT");
  });

  test("a dirty tree is stated in the rendering, not only in the field", () => {
    const digest = { path: "/artifact", sha256: "e".repeat(64), bytes: 62_914_560 };
    const dirty = renderVersion(stamped({ ...GOOD, tree: "dirty", dirty: 3 }, digest)).join("\n");
    expect(dirty).toContain("tree=dirty");
    expect(dirty).toContain("DIRTY TREE");
    expect(dirty).toContain("cannot be reproduced");
    const clean = renderVersion(stamped(GOOD, digest)).join("\n");
    expect(clean).not.toContain("DIRTY TREE");
  });
});

describe("the digest is of the file, taken from the file", () => {
  test("it is the sha256 of the bytes, and an unreadable path is a problem rather than a hash", async () => {
    const path = `${import.meta.dir}/../package.json`;
    const bytes = await Bun.file(path).arrayBuffer();
    const expected = new Bun.CryptoHasher("sha256").update(new Uint8Array(bytes)).digest("hex");
    const digest = await digestOf(path);
    expect(digest.sha256).toBe(expected);
    expect(digest.bytes).toBe(bytes.byteLength);

    const missing = await digestOf(`${import.meta.dir}/there-is-no-such-file`);
    expect(missing.sha256).toBeUndefined();
    expect(missing.problem).toBeDefined();
  });
});

describe("the stamp the build step collects", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));

  test("it reads this repository's real commit and tree state", () => {
    const stamp = readStamp(repo, "1.3.14", "1.3.14+0d9b296af33f2b851fcbf4df3e9ec89751734ba4", "0.0.0");
    expect("problem" in stamp).toBe(false);
    if ("problem" in stamp) return;
    expect(stamp.commit).toMatch(/^[0-9a-f]{40}$/);
    // The revision arrives as `1.3.14+0d9b296af…` and vendor/pins.json holds the
    // bare 40-hex; the two must be comparable without string surgery later.
    expect(stamp.bunRevision).toBe(REVISION);
    expect(stamp.tree === "clean" ? stamp.dirty === 0 : stamp.dirty > 0).toBe(true);
    // Whatever it produced must survive the parser the artifact will use on it.
    expect(parseStamp(serialiseStamp(stamp)).stamp).toEqual(stamp);
  });

  test("NEGATIVE CONTROL — with no git, it refuses rather than inventing a commit", () => {
    const stamp = readStamp("/", "1.3.14", "1.3.14+deadbeef", "0.0.0");
    // `/` is not a git checkout on any machine this runs on. An artifact that
    // cannot be named must not be built, because an unnameable artifact is the
    // defect this whole surface exists to remove.
    expect("problem" in stamp).toBe(true);
    if (!("problem" in stamp)) return;
    expect(stamp.problem).toContain("cannot be given an identity");
  });

  test("the compiler is this process, never a `bun` resolved through PATH", () => {
    // The stamp reports the version of whoever runs `scripts/build.ts`. Spawning
    // the string "bun" resolves through PATH, so a shim first on PATH does the
    // compiling while the stamp names the launcher — and `license-gate`'s pin
    // check reads its own `Bun.version` too, so ruling 47's gate cannot see it.
    const argv = compileArgv(process.execPath, "src/cli.ts", "dist/brigadier", '{"commit":"x"}');
    expect(argv[0]).toBe(process.execPath);
    expect(argv[0]).not.toBe("bun");
    expect(argv.slice(1, 4)).toEqual(["build", "--compile", "src/cli.ts"]);
    // The define's value is a JS string LITERAL, not raw JSON: bun substitutes it
    // as an expression, so the stamp has to arrive quoted or it is parsed as code.
    expect(argv).toContain(`BRIGADIER_BUILD_STAMP=${JSON.stringify('{"commit":"x"}')}`);
  });

  test("a file that was never written has no mtime, so `exited 0` cannot stand in for `wrote something`", () => {
    // A compiler that exits 0 and emits nothing leaves the PREVIOUS artifact in
    // place for the licence gate to scan and for a stale identifier to be
    // reported against. The instrument that catches it is the filesystem.
    expect(mtimeOf(`${import.meta.dir}/there-is-no-such-file`)).toBeNull();

    // And the instrument must DISCRIMINATE, or "the file was rewritten" is a
    // check that passes for free. Nanosecond mtimes, so a rewrite that produces
    // byte-identical output — which a reproducible build does every time — still
    // moves the reading.
    const scratch = join(tmpdir(), `brigadier-mtime-${process.pid}`);
    writeFileSync(scratch, "one");
    const first = mtimeOf(scratch);
    expect(first).not.toBeNull();
    expect(mtimeOf(scratch)).toBe(first as bigint);
    writeFileSync(scratch, "one");
    expect(mtimeOf(scratch)).not.toBe(first as bigint);
    rmSync(scratch, { force: true });
  });

  test("the stamp is a pure function of the tree and the toolchain — nothing else", () => {
    const once = readStamp(repo, "1.3.14", `1.3.14+${REVISION}`, "0.0.0");
    const twice = readStamp(repo, "1.3.14", `1.3.14+${REVISION}`, "0.0.0");
    // No timestamp, no hostname, no build user, no counter. This is the property
    // that keeps the artifact reproducible: two builds of one commit with one
    // bun must serialise to identical bytes, or the stamp itself is the thing
    // making the binary irreproducible.
    expect(once).toEqual(twice);
    if ("problem" in once || "problem" in twice) return;
    expect(serialiseStamp(once)).toBe(serialiseStamp(twice));
  });
});

/**
 * The artifact's NAME, which is the compiler's to choose and not ours.
 *
 * `bun build --compile` appends `.exe` for a Windows target whatever `--outfile`
 * it was handed. MEASURED against `bun 1.3.14` on `darwin 25.5.0` on 2026-08-20,
 * cross-compiling with `--target=bun-windows-x64`: `--outfile <dir>/brigadier`
 * wrote `<dir>/brigadier.exe`, and bun's own compile line said
 * `compile <dir>/brigadier.exe bun-windows-x64-v1.3.14`. Until that date
 * `scripts/build.ts` asked for `dist/brigadier` and then refused because
 * `dist/brigadier` was absent, so `bun run build` — and with it ruling 47's
 * licence gate — could not run on Windows at all.
 *
 * These tests are the reason the fix is checkable from a machine that cannot run
 * Windows: `resolveArtifact` is a pure function of stat readings, so the Windows
 * arrangement (plain name absent, `.exe` freshly written) is just a pair of
 * values. What they do NOT prove is bun's appending rule itself — that is the
 * cross-compile above, and it is a measurement, not an assertion.
 */
describe("the compiled artifact is discovered, not assumed", () => {
  test("both names a Windows target could produce are candidates, and `.exe` is not doubled", () => {
    expect(artifactCandidates("dist/brigadier")).toEqual(["dist/brigadier", "dist/brigadier.exe"]);
    expect(artifactCandidates("dist/brigadier.exe")).toEqual(["dist/brigadier.exe"]);
    // Case-insensitively, because Windows filesystems are.
    expect(artifactCandidates("dist/brigadier.EXE")).toEqual(["dist/brigadier.EXE"]);
  });

  test("WINDOWS SHAPE — the plain name is never written and the `.exe` is the artifact", () => {
    const resolved = resolveArtifact([
      { path: "dist/brigadier", before: null, after: null },
      { path: "dist/brigadier.exe", before: null, after: 7n },
    ]);
    expect(resolved).toEqual({ path: "dist/brigadier.exe" });
  });

  test("POSIX SHAPE — the plain name is the artifact and no `.exe` ever appears", () => {
    const resolved = resolveArtifact([
      { path: "dist/brigadier", before: 3n, after: 9n },
      { path: "dist/brigadier.exe", before: null, after: null },
    ]);
    expect(resolved).toEqual({ path: "dist/brigadier" });
  });

  test("NEGATIVE CONTROL — a stale artifact is still refused, per candidate", () => {
    // The whole point of the mtime guard survives the rename: a compiler that
    // exits 0 without writing leaves the PREVIOUS build for the licence gate to
    // scan. Widening the search must not turn "it is already there" into a pass.
    const stale = resolveArtifact([
      { path: "dist/brigadier", before: 3n, after: 3n },
      { path: "dist/brigadier.exe", before: null, after: null },
    ]);
    expect("problem" in stale).toBe(true);
    if (!("problem" in stale)) return;
    expect(stale.problem).toContain("PREVIOUS build");

    const staleWindows = resolveArtifact([
      { path: "dist/brigadier", before: null, after: null },
      { path: "dist/brigadier.exe", before: 3n, after: 3n },
    ]);
    expect("problem" in staleWindows).toBe(true);
    if (!("problem" in staleWindows)) return;
    expect(staleWindows.problem).toContain("dist/brigadier.exe");
  });

  test("NEGATIVE CONTROL — nothing written at all names every name it looked under", () => {
    const nothing = resolveArtifact([
      { path: "dist/brigadier", before: null, after: null },
      { path: "dist/brigadier.exe", before: null, after: null },
    ]);
    expect("problem" in nothing).toBe(true);
    if (!("problem" in nothing)) return;
    expect(nothing.problem).toContain("dist/brigadier");
    expect(nothing.problem).toContain("dist/brigadier.exe");
  });

  test("NEGATIVE CONTROL — two fresh candidates is ambiguous, and ambiguity is loud", () => {
    // Nobody has seen this happen. It is refused rather than resolved by
    // preference because the failure it would otherwise produce is the silent
    // one: the licence gate reporting a clean verdict about the wrong file.
    const both = resolveArtifact([
      { path: "dist/brigadier", before: null, after: 1n },
      { path: "dist/brigadier.exe", before: null, after: 2n },
    ]);
    expect("problem" in both).toBe(true);
    if (!("problem" in both)) return;
    expect(both.problem).toContain("rewrote 2 candidate artifacts");
  });

  test("the licence gate resolves the artifact by the SAME rule the build step names it with", () => {
    // One idiom, not two. If these ever diverge, the build succeeds on Windows
    // and the gate scans nothing — which is worse than today's failure, because
    // it ships an unscanned binary instead of refusing to ship one.
    expect(resolveBinary("dist/brigadier", () => false).tried).toEqual(artifactCandidates("dist/brigadier"));

    // The Windows arrangement, driven through the gate's own resolver.
    const windows = resolveBinary("dist/brigadier", (p) => p === "dist/brigadier.exe");
    expect(windows).toEqual({ path: "dist/brigadier.exe", found: true, tried: ["dist/brigadier", "dist/brigadier.exe"] });

    const posix = resolveBinary("dist/brigadier", (p) => p === "dist/brigadier");
    expect(posix.path).toBe("dist/brigadier");
    expect(posix.found).toBe(true);
  });

  test("NEGATIVE CONTROL — with neither name on disk the gate does NOT find a binary", () => {
    // `--require-binary` turns `found: false` into two blocking findings. A
    // resolver that fell back to "found" would silently disarm ruling 47 on the
    // release path, which is the one failure mode worse than the bug it fixes.
    const missing = resolveBinary("dist/brigadier", () => false);
    expect(missing.found).toBe(false);
    expect(missing.tried).toEqual(["dist/brigadier", "dist/brigadier.exe"]);
  });
});

describe("`brigadier version`, driven as a process", () => {
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = (args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  };

  test("the subcommand exists and is reached", () => {
    // The one property a unit test cannot show: that the module is CALLED. This
    // repository has shipped a complete, on-spec implementation with zero call
    // sites and a green suite.
    const result = run(["version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("BUILD-ID");
  });

  test("`--version` and `-V` reach the same surface", () => {
    expect(run(["--version"]).stdout).toContain("BUILD-ID");
    expect(run(["-V"]).stdout).toContain("BUILD-ID");
  });

  test("NEGATIVE CONTROL — run from source it reports unstamped, and fabricates nothing", () => {
    // `bun src/cli.ts` is not an artifact of this repository, and the surface
    // must not print a commit, a tree state or a digest for it. If this ever
    // starts printing `commit=`, the identity is being invented.
    const result = run(["version"]);
    expect(result.stdout).toContain("BUILD-ID unstamped");
    expect(result.stdout).not.toContain("commit=");
    expect(result.stdout).not.toContain("binary-sha256=");
    expect(result.stdout).toContain("has NOT been invented");
    // It reports the OBSERVATION — nothing was stamped in — and does not guess
    // at what kind of process this is. "It is source running under a `bun` on
    // PATH" was the earlier wording and it is false of a compiled artifact built
    // by any route other than `bun run build`.
    expect(result.stdout).toContain("no build stamp was compiled into this executable");
    expect(result.stdout).toContain("not observable from inside it");
  });

  test("the usage text names the surface, so it is findable without reading the source", () => {
    expect(run(["--help"]).stdout).toContain("brigadier version");
  });
});
