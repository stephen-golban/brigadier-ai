// SPDX-License-Identifier: Apache-2.0
/**
 * `exec`'s timeout, against the failure it is actually for.
 *
 * MEASURED on this host on 2026-08-18: a `--live` `bar/run.ts` run against the
 * real binary timed out inside `exec`, `proc.kill("SIGKILL")` reaped the direct
 * child, and TWO of its own ACP vendor children — `--brigadier-run` markers
 * still in their command lines — were left behind, reparented to `launchd`,
 * each pinning a core at ~100% CPU indefinitely. Killing one pid was never
 * going to catch a child of that pid, and by the time anyone looked the item's
 * `finally` had already deleted the run root a later sweep would have needed.
 *
 * This is that scenario, reproduced with `/bin/sh` standing in for the real
 * binary and its own backgrounded `&` job standing in for the ACP child: both
 * outlive the timeout unless the WHOLE group is reclaimed, not just the pid
 * `exec` holds a handle to.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STREAM_DRAIN_GRACE_MS, STREAM_TRUNCATED_MARKER, TIMEOUT_SIGNAL, exec, killTree } from "./proc.ts";
import { notRunHere } from "./platform.ts";

let scratch: string;
const stragglers: number[] = [];
const groups: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bounded, because a cleanup that waits forever is not a cleanup. */
async function waitForFile(path: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20);
  return existsSync(path);
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-proc-")));
});

afterAll(() => {
  // Groups first: the negative control deliberately leaves a whole tree alive,
  // and reaping only the pids it published would leave its intermediate shell.
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const pid of stragglers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is what every test below is trying to prove.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The real shape, one level deeper than a backgrounded job.
 *
 * `bar/lib/fixtures.ts` plants each vendor as a `/bin/sh` shim that `exec`s
 * `bun bar/fakes/vendor.ts`, and the fixture itself spawns too. So the tree the
 * group kill has to reach is `exec`'s child → a shell → a descendant, not
 * `exec`'s child → a descendant. This builds exactly that, and the innermost
 * process publishes its own pid so "still running" is `kill(pid, 0)` rather than
 * an inference.
 */
function grandchildTree(name: string): { argv: string[]; pidFile: string } {
  const pidFile = join(scratch, `${name}.pid`);
  const inner = join(scratch, `${name}-inner.sh`);
  const outer = join(scratch, `${name}-outer.sh`);
  writeFileSync(inner, "#!/bin/sh\nsleep 300 &\necho $! > \"$1\"\nsleep 300\n", { mode: 0o755 });
  writeFileSync(outer, `#!/bin/sh\n/bin/sh ${JSON.stringify(inner)} "$1" &\nsleep 300\n`, { mode: 0o755 });
  return { argv: ["/bin/sh", outer, pidFile], pidFile };
}

describe("a timed-out invocation's descendants are reclaimed too", () => {
  test("a backgrounded child of the killed process does not outlive it", async () => {
    if (process.platform === "win32") {
      notRunHere(
        "a backgrounded child of a timed-out invocation being reclaimed with it",
        "the fixture backgrounds with `&` inside `/bin/sh` and `cmd.exe` has no `&` job control to " +
          "model that with. `killTree` DOES have a Windows arm — `taskkill /T /F /PID`, which walks " +
          "the ppid tree rather than a process group — and it is UNMEASURED: nothing on any machine " +
          "has ever driven it, which is precisely what this early return was hiding.",
      );
    }
    const pidFile = join(scratch, "child.pid");

    // Stands in for the product spawning an ACP vendor: a descendant left
    // running in the SAME process group as the pid `exec` is about to kill,
    // reachable only by a group signal.
    const result = await exec(
      ["/bin/sh", "-c", `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; sleep 300`],
      { timeoutMs: 500 },
    );

    expect(result.code).toBeNull();
    expect(result.signal).toBe(TIMEOUT_SIGNAL);

    // The pid file is the fixture's own proof of what it spawned, read after
    // the fact rather than assumed from the shell source.
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(pidFile)).toBe(true);
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(childPid).toBeGreaterThan(0);
    stragglers.push(childPid);

    // The bytes, not a boolean: signal 0 against the pid the fixture itself
    // published. Before the group kill this was the leak — `exec` had already
    // returned, believing it was done, with this pid still alive and spinning.
    expect(isAlive(childPid)).toBe(false);
  }, 20_000);

  test("a GRANDCHILD is reclaimed too — the fixture spawns, so one level is not enough", async () => {
    if (process.platform === "win32") {
      notRunHere(
        "a GRANDCHILD of a timed-out invocation being reclaimed — one level is not enough",
        "same fixture, same missing `&`. This is the arm that matters most on Windows, because " +
          "`taskkill /T` reclaims by walking the ppid tree and a Windows orphan does NOT reparent — " +
          "so whether `/T` reaches a grandchild whose middle process has already exited is exactly " +
          "the thing nobody has measured.",
      );
    }
    const { argv, pidFile } = grandchildTree("grandchild");

    const result = await exec(argv, { timeoutMs: 500 });
    expect(result.signal).toBe(TIMEOUT_SIGNAL);

    expect(await waitForFile(pidFile, 5_000)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    stragglers.push(pid);

    // The group signal is not depth-limited, and this is the assertion that
    // says so on a pid rather than on the man page.
    expect(isAlive(pid)).toBe(false);
  }, 20_000);

  test("NEGATIVE CONTROL: killing only the pid leaves that same grandchild running", async () => {
    if (process.platform === "win32") {
      notRunHere(
        "the NEGATIVE CONTROL: killing only the pid LEAVES the grandchild running",
        "it uses the same `&` fixture as the arm it controls. Without it, the two tests above could " +
          "pass on a machine where the grandchild was never spawned at all, so its absence costs " +
          "more than one test.",
      );
    }
    const { argv, pidFile } = grandchildTree("single-pid");

    // Spawned exactly as `exec` spawns — same argv, same `detached: true`, so
    // the ONLY difference from the test above is which signal is sent. Without
    // that difference this pair would prove nothing about the group kill.
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
    groups.push(proc.pid);

    expect(await waitForFile(pidFile, 10_000)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    stragglers.push(pid);

    proc.kill("SIGKILL"); // the pre-fix reap: one pid, no group
    const deadline = Date.now() + 3_000;
    while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) await Bun.sleep(20);

    // THE LEAK, measured. This is the state two orphaned ACP vendor fixtures
    // were found in on 2026-08-17: parent reaped, descendant alive.
    expect(isAlive(pid)).toBe(true);

    // And the fix reclaims it after the fact, which is the same call `exec`
    // makes on timeout.
    killTree(proc);
    const gone = Date.now() + 5_000;
    while (isAlive(pid) && Date.now() < gone) await Bun.sleep(20);
    expect(isAlive(pid)).toBe(false);
  }, 30_000);

  test("a process that exits on its own within the budget is unaffected", async () => {
    const result = await exec(["/bin/sh", "-c", "echo hi"], { timeoutMs: 5_000 });
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.trim()).toBe("hi");
  });
});

/**
 * A descendant that holds the WRITE END of the pipe after the process is dead.
 *
 * `Bun.spawn(..., { detached: true })` is a real `setsid(2)`, so the holder is
 * in a session of its own and `killTree`'s group signal cannot reach it — the
 * same shape as `bar/fakes/vendor.ts`'s escapee and as any real ACP vendor child
 * that daemonises. `stdout: "inherit"` hands it the very fd `exec` is reading,
 * which is what makes the stream unable to end.
 */
function pipeHolder(name: string): { argv: string[]; pidFile: string; source: string } {
  const pidFile = join(scratch, `${name}.pid`);
  const script = join(scratch, `${name}.ts`);
  return { argv: [process.execPath, script], pidFile, source: script };
}

function writeHolder(script: string, pidFile: string, thenHang: boolean): void {
  writeFileSync(
    script,
    [
      "// SPDX-License-Identifier: Apache-2.0",
      'import { writeFileSync } from "node:fs";',
      '// A NEW SESSION (`detached` is setsid(2)), inheriting this process\'s',
      "// stdout and stderr, so a group kill cannot reach it and the pipes stay",
      "// open after this process is gone.",
      'const holder = Bun.spawn(["/bin/sh", "-c", "sleep 30"], {',
      '  stdin: "ignore",',
      '  stdout: "inherit",',
      '  stderr: "inherit",',
      "  detached: true,",
      "});",
      "// Unref'd, or bun would keep THIS process alive waiting for the very",
      "// descendant the fixture needs to outlive it.",
      "holder.unref();",
      `writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));`,
      '// `Bun.write` rather than `process.stdout.write`: the awaited form is',
      "// flushed before the exit below, so the captured bytes are the fixture's",
      "// doing rather than a buffering accident.",
      'await Bun.write(Bun.stdout, "PARENT-SAID-THIS\\n");',
      thenHang ? "await new Promise(() => {});" : "process.exit(0);",
      "",
    ].join("\n"),
  );
}

/** Kill an escaped holder and its session. Bounded, and it reports rather than assumes. */
async function reapHolder(pid: number): Promise<boolean> {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone, or never a group leader.
    }
  }
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !isAlive(pid);
}

describe("a stream nobody will ever close cannot hang the harness", () => {
  test("the timeout returns even while an ESCAPED descendant holds the pipe open", async () => {
    if (process.platform === "win32") {
      notRunHere(
        "the timeout returning even while an ESCAPED descendant holds the pipe open",
        "the escape is `setsid`/`nohup`; on Windows it is `cmd /c start`, which #43 measured Bun's " +
          "job object letting through with BREAKAWAY_OK and SILENT_BREAKAWAY_OK. The hang this " +
          "guards against — a stream that never ends because something outside the group holds the " +
          "write end — is not a POSIX property, and it is unproven here.",
      );
    }
    const { argv, pidFile, source } = pipeHolder("held-timeout");
    writeHolder(source, pidFile, true);

    // BEFORE THE BOUND THIS HUNG FOREVER. The timeout fired, `killTree` reaped
    // the group, and `await new Response(proc.stdout).text()` then waited on a
    // stream whose write end was held by a process in another session — so the
    // reap of everything downstream of this call never ran. This test would not
    // fail slowly; it would never finish, which is why it carries its own
    // elapsed assertion rather than relying on the runner's timeout.
    const started = Date.now();
    const result = await exec(argv, { timeoutMs: 2_000 });
    const elapsed = Date.now() - started;

    expect(await waitForFile(pidFile, 5_000)).toBe(true);
    const holder = Number(readFileSync(pidFile, "utf8").trim());
    expect(holder).toBeGreaterThan(0);
    stragglers.push(holder);
    groups.push(holder);

    // THE NEGATIVE CONTROL, and it is the load-bearing line: the holder was
    // still ALIVE when `exec` returned. The stream therefore could not have
    // ended on its own, so returning was the bound doing its job and not the
    // fixture failing to reproduce the case.
    expect(isAlive(holder)).toBe(true);

    expect(elapsed).toBeLessThan(2_000 + STREAM_DRAIN_GRACE_MS + 10_000);
    expect(result.signal).toBe(TIMEOUT_SIGNAL);
    expect(result.code).toBeNull();
    // What was captured is RETURNED, not thrown away with the wait.
    expect(result.stdout).toContain("PARENT-SAID-THIS");
    // …and the truncation is in the bytes, so no reader can mistake a partial
    // stream for a program that printed nothing.
    expect(result.stdout).toContain(STREAM_TRUNCATED_MARKER);

    expect(await reapHolder(holder)).toBe(true);
  }, 30_000);

  test("a run that SUCCEEDS is bounded by the grace, not by its remaining timeout", async () => {
    if (process.platform === "win32") {
      notRunHere(
        "a SUCCESSFUL run being bounded by the drain grace rather than by its remaining timeout",
        "same `cmd /c start` gap as the arm above. This is the half that costs wall clock rather " +
          "than correctness — an unbounded version sits for the full timeout on a run that already " +
          "finished — and on the leg where `bar/fakes.test.ts` burned 966 seconds it is the one " +
          "nobody could rule out.",
      );
    }
    const { argv, pidFile, source } = pipeHolder("held-exit");
    writeHolder(source, pidFile, false);

    // The process exits 0 immediately; the escaped holder keeps the pipe open.
    // With a 60 s timeout and no bound, this call would sit for the full 60 s
    // for a run that had already finished — the same hang wearing a success.
    const started = Date.now();
    const result = await exec(argv, { timeoutMs: 60_000 });
    const elapsed = Date.now() - started;

    expect(await waitForFile(pidFile, 5_000)).toBe(true);
    const holder = Number(readFileSync(pidFile, "utf8").trim());
    stragglers.push(holder);
    groups.push(holder);

    expect(elapsed).toBeLessThan(20_000);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("PARENT-SAID-THIS");
    expect(result.stdout).toContain(STREAM_TRUNCATED_MARKER);

    expect(await reapHolder(holder)).toBe(true);
  }, 45_000);

  test("NEGATIVE CONTROL: nothing is marked truncated when the streams close normally", async () => {
    // Without this the marker could be appended unconditionally and both tests
    // above would still pass.
    const result = await exec(["/bin/sh", "-c", "echo hi; echo there >&2"], { timeoutMs: 5_000 });
    expect(result.stdout).toBe("hi\n");
    expect(result.stderr).toBe("there\n");
    expect(result.stdout).not.toContain(STREAM_TRUNCATED_MARKER);
    expect(result.stderr).not.toContain(STREAM_TRUNCATED_MARKER);
  });
});
