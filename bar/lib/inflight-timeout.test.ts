// SPDX-License-Identifier: Apache-2.0
/**
 * `runSampled`'s timeout, against the same defect `bar/lib/proc.test.ts` names
 * for `exec`.
 *
 * `runSampled` is the OTHER place that spawns the real binary and kills it on a
 * timeout — items 2, 3, 4, 9, 11 and 12 all drive live runs through it while
 * sampling the filesystem and the process table. It had its own copy of the
 * single-pid `proc.kill("SIGKILL")`, so a timeout here would have left the same
 * kind of orphaned ACP vendor child behind that `exec`'s did. Proven the same
 * way: a `/bin/sh` standing in for the binary backgrounds a child, the sampled
 * run times out, and the child must not outlive it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STREAM_DRAIN_GRACE_MS, STREAM_TRUNCATED_MARKER } from "./proc.ts";
import { runSampled } from "./inflight.ts";
import { notRunHere } from "./platform.ts";

let scratch: string | undefined;
const stragglers: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  for (const pid of stragglers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is what this file is trying to prove.
    }
  }
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

test("a backgrounded child of a sampled run does not outlive its timeout", async () => {
  if (process.platform === "win32") {
    notRunHere(
      "a backgrounded child of a SAMPLED run not outliving its timeout",
      "the fixture backgrounds with `&` inside `/bin/sh`, and `cmd.exe` has no `&` job control to " +
        "model that with — `start /b` is the nearest thing and it detaches differently. The property " +
        "is real on Windows and the fixture for it is not written.",
    );
  }
  scratch ??= realpathSync(mkdtempSync(join(tmpdir(), "brigadier-inflight-proc-")));
  const runRoot = join(scratch, "runs");
  const pidFile = join(scratch, "child.pid");

  const result = await runSampled(
    ["/bin/sh", "-c", `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; sleep 300`],
    { runRoot, timeoutMs: 500, intervalMs: 20 },
  );

  expect(result.code).toBeNull();
  expect(result.signal).toBe("BAR_TIMEOUT");

  const deadline = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(pidFile)).toBe(true);
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  expect(childPid).toBeGreaterThan(0);
  stragglers.push(childPid);

  expect(isAlive(childPid)).toBe(false);
}, 20_000);

test("an ESCAPED descendant holding the pipe cannot hang a sampled run", async () => {
  if (process.platform === "win32") {
    notRunHere(
      "an ESCAPED descendant holding the pipe not hanging a sampled run",
      "the escape is `setsid`/`nohup`; the Windows mechanism is `cmd /c start`, which #43 measured " +
        "Bun's job object letting through with BREAKAWAY_OK and SILENT_BREAKAWAY_OK. That is the " +
        "one escape route this project has MEASURED on Windows and never driven, so this is the " +
        "test whose absence costs most here.",
    );
  }
  scratch ??= realpathSync(mkdtempSync(join(tmpdir(), "brigadier-inflight-proc-")));
  const runRoot = join(scratch, "runs-held");
  const pidFile = join(scratch, "holder.pid");
  const script = join(scratch, "holder.ts");
  writeFileSync(
    script,
    [
      "// SPDX-License-Identifier: Apache-2.0",
      'import { writeFileSync } from "node:fs";',
      "// A new session (`detached` is setsid(2)) inheriting this process's stdout,",
      "// so the group kill cannot reach it and the pipe stays open afterwards.",
      'const holder = Bun.spawn(["/bin/sh", "-c", "sleep 30"], {',
      '  stdin: "ignore",',
      '  stdout: "inherit",',
      '  stderr: "inherit",',
      "  detached: true,",
      "});",
      "holder.unref();",
      `writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));`,
      'await Bun.write(Bun.stdout, "PARENT-SAID-THIS\\n");',
      "await new Promise(() => {});",
      "",
    ].join("\n"),
  );

  // Worse here than in `exec` before the bound: `running` stays true while the
  // read is pending, so the sampler behind the hang kept forking `ps` over the
  // whole machine, once every 20 ms, indefinitely.
  const started = Date.now();
  const result = await runSampled([process.execPath, script], { runRoot, timeoutMs: 2_000, intervalMs: 40 });
  const elapsed = Date.now() - started;

  const deadline = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(20);
  const holder = Number(readFileSync(pidFile, "utf8").trim());
  expect(holder).toBeGreaterThan(0);
  stragglers.push(holder);

  // The negative control: it was still ALIVE when the call returned, so the
  // stream could not have ended by itself.
  expect(isAlive(holder)).toBe(true);

  expect(elapsed).toBeLessThan(2_000 + STREAM_DRAIN_GRACE_MS + 10_000);
  expect(result.signal).toBe("BAR_TIMEOUT");
  expect(result.stdout).toContain("PARENT-SAID-THIS");
  expect(result.stdout).toContain(STREAM_TRUNCATED_MARKER);
  // Named, so an item can tell "printed nothing" from "could not be read".
  expect(result.truncated).toContain("stdout");

  for (const target of [-holder, holder]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  const gone = Date.now() + 5_000;
  while (isAlive(holder) && Date.now() < gone) await Bun.sleep(20);
  expect(isAlive(holder)).toBe(false);
}, 45_000);

/**
 * The dedup's own guard.
 *
 * `sampleOnce` used to filter a private `listProcesses()` that read
 * `ps -A -o args=`; it now filters the one reader in
 * `bar/lib/process-table.ts`, which reads the same `args` column with three
 * numeric ones in front of it. The property that must not have moved is the
 * only thing any caller observes: a process carrying ruling 38's marker in its
 * COMMAND LINE is counted and quoted, and one without it is not. Both
 * directions, because a counter that counts everything looks identical to a
 * working one from the passing side.
 */
test("the marker filter still counts a marked process, and only a marked one", async () => {
  if (process.platform === "win32") {
    notRunHere(
      "the marker filter counting a marked process and ONLY a marked one",
      "the fixture shapes argv through `sh -c`, and reproducing it with `cmd /c` would measure " +
        "cmd's quoting rather than the filter. `bar/lib/process-table.ts` has a real Windows reader " +
        "(`readWindowsTable`), so this one is a fixture away from running rather than a mechanism " +
        "away — which makes it the cheapest of the eleven to close.",
    );
  }
  scratch ??= realpathSync(mkdtempSync(join(tmpdir(), "brigadier-inflight-proc-")));
  // The marker rides as `$0`, so it is in the argv `ps` prints without changing
  // what the shell runs. `--brigadier-run` is written out rather than imported
  // from the product, exactly as `bar/lib/inflight.ts` says.
  //
  // `; :` IS LOAD-BEARING. MEASURED on macOS 26.5.2 (Darwin 25.5.0) with
  // `bun 1.3.14` on 2026-08-19: `/bin/sh -c "sleep 3" --brigadier-run=probeA/1`
  // does not appear in `ps -A -o pid=,args=` at all, because a shell running one
  // simple command `exec`s it and the shell's argv — marker included — is gone.
  // The two-command form kept the whole line. That is not this test being
  // fussy: it is the exact limit `src/run/marker.ts` documents about ruling 38's
  // marker, reproduced in the fixture that would otherwise have measured it away.
  const marked = await runSampled(["/bin/sh", "-c", "sleep 2; :", "--brigadier-run=barsample/1"], {
    runRoot: join(scratch, "runs-marked"),
    timeoutMs: 15_000,
    intervalMs: 40,
  });
  expect(marked.flight.peakMarkedProcesses).toBeGreaterThan(0);
  expect(marked.flight.markedCommandLines.some((line) => line.includes("--brigadier-run=barsample/1"))).toBe(true);

  // NEGATIVE CONTROL: the same shape without the marker. `sleep 2` and a
  // sentinel that could only appear if the filter had stopped filtering.
  const unmarked = await runSampled(["/bin/sh", "-c", "sleep 2; :", "bar-unmarked-sentinel"], {
    runRoot: join(scratch, "runs-unmarked"),
    timeoutMs: 15_000,
    intervalMs: 40,
  });
  expect(unmarked.flight.markedCommandLines.some((line) => line.includes("bar-unmarked-sentinel"))).toBe(false);
}, 60_000);

test("NEGATIVE CONTROL: a sampled run whose streams close normally is not marked truncated", async () => {
  scratch ??= realpathSync(mkdtempSync(join(tmpdir(), "brigadier-inflight-proc-")));
  const result = await runSampled(["/bin/sh", "-c", "echo hi"], {
    runRoot: join(scratch, "runs-clean"),
    timeoutMs: 5_000,
    intervalMs: 40,
  });
  expect(result.truncated).toEqual([]);
  expect(result.stdout).toBe("hi\n");
}, 20_000);
