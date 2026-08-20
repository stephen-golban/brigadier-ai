// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 63's retention clause, narrowed to what it actually promises.
 *
 *     a retained directory is inert and holds the only copy of someone's work
 *
 * That is a claim about CONTENT, and the version this suite replaced never
 * checked it: EVERY clone of an incomplete run survived, including one with no
 * commits and nothing in its working tree. Ruling 63's other half is what makes
 * that a defect rather than caution — *every start must report what is retained
 * and how many bytes it costs*, because otherwise it grows invisibly at #19's
 * measured ~67 MB incremental per clone, and an operator who cannot tell an
 * empty retained clone from one holding their only copy will eventually delete
 * both.
 *
 * So each guard here has its negative (ruling 62b), and they are deliberately
 * paired in opposite directions, because the two ways of being wrong are v1's
 * finding 92 (an external `SIGTERM` killed a supervisor, both workers had done
 * real work, and it was unrecoverable) and a run root that fills with nothing:
 *
 *   - a clone holding a real commit SURVIVES, is NAMED with its path and its
 *     bytes, and its object is still readable through `git cat-file`;
 *   - a clone with no commits and a clean tree is NOT retained;
 *   - a clone with uncommitted working-tree changes and no commits IS retained
 *     — an uncommitted edit exists in exactly one place and no object store
 *     holds it;
 *   - a clone whose state cannot be determined IS retained, and the line says
 *     so;
 *   - and the control that stops the rule becoming "never delete anything": a
 *     COMPLETE run's clones are swept even when they hold commits.
 *
 * Every assertion is on the bytes on disk, the object git reads back, or the
 * printed line — never on a flag the code returned about itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLONE_SIGNATURE } from "../src/isolation/internal-git.ts";
import { manifestPath, recordClone } from "../src/isolation/manifest.ts";
import { RUN_DIR } from "../src/repo/layout.ts";
import { itemRef } from "../src/repo/refs.ts";
import { isAlive, type ProcessTable } from "../src/run/processes.ts";
import { inspectClone, resolveRef } from "../src/run/kept.ts";
import { appendEvent, recordPath } from "../src/run/record.ts";
import { Sink } from "../src/secrets/sink.ts";
import { describeStartSweep, sweepAtStart } from "../src/run/start.ts";

const EMPTY_TABLE: ProcessTable = { rows: [], source: "injected", scannedAt: 0, limits: [] };

let scratch: string;
let repo: string;
let runRoot: string;
let runId: string;
/**
 * A pid from a process that has really exited.
 *
 * `isAlive(1)` is true on every POSIX machine, so a placeholder orchestrator pid
 * of 1 makes every planted run look in flight and nothing is ever judged.
 */
let deadPid: number;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout.trim();
}

/** Did git exit 0? Used where the FAILURE is the assertion. */
async function gitCode(cwd: string, ...args: string[]): Promise<number> {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return child.exited;
}

/**
 * A clone shaped exactly as `src/isolation/clone.ts` builds one: cloned by
 * local path with `--no-hardlinks`, a `brigadier-base` branch fetched onto it,
 * a `work` branch checked out from it, and no `origin`.
 *
 * The manifest entry is written BEFORE the directory exists, because ruling 15
 * (b) says so — and `recordClone` is what creates it, so the entry records the
 * inode `proveDeletableDirectory` later matches the directory against. `git
 * clone` accepts an existing EMPTY directory, which is what it is handed here
 * and in `prepareClone`.
 */
async function makeClone(item: number): Promise<string> {
  const dir = join(runRoot, RUN_DIR, runId, String(item));
  mkdirSync(join(runRoot, RUN_DIR, runId), { recursive: true });
  recordClone(
    manifestPath(runRoot, RUN_DIR, runId),
    { runId, runRoot, createdAt: Date.now(), clones: [] },
    { item, dir, createdAt: Date.now() },
  );
  await git(scratch, "clone", "--local", "--no-hardlinks", "--no-checkout", "-q", repo, dir);
  await git(dir, "config", "user.email", "worker@example.com");
  await git(dir, "config", "user.name", "Worker");
  await git(dir, "fetch", "--no-tags", repo, "+refs/heads/main:refs/heads/brigadier-base");
  await git(dir, "checkout", "-q", "-b", "work", "brigadier-base");
  await git(dir, "remote", "remove", "origin");
  writeFileSync(join(dir, ".git", CLONE_SIGNATURE), `${runId}/${item}\n`);
  mkdirSync(join(runRoot, RUN_DIR, runId, "state", String(item)), { recursive: true });
  writeFileSync(join(runRoot, RUN_DIR, runId, "state", String(item), "token"), "nonce\n");
  return dir;
}

/** Real work, committed: the case finding 92 is about. Returns the commit sha. */
async function commitWork(dir: string, path: string, contents: string): Promise<string> {
  writeFileSync(join(dir, path), contents);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", `write ${path}`);
  return git(dir, "rev-parse", "HEAD");
}

/** A run this root has a record of, whose orchestrator is provably dead. */
function plantRecord(): void {
  appendEvent(recordPath(runRoot, runId), {
    type: "run-started",
    at: 1,
    runId,
    repo,
    runRoot,
    pid: deadPid,
  });
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-kept-")));
  repo = join(scratch, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "one");

  runRoot = join(scratch, "root");
  mkdirSync(join(runRoot, RUN_DIR), { recursive: true });
  runId = `kept${process.pid.toString(36)}`;

  // `process.execPath`, not `/bin/sh`. This is a two-line trick to obtain a pid
  // that is CERTAINLY dead, and it took the whole file down on windows-latest:
  // `uv_spawn '/bin/sh'` -> ENOENT (errno -4058) in a `before*` hook aborts every
  // test in the file, so `test/run-kept.test.ts` reported 0 pass / 11 fail and
  // `test/run-start.test.ts` lost 18 tests that never registered at all. Ruling
  // 12 makes Windows first class and the same file already guards its OTHER
  // spawn with `process.platform === "win32"` a few lines away; this one was
  // simply missed. A bun that exits immediately is dead on every platform and
  // needs no shell, so nothing here is platform-gated any more.
  const corpse = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  deadPid = corpse.pid;
  await corpse.exited;
  while (isAlive(deadPid)) await Bun.sleep(20);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("what decides retention is git, not the record", () => {
  test("a clone holding a real commit survives, is NAMED with path and bytes, and cat-file still reads its object", async () => {
    const dir = await makeClone(1);
    const sha = await commitWork(dir, "kept.txt", "the only copy of this work\n".repeat(40));
    plantRecord();

    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE, notify: () => {} });

    // 1. The bytes on disk, not a flag the sweep returned.
    expect(existsSync(join(dir, "kept.txt"))).toBe(true);
    expect(statSync(join(dir, "kept.txt")).size).toBeGreaterThan(1000);
    // 2. The object, read back through git in the surviving clone.
    expect(await git(dir, "cat-file", "-t", sha)).toBe("commit");
    expect(await git(dir, "cat-file", "-p", `${sha}:kept.txt`)).toContain("the only copy of this work");

    // 3. NAMED. Path, bytes and the commit that makes it worth keeping.
    const kept = report.retained.find((entry) => entry.path === dir);
    expect(kept?.work).toBe("committed");
    expect(kept?.commit).toBe(sha);
    expect(kept?.bytes).toBeGreaterThan(1000);
    const printed = describeStartSweep(report).join("\n");
    expect(printed).toContain(dir);
    expect(printed).toContain(`${kept?.bytes} bytes`);
    expect(printed).toContain(sha);
    expect(printed).toContain("HOLDS COMMITTED WORK");
    expect(printed).toContain("not merged, not reviewed, not deleted");
  }, 60_000);

  test("NEGATIVE: a clone with no commits and a clean tree is NOT retained", async () => {
    // The escapee's clone in BAR item 7: a worker that spawned a descendant and
    // committed nothing. Ruling 63 keeps a directory because it may hold the
    // only copy of someone's work; there is no copy of anything here.
    const empty = await makeClone(1);
    const held = await makeClone(2);
    const sha = await commitWork(held, "kept.txt", "real work\n");
    plantRecord();

    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE, notify: () => {} });

    // Gone from disk — asserted on the directory, not on the report.
    expect(existsSync(empty)).toBe(false);
    // And the paired half in the same run: the one that held work is untouched.
    expect(existsSync(held)).toBe(true);
    expect(await git(held, "cat-file", "-t", sha)).toBe("commit");

    expect(report.retained.map((entry) => entry.path)).toEqual([held]);
    const reclaimed = report.reclaimedDirs.find((entry) => entry.path === empty);
    expect(reclaimed?.why).toContain("holds no work");
    // The per-item state directory goes with it, or the growth is only moved.
    expect(existsSync(join(runRoot, RUN_DIR, runId, "state", "1"))).toBe(false);
    expect(existsSync(join(runRoot, RUN_DIR, runId, "state", "2"))).toBe(true);
  }, 60_000);

  test("a clone with UNCOMMITTED working-tree changes and no commits is retained", async () => {
    // An uncommitted edit exists in exactly one place on the machine and no
    // object store holds it, so a directory is the only thing standing between
    // it and finding 92. "No commits" is not "empty".
    const dir = await makeClone(1);
    writeFileSync(join(dir, "half-done.txt"), "never committed\n");
    writeFileSync(join(dir, "a.txt"), "and this tracked file was edited\n");
    plantRecord();

    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE, notify: () => {} });

    expect(readFileSync(join(dir, "half-done.txt"), "utf8")).toBe("never committed\n");
    const kept = report.retained.find((entry) => entry.path === dir);
    expect(kept?.work).toBe("uncommitted");
    const printed = describeStartSweep(report).join("\n");
    expect(printed).toContain("HOLDS UNCOMMITTED");
    expect(printed).toContain("half-done.txt");
  }, 60_000);

  test("NEGATIVE: a clone whose state CANNOT be determined is retained, and the line says so", async () => {
    // A directory the manifest records and git cannot read: no base ref, so
    // there is nothing to compare a commit against. Unknown retains, and it
    // says which unknown rather than reporting a clean sweep.
    const dir = join(runRoot, RUN_DIR, runId, "1");
    mkdirSync(join(runRoot, RUN_DIR, runId), { recursive: true });
    recordClone(
      manifestPath(runRoot, RUN_DIR, runId),
      { runId, runRoot, createdAt: Date.now(), clones: [] },
      { item: 1, dir, createdAt: Date.now() },
    );
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", CLONE_SIGNATURE), `${runId}/1\n`);
    writeFileSync(join(dir, "work.txt"), "the worker's only copy\n".repeat(60));
    plantRecord();

    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE, notify: () => {} });

    expect(existsSync(join(dir, "work.txt"))).toBe(true);
    expect(statSync(join(dir, "work.txt")).size).toBeGreaterThan(1000);
    const kept = report.retained.find((entry) => entry.path === dir);
    expect(kept?.work).toBe("undetermined");
    const printed = describeStartSweep(report).join("\n");
    expect(printed).toContain("could NOT determine what it holds");
    expect(printed).toContain("refs/heads/brigadier-base");
  }, 60_000);

  test("PAIRED CONTROL: a COMPLETE run's clones are swept even though they hold commits", async () => {
    // Without this the rule collapses into "never delete anything", which is
    // the other way to fill a disk. Completion is the world's answer — the ref
    // in the operator's repository — not the record's.
    const dir = await makeClone(1);
    const sha = await commitWork(dir, "kept.txt", "landed work\n");
    plantRecord();
    // The ref is what the world says, and `judgeRun` reads its EXISTENCE. It is
    // pinned to the operator repository's own commit because the clone's commit
    // has not been fetched — which is exactly the state a run that landed item 1
    // and then died would leave behind.
    await git(repo, "update-ref", itemRef(runId, 1), await git(repo, "rev-parse", "HEAD"));

    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE, notify: () => {} });

    expect(report.verdicts.find((verdict) => verdict.runId === runId)?.completion).toBe("complete");
    expect(existsSync(dir)).toBe(false);
    expect(report.retained).toEqual([]);
    expect(report.reclaimedDirs.find((entry) => entry.path === dir)?.why).toContain("the run is complete");
  }, 60_000);
});

describe("the retention notice reaches a channel the report's cap cannot drop", () => {
  test("every start with something retained emits the path and the bytes", async () => {
    // Ruling 63: every start reports what is retained and what it costs. Those
    // lines used to go only into the run report's `detail`, which ruling 58's
    // host-session cap discards entirely — and `host-session` is the default
    // audience. The notice is now emitted separately, so it survives.
    const dir = await makeClone(1);
    const sha = await commitWork(dir, "kept.txt", "the only copy\n");
    plantRecord();

    const notices: string[] = [];
    const report = await sweepAtStart({
      runRoot,
      table: EMPTY_TABLE,
      notify: (line) => notices.push(line),
    });

    const text = notices.join("\n");
    expect(text).toContain(dir);
    expect(text).toContain(`${report.retained[0]?.bytes} bytes`);
    expect(text).toContain(sha);
    expect(text).toContain("discharge them explicitly");
  }, 60_000);

  test("with no notify injected the notice goes through the SINK to stderr (ruling 65)", async () => {
    // The default path, which the tests above bypass. Ruling 65: one sink,
    // after composition — the notice is a composed string carrying the
    // operator's own paths, so it is written by the sink rather than by this
    // module reaching for `process.stderr`.
    const dir = await makeClone(1);
    await commitWork(dir, "kept.txt", "the only copy\n");
    plantRecord();

    const out: string[] = [];
    const err: string[] = [];
    const sink = new Sink(undefined, { out: (chunk) => out.push(chunk), err: (chunk) => err.push(chunk) });
    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE, sink });
    // The caller owns this sink, so `sweepAtStart` must NOT have ended it —
    // ending a sink the run still has to write through is the other failure.
    sink.end();

    const text = err.join("");
    expect(text).toContain(dir);
    expect(text).toContain(`${report.retained[0]?.bytes} bytes`);
    expect(out.join("")).toBe("");
  }, 60_000);

  test("NEGATIVE: a start with nothing retained emits no notice at all", async () => {
    // Silence here is honest: the always-print line stays in the report, and
    // this channel is the hazard channel. A warning that fires every run is a
    // warning nobody reads.
    const dir = await makeClone(1);
    await commitWork(dir, "kept.txt", "landed\n");
    plantRecord();
    await git(repo, "update-ref", itemRef(runId, 1), await git(repo, "rev-parse", "HEAD"));

    const notices: string[] = [];
    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE, notify: (line) => notices.push(line) });
    expect(notices).toEqual([]);
    expect(describeStartSweep(report)).toContain("0 clone(s) retained from earlier runs");
  }, 60_000);
});

describe("asking git without running git inside the clone (ruling 56)", () => {
  test("a planted hook and a planted core.fsmonitor do NOT execute during the inspection", async () => {
    // `probes/git-exec.sh` MEASURED against `git 2.50.1` on 2026-08-17 that
    // `core.fsmonitor` fires on an ordinary `git status` and is NOT closed by
    // `-c core.hooksPath=`. This inspection therefore never lets git read the
    // clone's `.git/config` at all: it builds a git directory of brigadier's
    // own and reaches the clone's objects through `objects/info/alternates`.
    // The canary is the proof — if either surface fired, the file exists.
    const dir = await makeClone(1);
    writeFileSync(join(dir, "half-done.txt"), "uncommitted, so the working tree is read\n");

    const canary = join(scratch, "EXECUTED");
    const payload = join(scratch, "payload.sh");
    writeFileSync(payload, `#!/bin/sh\necho fired >> ${JSON.stringify(canary)}\nexit 0\n`, { mode: 0o755 });
    const hooks = join(scratch, "planted-hooks");
    mkdirSync(hooks, { recursive: true });
    for (const hook of ["post-checkout", "pre-commit", "reference-transaction", "post-index-change"]) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\necho fired >> ${JSON.stringify(canary)}\nexit 0\n`, { mode: 0o755 });
    }
    writeFileSync(
      join(dir, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = ${payload}\n\thooksPath = ${hooks}\n` +
        "[user]\n\temail = worker@example.com\n\tname = Worker\n",
    );

    const work = await inspectClone(dir, { runRoot });

    // The question was still answered — this is not a test that passes by the
    // inspection failing.
    expect(work.state).toBe("uncommitted");
    expect(work.changed).toContain("half-done.txt");
    expect(existsSync(canary)).toBe(false);

    // THE CONTROL, and without it the assertion above is satisfied by a payload
    // that never worked: the same planted content DOES execute when git is
    // pointed at the clone's own `.git`, which is exactly what ruling 56
    // forbids and exactly what the inspection does not do.
    expect(await gitCode(dir, "commit", "--allow-empty", "-q", "-m", "control")).toBe(0);
    expect(existsSync(canary)).toBe(true);
  }, 60_000);

  test("a gc'd clone still resolves its base: packed-refs is read, not just loose files", async () => {
    // `src/isolation/manifest.ts` records `git pack-refs --all` removing the
    // loose `refs/heads/brigadier-base` — and ordinary `git gc` runs it. A
    // resolver that only read loose files would call every gc'd clone
    // undetermined and retain it forever on a technicality.
    const dir = await makeClone(1);
    const sha = await commitWork(dir, "kept.txt", "real work\n");
    await git(dir, "pack-refs", "--all");
    expect(existsSync(join(dir, ".git", "refs", "heads", "brigadier-base"))).toBe(false);

    expect(resolveRef(join(dir, ".git"), "refs/heads/brigadier-base")).toHaveLength(40);
    const work = await inspectClone(dir, { runRoot });
    expect(work.state).toBe("committed");
    expect(work.commit).toBe(sha);
  }, 60_000);

  test("NEGATIVE: a ref file naming an object the store cannot produce is undetermined, never work", async () => {
    // A sha in a ref file is a claim. `git cat-file` is the world's answer to
    // it, and a clone whose objects have been removed under it must not be
    // reported as holding work it cannot produce.
    const dir = await makeClone(1);
    await commitWork(dir, "kept.txt", "real work\n");
    rmSync(join(dir, ".git", "objects"), { recursive: true, force: true });

    const work = await inspectClone(dir, { runRoot });
    expect(work.state).toBe("undetermined");
    expect(work.detail).toContain("cat-file");
    // And it is still retained, which is the direction that matters.
    const report = await sweepAtStart({ runRoot, table: EMPTY_TABLE, notify: () => {} });
    expect(report.retained.map((entry) => entry.path)).toEqual([dir]);
    expect(existsSync(join(dir, "kept.txt"))).toBe(true);
  }, 60_000);
});
