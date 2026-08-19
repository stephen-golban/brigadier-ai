// SPDX-License-Identifier: Apache-2.0
/**
 * The compile step, with the artifact's own name stamped into it.
 *
 * `bun build --compile` used to be a bare line in `package.json`, and the
 * artifact it produced was anonymous: nothing in the binary said which commit it
 * came from, whether that tree was clean, or which `bun` compiled it. The cost
 * of that has already been paid — four warm-start readings of "this binary"
 * exist, taken against four different artifacts, and none of them can be
 * attributed or compared. `src/build/identity.ts` carries the reasoning; this
 * file is the only place the facts are collected.
 *
 * THE STAMP IS A PURE FUNCTION OF THE TREE AND THE TOOLCHAIN. Commit, dirty
 * count, `Bun.version`, `Bun.revision`, `package.json`'s version — and nothing
 * else. No timestamp, no hostname, no build user, no path, no counter. That
 * choice is what keeps the artifact reproducible: rebuilding one commit with one
 * `bun` yields the same stamp and therefore the same bytes, which is the
 * property ruling 72 leaves a bar item still to be written about.
 *
 * IT REFUSES TO BUILD SOMETHING IT CANNOT NAME. Without a commit there is no
 * identity, and an unidentifiable artifact is the defect this file exists to
 * remove — quietly emitting one and calling the build a success is the exact
 * substitution ruling 48 forbids one level up. So a tree with no git refuses,
 * loudly, and names what it needed.
 *
 * AND IT REFUSES TO REPORT A BUILD IT DID NOT OBSERVE. The compiler's exit code
 * is not evidence that a file was written: a compiler that exits 0 and emits
 * nothing leaves the PREVIOUS `dist/brigadier` in place, `license-gate
 * --require-binary` passes against it, and from that moment every figure is
 * attributed to a stale artifact by an identifier that looks perfectly healthy.
 * The old one-liner in `package.json` had the same hole. So the outfile is
 * stat'd before and after, and a file whose mtime did not move is a failure with
 * its own message. The digest of what was written is printed, so the build log
 * and `brigadier version` can be compared by eye.
 *
 * THE COMPILER IS `process.execPath`, NOT `"bun"` ON `PATH`. The stamp's `bun`
 * and `bunRevision` come from the process running THIS file; spawning the string
 * `"bun"` would resolve some other binary through `PATH` and stamp a compiler
 * that did not compile. That was not hypothetical — with a shim first on `PATH`,
 * an earlier draft stamped `1.3.14` while the shim did the work, and
 * `scripts/license-gate.ts` cannot catch it because its pin check reads its own
 * `Bun.version` too. One interpreter stamps and compiles, or the stamp is a
 * guess about a process nobody looked at.
 *
 *   bun run scripts/build.ts [--outfile dist/brigadier] [--entry src/cli.ts]
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { serialiseStamp, type BuildStamp } from "../src/build/identity.ts";

/**
 * `import.meta.dir`, not `new URL(…).pathname`.
 *
 * A URL pathname is percent-encoded, so a repository under a path containing a
 * space or any non-ASCII character arrives as `%20` and every `join` below
 * addresses a directory that does not exist. `import.meta.dir` is already a
 * filesystem path.
 */
export const REPO_ROOT = join(import.meta.dir, "..");

/** One git invocation, with its output and whether it worked. */
function git(root: string, args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout).trim() };
}

/**
 * The state of the tree, READ rather than assumed.
 *
 * `git status --porcelain` is the instrument for `dirty` because it is the one
 * that counts untracked files too: a file that is present, uncommitted and
 * compiled into the artifact is exactly as much of a reproducibility hole as a
 * modified tracked one, and `git diff --quiet` would call that tree clean.
 * Ignored files are excluded by porcelain's own default, which is why `dist/`
 * does not make every build dirty.
 *
 * The consequence, since it is a real one: on a DIRTY tree the count moves when
 * an unrelated scratch file appears, so the artifact's bytes depend on more than
 * `src/`. On a clean checkout — CI, and the documented rebuild path — the count
 * is 0 and nothing outside the commit can reach the stamp.
 */
export function readStamp(root: string, bun: string, revision: string, pkg: string): BuildStamp | { problem: string } {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!head.ok || !/^[0-9a-f]{40}$/.test(head.out)) {
    return {
      problem:
        "`git rev-parse HEAD` produced no commit, so this artifact cannot be given an identity. " +
        "Build from a git checkout: an artifact nobody can attribute a measurement to is the defect this step exists to prevent",
    };
  }
  const status = git(root, ["status", "--porcelain"]);
  if (!status.ok) {
    return { problem: "`git status --porcelain` failed, so whether the tree matched the commit is unknown" };
  }
  const changed = status.out === "" ? 0 : status.out.split("\n").filter((l) => l.trim() !== "").length;
  // `Bun.revision` is "1.3.14+0d9b296af…"; the pin in vendor/pins.json is the
  // bare 40-hex, and the two should be comparable without string surgery later.
  const bare = revision.replace(/^.*\+/, "");
  return {
    commit: head.out,
    tree: changed === 0 ? "clean" : "dirty",
    dirty: changed,
    bun,
    bunRevision: bare,
    package: pkg,
  };
}

/**
 * The command that compiles, with the interpreter named explicitly.
 *
 * A function rather than an inline array so that "the compiler is this process,
 * never a `bun` resolved through `PATH`" is a property a test can assert. The
 * stamp reports the version of whoever runs this file; if some other binary does
 * the compiling, the stamp describes a process that did not build anything.
 */
export function compileArgv(interpreter: string, entry: string, outfile: string, stamp: string): string[] {
  return [
    interpreter,
    "build",
    "--compile",
    entry,
    "--outfile",
    outfile,
    // A define, not `process.env`: it is constant-folded before the artifact
    // exists, so there is no runtime lookup an environment variable could
    // answer. An identity a caller can set is not an identity.
    "--define",
    `BRIGADIER_BUILD_STAMP=${JSON.stringify(stamp)}`,
  ];
}

/** The outfile's mtime in nanoseconds, or `null` where there is no such file. */
export function mtimeOf(path: string): bigint | null {
  try {
    return statSync(path, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const after = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : (argv[index + 1] ?? fallback);
  };
  const outfile = after("outfile", join(REPO_ROOT, "dist", "brigadier"));
  const entry = after("entry", join(REPO_ROOT, "src", "cli.ts"));

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
  const stamp = readStamp(REPO_ROOT, Bun.version, Bun.revision, pkg.version ?? "0.0.0");
  if ("problem" in stamp) {
    console.error(`\nBUILD REFUSED — the artifact cannot be identified\n\n  ${stamp.problem}\n`);
    process.exit(1);
  }

  const serialised = serialiseStamp(stamp);
  console.log(
    `stamping commit ${stamp.commit} (${stamp.tree}${stamp.dirty === 0 ? "" : `, ${stamp.dirty} path(s) differ`}) ` +
      `built with bun ${stamp.bun} revision ${stamp.bunRevision}`,
  );
  if (stamp.tree === "dirty") {
    console.log(
      "  the tree is DIRTY, and the artifact will say so: its commit does not determine its bytes, " +
        "so it cannot be rebuilt from that commit and only its sha256 identifies it",
    );
  }

  const mtimeBefore = mtimeOf(outfile);
  const proc = Bun.spawnSync(compileArgv(process.execPath, entry, outfile, serialised), {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);

  // The compiler said it succeeded. Whether it WROTE anything is a separate
  // question, and the answer is read off the filesystem rather than inferred.
  const mtimeAfter = mtimeOf(outfile);
  if (mtimeAfter === null) {
    console.error(`\nBUILD REFUSED — \`bun build\` exited 0 and ${outfile} does not exist\n`);
    process.exit(1);
  }
  if (mtimeBefore !== null && mtimeAfter === mtimeBefore) {
    console.error(
      `\nBUILD REFUSED — \`bun build\` exited 0 and ${outfile} was not rewritten (mtime still ${mtimeAfter}).\n\n` +
        "  The file already there is a PREVIOUS build. Reporting success would leave the licence gate scanning it\n" +
        "  and every later measurement attributed to it by an identifier that looks healthy.\n",
    );
    process.exit(1);
  }

  const bytes = new Uint8Array(readFileSync(outfile));
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  // Printed so the build log and `brigadier version` name the same artifact and
  // can be compared without trusting either one alone.
  console.log(`wrote ${outfile} — ${bytes.byteLength} bytes, sha256 ${sha}`);
  process.exit(0);
}
