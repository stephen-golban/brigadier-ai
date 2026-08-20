// SPDX-License-Identifier: Apache-2.0
/**
 * The escape ruling 38 actually gets, and the link that reaches it.
 *
 * `test/sweep-escape.test.ts` already proves the `setsid(2)` case for a
 * descendant that CARRIES THE MARKER, and states as a deliberate negative that
 * an UNMARKED one is invisible. Both halves of that hold. What neither covers
 * is the combination that occurs in an ordinary run, and it is the combination
 * BAR item 7 drives against the real binary:
 *
 *   - the descendant is UNMARKED, because an AGENT spawned it and brigadier
 *     cannot write argv for a process it did not spawn; and
 *   - its ppid is 1, because the shell that launched it exited immediately —
 *     `sh -c 'setsid … &'` and `sh -c 'nohup … &'` both do this within
 *     milliseconds.
 *
 * The marker link and the ppid link are cut at the same time, by an ordinary
 * idiom. REPRODUCED on this host on 2026-08-18 before the working-directory
 * link existed: the sweep reported `reclaimedPids: [worker, sleep],
 * survivors: []` while the escapee's heartbeat grew from 6 to 11 bytes across
 * the measurement — a clean bill of health for a process that was still
 * writing to disk. The first test below is that reproduction, with the control
 * and the fix in one place so neither can drift from the other.
 *
 * EVERY GUARD HERE HAS ITS NEGATIVE, and they are the two ways this link could
 * be wrong rather than absent:
 *
 *   - a process standing OUTSIDE every manifest-recorded directory is
 *     untouched, or "reclaim by working directory" would mean "reclaim
 *     everything";
 *   - a process standing INSIDE one while holding a controlling terminal as its
 *     own process group leader is untouched, because that is a person. brigadier
 *     retains interrupted clones and prints their paths, so reading one is a
 *     thing the product invites.
 *
 * NOTHING HERE ASSERTS ON A BOOLEAN THE SWEEP RETURNED. Death is asserted as
 * absence from a FRESH reading of the process table, as `kill(pid, 0)`, and as
 * a heartbeat file that has stopped growing across four of its own tick
 * intervals.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMarkerArg } from "../src/run/marker.ts";
import {
  isAlive,
  noWorkspaceReading,
  parseCwdRows,
  parseTerminalRows,
  readWorkspaceOccupants,
  scanProcessTable,
  type CommandResult,
} from "../src/run/processes.ts";
import { describeSweep, sweep } from "../src/run/sweep.ts";

let scratch: string;
let launcher: string;
/** Every pid this file caused to exist, reaped in `afterAll` by COMMAND LINE. */
const spawned: number[] = [];

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Wait for a heartbeat to GROW rather than sleeping a fixed interval.
 *
 * The same reasoning as `sweep-escape.test.ts`: a starved process can miss
 * several ticks without being any less alive, and this direction of the
 * assertion fails when that happens. The opposite assertion — that it has
 * STOPPED — stays a fixed wait, because starvation there makes the test pass
 * rather than fail, and it is corroborated by the pid being absent from a fresh
 * process table.
 */
async function grewWithin(path: string, from: number, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let latest = size(path);
  while (Date.now() < deadline && latest <= from) {
    await Bun.sleep(100);
    latest = size(path);
  }
  return latest;
}

/**
 * Spawn the escapee the way an agent's tool really does it, and wait until both
 * links to brigadier are actually cut.
 *
 * The launcher is a separate short-lived process ON PURPOSE. A `detached: true`
 * child of this test runner would keep a live ppid pointing at a process the
 * sweep can see; the whole difficulty is that the intermediate exits, so the
 * escapee is reparented to pid 1 and there is nothing to walk. `detached: true`
 * is a real `setsid(2)` on this runtime — MEASURED on macOS 26.5.2 (Darwin
 * 25.5.0 arm64) with `bun 1.3.14` on 2026-08-17, `sid == pgid == pid`.
 */
async function escape(cwd: string, heartbeat: string): Promise<number> {
  const child = Bun.spawn([process.execPath, launcher, heartbeat, cwd], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const printed = await new Response(child.stdout).text();
  await child.exited;
  const pid = Number(printed.trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  spawned.push(pid);
  // Reparenting is what makes this fixture the thing it claims to be, so it is
  // OBSERVED rather than assumed: without it the ppid closure would still reach
  // the escapee and the test would prove nothing about the third link.
  const deadline = Date.now() + 15_000;
  let row = scanProcessTable().rows.find((candidate) => candidate.pid === pid);
  while (Date.now() < deadline && row !== undefined && row.ppid !== 1) {
    await Bun.sleep(50);
    row = scanProcessTable().rows.find((candidate) => candidate.pid === pid);
  }
  expect(row?.ppid).toBe(1);
  return pid;
}

/** A marked worker: cheap, and its marker really is visible to `ps`. */
function marked(cwd: string, heartbeat: string, marker: string): number {
  const child = Bun.spawn(
    process.platform === "win32"
      ? ["bun", "-e", "setInterval(() => {}, 1000)", marker]
      : ["/bin/sh", "-c", `while :; do printf . >> "${heartbeat}"; sleep 0.2; done`, "sh", marker],
    { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  spawned.push(child.pid);
  return child.pid;
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-cwd-")));
  launcher = join(scratch, "launcher.ts");
  writeFileSync(
    launcher,
    [
      "// SPDX-License-Identifier: Apache-2.0",
      "// Stands in for an agent's tool call: it detaches one descendant into its",
      "// own session and exits, which reparents that descendant to pid 1.",
      'import { spawn } from "node:child_process";',
      "const [heartbeat, cwd] = process.argv.slice(2);",
      "const argv = process.platform === 'win32'",
      "  ? [process.execPath, '-e', `setInterval(() => { require('fs').appendFileSync(${JSON.stringify(heartbeat)}, '.'); }, 200)`]",
      "  : ['/bin/sh', '-c', `while :; do printf . >> \"${heartbeat}\"; sleep 0.2; done`];",
      "const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore', cwd });",
      "child.unref();",
      "process.stdout.write(`${child.pid}\\n`);",
    ].join("\n"),
  );
});

/**
 * Kill a pid ONLY if it is still the process this file spawned.
 *
 * Ruling 38's own rule turned on the test: identity comes from the COMMAND
 * LINE, never from a number. MEASURED on this host on 2026-08-17, repeated runs
 * of this suite wrapped the pid space, and a cleanup that kills a bare recorded
 * pid after a wrap kills whatever now holds that number.
 */
function reap(pid: number): void {
  const row = scanProcessTable().rows.find((candidate) => candidate.pid === pid);
  if (row === undefined) return;
  if (!row.commandLine.includes(scratch)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Exited between the reading and the signal, which is the outcome we wanted.
  }
}

afterAll(() => {
  for (const pid of spawned) reap(pid);
  rmSync(scratch, { recursive: true, force: true });
});

describe("an unmarked descendant that also lost its parent is still reclaimed", () => {
  test("the marker and the ppid graph both miss it; the manifest's directory does not", async () => {
    const runId = `cwd${Date.now().toString(36)}${process.pid.toString(36)}`;
    const clone = join(scratch, `${runId}-clone`);
    const elsewhere = join(scratch, `${runId}-elsewhere`);
    mkdirSync(clone, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const hbWorker = join(scratch, `${runId}-worker.log`);
    const hbEscapee = join(scratch, `${runId}-escapee.log`);
    const hbStranger = join(scratch, `${runId}-stranger.log`);

    const workerPid = marked(clone, hbWorker, runMarkerArg(runId, 1));
    const escapeePid = await escape(clone, hbEscapee);
    // The vacuity control, spawned identically and standing somewhere the
    // manifest never recorded. Without it, "the escapee died" is also what a
    // sweep that killed every detached process on the machine would look like.
    const strangerPid = await escape(elsewhere, hbStranger);

    // The fixture is sound before anything is concluded from it.
    expect(await grewWithin(hbEscapee, 0, 20_000)).toBeGreaterThan(0);
    expect(await grewWithin(hbStranger, 0, 20_000)).toBeGreaterThan(0);
    expect({ worker: isAlive(workerPid), escapee: isAlive(escapeePid), stranger: isAlive(strangerPid) })
      .toEqual({ worker: true, escapee: true, stranger: true });
    // Neither of the first two links can see it: no marker in its argv, and its
    // parent is pid 1 rather than anything of brigadier's.
    const before = scanProcessTable();
    const escapeeRow = before.rows.find((row) => row.pid === escapeePid);
    expect(escapeeRow?.commandLine).not.toContain("--brigadier-run");
    expect(escapeeRow?.ppid).toBe(1);

    // THE REPRODUCTION. With only the marker and the ppid graph, the sweep
    // reports a clean bill of health for a process that is still writing.
    const blind = await sweep({ scope: { runId }, sweptBy: "sweep-workspace.test.ts (no manifest)", table: before });
    expect(blind.evidence.reclaimedPids).toContain(workerPid);
    expect(blind.evidence.survivors).toEqual([]);
    expect(blind.matched.some((match) => match.pid === escapeePid)).toBe(false);
    expect(isAlive(escapeePid)).toBe(true);
    const escapedAtBlindSweep = size(hbEscapee);
    const escapedBeforeSweep = await grewWithin(hbEscapee, escapedAtBlindSweep, 15_000);
    expect(escapedBeforeSweep).toBeGreaterThan(escapedAtBlindSweep);

    // THE FIX. The same sweep, handed the directory the run's manifest recorded
    // before it created it.
    const outcome = await sweep({
      scope: { runId },
      sweptBy: "sweep-workspace.test.ts",
      table: scanProcessTable(),
      workspaces: [{ item: 1, dir: clone }],
    });

    const found = outcome.matched.find((match) => match.pid === escapeePid);
    expect(found?.disposition).toBe("reclaimed");
    expect(found?.via).toBe("working-directory");
    expect(found?.marked).toBe(false);
    // Per-item, exactly as a marked process would be: the item travels with the
    // directory, so this evidence is about item 1 and not about "the run".
    expect(found?.item).toBe(1);

    // OBSERVABLY GONE, three ways, none of them a value the sweep returned.
    expect(scanProcessTable().rows.some((row) => row.pid === escapeePid)).toBe(false);
    expect(isAlive(escapeePid)).toBe(false);
    const afterSweep = size(hbEscapee);
    await Bun.sleep(900); // four of its own 200 ms tick intervals
    const settled = size(hbEscapee);
    expect(settled).toBe(afterSweep);
    // Asserted on the bytes it escaped with: it really did write while it was
    // out of reach, and it really did stop.
    expect(afterSweep).toBeGreaterThan(escapedAtBlindSweep);

    // NEGATIVE CONTROL: the stranger, spawned by the same code in the same way,
    // standing outside every recorded directory. Untouched, and still writing.
    expect(outcome.matched.some((match) => match.pid === strangerPid)).toBe(false);
    expect(isAlive(strangerPid)).toBe(true);
    const strangerAfter = size(hbStranger);
    expect(await grewWithin(hbStranger, strangerAfter, 15_000)).toBeGreaterThan(strangerAfter);

    reap(strangerPid);
  }, 120_000);
});

describe("the one occupant that is a person, not a leaked worker", () => {
  test("a job with a controlling terminal inside the clone is reported and NOT signalled", async () => {
    const runId = `ppl${Date.now().toString(36)}${process.pid.toString(36)}`;
    const clone = join(scratch, `${runId}-clone`);
    mkdirSync(clone, { recursive: true });
    const heartbeat = join(scratch, `${runId}-person.log`);

    // A REAL pty, because the guard is about a controlling terminal and a
    // controlling terminal cannot be faked with file descriptors. MEASURED on
    // macOS 26.5.2 on 2026-08-18: `script -q /dev/null` allocates one, and the
    // job inside it comes back `pgid == pid` with `ttys000`, while the same
    // loop launched through `sh -c '… &'` comes back `??` and in its spawner's
    // process group.
    //
    // `script` IS TWO DIFFERENT PROGRAMS AND THEY DISAGREE ABOUT ARGUMENT ORDER.
    // The BSD one macOS ships takes the command as trailing operands after the
    // typescript file; util-linux's takes it as `-c` and the file last.
    //
    // MEASURED against `script from util-linux 2.39.3` on `ubuntu:24.04` on
    // 2026-08-20, both forms, in both directions:
    //   `script -q /dev/null /bin/sh -c CMD`  → exit 1, "script: unexpected
    //       number of arguments". Nothing runs at all.
    //   `script -q -c CMD /dev/null`          → exit 0, CMD ran, and `tty`
    //       inside it reported `/dev/pts/0` — a real controlling terminal.
    //
    // The first form is what this test used until 2026-08-20, which is why it
    // failed on ubuntu-latest on every run of `gates.yml`: the session never
    // started, the heartbeat never grew, and the assertion below read `0`. The
    // product was never involved. Note this is NOT a widened tolerance — the
    // `grewWithin` assertion is unchanged, and it is exactly what makes a wrong
    // arm here fail loudly rather than pass on an empty scan.
    const pty = Bun.which("script");
    expect(pty).not.toBeNull();
    const loop = `cd "${clone}" && while :; do printf . >> "${heartbeat}"; sleep 0.2; done`;
    const session = Bun.spawn(
      process.platform === "linux"
        ? [pty as string, "-q", "-c", loop, "/dev/null"]
        : [pty as string, "-q", "/dev/null", "/bin/sh", "-c", loop],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    spawned.push(session.pid);
    expect(await grewWithin(heartbeat, 0, 20_000)).toBeGreaterThan(0);

    const occupants = readWorkspaceOccupants();
    const person = [...occupants.cwds]
      .filter(([pid, cwd]) => cwd === clone && occupants.interactive.has(pid))
      .map(([pid]) => pid);
    expect(person.length).toBeGreaterThan(0);
    for (const pid of person) spawned.push(pid);

    const outcome = await sweep({
      scope: { runId },
      sweptBy: "sweep-workspace.test.ts",
      table: scanProcessTable(),
      workspaces: [{ item: 4, dir: clone }],
      occupants,
    });

    for (const pid of person) {
      const match = outcome.matched.find((candidate) => candidate.pid === pid);
      expect(match?.disposition).toBe("terminal");
      expect(match?.item).toBe(4);
      // NOT a survivor: `survivors` means brigadier signalled and could not
      // confirm death, and nothing was signalled here.
      expect(outcome.evidence.survivors).not.toContain(pid);
      expect(outcome.evidence.reclaimedPids).not.toContain(pid);
      // Alive afterwards, and still writing — the assertion that matters.
      expect(isAlive(pid)).toBe(true);
    }
    const after = size(heartbeat);
    expect(await grewWithin(heartbeat, after, 15_000)).toBeGreaterThan(after);

    // Reported with the exact pid, because "something was left alone" is a
    // worry rather than a remedy.
    const printed = describeSweep(outcome).join("\n");
    expect(printed).toContain(`pid ${person[0]}`);
    expect(printed).toContain("was NOT signalled");
    expect(outcome.coverage.limits.join(" ")).toContain("holds a controlling terminal");

    for (const pid of person) reap(pid);
    session.kill("SIGKILL");
    await session.exited;
  }, 90_000);
});

describe("the working-directory reading says what it could not see", () => {
  const ok = (stdout: string): CommandResult => ({ code: 0, stdout });

  test("both readers parse the forms the platform actually produces", () => {
    expect([...parseCwdRows("p101\nfcwd\nn/a/b\np102\nfcwd\nn/c\n")]).toEqual([
      [101, "/a/b"],
      [102, "/c"],
    ]);
    // A `p` line with no `n` line is a process lsof could not resolve, and it
    // must not inherit the previous process's directory.
    expect([...parseCwdRows("p101\nfcwd\nn/a\np102\nfcwd\n")]).toEqual([[101, "/a"]]);
    // A person leads their own process group AND holds a terminal. MEASURED
    // rows from macOS 26.5.2 on 2026-08-18.
    expect([...parseTerminalRows("28960 28953 ??\n28963 28963 ttys000\n28970 28953 ttys000\n")]).toEqual([28963]);
  });

  test("NEGATIVE: a reader that fails produces an EMPTY reading with the reason, never a quiet machine", () => {
    const thrown = readWorkspaceOccupants({
      platform: "darwin",
      run: () => {
        throw new Error("lsof: command not found");
      },
    });
    expect(thrown.cwds.size).toBe(0);
    expect(thrown.limits.join(" ")).toContain("lsof: command not found");
    expect(thrown.limits.join(" ")).toContain("invisible to this sweep");

    // The DANGEROUS half: without the terminal reading brigadier cannot tell a
    // leaked descendant from the operator's shell, so the whole reading goes
    // rather than half of it.
    const halfBlind = readWorkspaceOccupants({
      platform: "darwin",
      run: (argv) => (argv.includes("lsof") ? ok("p101\nfcwd\nn/a\n") : { code: 1, stdout: "" }),
    });
    expect(halfBlind.cwds.size).toBe(0);
    expect(halfBlind.interactive.size).toBe(0);
    expect(halfBlind.limits.join(" ")).toContain("half-blind");

    // Windows has no working-directory column at all, and says so rather than
    // reporting an empty machine.
    const windows = readWorkspaceOccupants({ platform: "win32" });
    expect(windows.cwds.size).toBe(0);
    expect(windows.limits.join(" ")).toContain("Win32_Process");
  });

  test("a sweep with no reading falls back to the first two links and carries the reason", async () => {
    const runId = `lim${process.pid.toString(36)}`;
    const outcome = await sweep({
      scope: { runId },
      sweptBy: "sweep-workspace.test.ts",
      table: { rows: [{ pid: 999_001, ppid: 1, commandLine: "sh loop" }], source: "injected", scannedAt: 0, limits: [] },
      workspaces: [{ item: 1, dir: join(scratch, "nowhere") }],
      occupants: noWorkspaceReading("not read", "the reader was unavailable in this test"),
      isAlive: () => false,
      signal: () => "gone",
    });
    expect(outcome.matched).toEqual([]);
    expect(outcome.coverage.limits.join(" ")).toContain("the reader was unavailable in this test");
    expect(outcome.coverage.completeness).toBe("not-proven");
  }, 30_000);
});
