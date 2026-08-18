// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 63's drain, against the escapee that cuts BOTH of the sweep's original
 * links.
 *
 * THE HOLE. `src/queue/execute.ts`'s interrupt drain swept `{ scope, sweptBy }`
 * and nothing else, so it matched on ruling 38's command-line marker and on the
 * ppid graph. One ordinary idiom cuts both at once, and it was confirmed in the
 * wild rather than reasoned about: an escapee still alive 31 MINUTES after its
 * run was SIGKILLed, with ppid 1. An agent-spawned descendant is UNMARKED, so
 * the marker does not match it, and it reparents to pid 1 within milliseconds,
 * so the ppid graph does not reach it. Neither link survives.
 *
 * THE THIRD LINK is ruling 15's provenance applied to a process rather than to
 * a path: a working directory inside a directory this run's manifest recorded
 * BEFORE it existed. The descendant cannot cut it, because it is not something
 * the descendant carries — it is where it is standing. MEASURED on macOS 26.5.2
 * (Darwin 25.5.0): `ps -E` and `ps eww` print NO environment for a same-uid
 * child, so the environment was never available as an identification channel
 * and the working directory is what replaced it.
 *
 * WHY IT MATTERS HERE SPECIFICALLY. Ruling 63's promise is four facts, and the
 * fourth is *the exact pids that would not confirm dead*. An escapee the drain
 * never sees cannot appear in it, so the promise reads complete while being
 * silently short. `src/run/start.ts` already passes `workspaces` at START, and
 * ruling 38 wants the sweep at BOTH ends precisely because either can be cut
 * off — start coverage is the backstop for a drain that never ran, not an
 * excuse for a drain that runs and does not look.
 *
 * ASSERTED ON BYTES, NOT ON A BOOLEAN THE SWEEP RETURNED. A sweep reporting
 * `reclaimed` is the sweep grading its own work, and that is the exact shape
 * ruling 52 exists to distrust. So: the pid's absence from a FRESH `ps`, and a
 * heartbeat file that has stopped growing across a bounded window.
 *
 * THE PAIRED CONTROL is the whole reason this is a rule and not a massacre: an
 * identical detached process standing OUTSIDE every recorded directory SURVIVES
 * the same drain. Without it "the escapee is gone" is also satisfied by a sweep
 * that kills everything on the machine.
 *
 * MACHINE DISCIPLINE. One CLI process at a time, one planted agent, every wait
 * bounded, the heartbeats self-terminate on their own deadline, and `afterAll`
 * kills whatever is still alive so nothing outlives this file.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CANCEL_DEADLINE_MS } from "../src/run/interrupt.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const ROOT = mkdtempSync(join(homedir(), ".brigadier-drainws-test-"));

/**
 * A detached process that leaves a growing trail.
 *
 * The trail is the point: "is it gone" answered by a file that stops growing is
 * answered in bytes, and a pid that a sweep merely *reported* killing is not.
 * The deadline is its own, so an abandoned run cannot leave this on the
 * operator's machine.
 */
const HEARTBEAT_SOURCE = `
import { appendFileSync } from "node:fs";
const file = Bun.argv[2];
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  appendFileSync(file, ".");
  await Bun.sleep(100);
}
`;

/**
 * A worker that spawns two unmarked descendants, orphans both, and then hangs.
 *
 * `sh -c '… &'` is the ordinary idiom: the shell forks, backgrounds, and exits
 * immediately, so the grandchild is reparented to pid 1 before this agent's
 * next line runs. Neither descendant carries `--brigadier-run` — nothing put it
 * there, which is exactly the case ruling 38's marker cannot cover.
 *
 * The hang is required rather than decorative: a worker that finishes instantly
 * is never in the state ruling 63's first interrupt is about.
 */
const AGENT_SOURCE = `
const config = JSON.parse(await Bun.file(Bun.argv[2]).text());
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const parent = process.ppid;
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let nl = buffer.indexOf("\\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\\n");
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === undefined) continue;
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "planted", version: "1.0.0" }, agentCapabilities: {} } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
    } else if (msg.method === "session/set_mode" || msg.method === "session/set_model") {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "session/prompt") {
      const detach = (cwd, beat, pidFile) => {
        Bun.spawnSync(["/bin/sh", "-c",
          "cd " + cwd + " && " + config.bun + " " + config.heartbeat + " " + beat + " >/dev/null 2>&1 & echo $! > " + pidFile]);
      };
      // INSIDE the clone the manifest recorded before it existed.
      detach(process.cwd(), config.insideBeat, config.insidePid);
      // OUTSIDE every recorded directory. The control.
      detach(config.outsideDir, config.outsideBeat, config.outsidePid);
      for (let i = 0; i < 300; i++) {
        await Bun.sleep(200);
        if (process.ppid !== parent) process.exit(0);
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not implemented" } });
    }
  }
}
`;

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

/** One field of one pid, from a FRESH `ps`. Empty when the process is gone. */
function psField(pid: number, field: "pid=" | "ppid=" | "args="): string {
  const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", field], { stdout: "pipe", stderr: "pipe" });
  return proc.stdout.toString().trim();
}

function alive(pid: number): boolean {
  return psField(pid, "pid=") !== "";
}

function bytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

const dir = join(ROOT, "world");
const repo = join(dir, "repo");
const runs = join(dir, "runs");
const bin = join(dir, "bin");
const outsideDir = join(dir, "outside");
const insideBeat = join(dir, "inside-beat.txt");
const outsideBeat = join(dir, "outside-beat.txt");
const insidePid = join(dir, "inside.pid");
const outsidePid = join(dir, "outside.pid");
for (const path of [repo, runs, bin, outsideDir]) mkdirSync(path, { recursive: true });

git(repo, ["init", "-q", "-b", "main", "."]);
writeFileSync(join(repo, "README.md"), "base\n");
git(repo, ["add", "-A"]);
git(repo, ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "base"]);

const heartbeat = join(dir, "heartbeat.ts");
writeFileSync(heartbeat, HEARTBEAT_SOURCE);
const agent = join(dir, "agent.ts");
writeFileSync(agent, AGENT_SOURCE);
const config = join(dir, "qwen.json");
writeFileSync(
  config,
  JSON.stringify({ bun: process.execPath, heartbeat, insideBeat, outsideBeat, insidePid, outsidePid, outsideDir }),
);
const script = join(bin, "qwen");
writeFileSync(script, `#!/bin/sh\nexec ${process.execPath} ${agent} ${config} "$@"\n`);
chmodSync(script, 0o755);

const planPath = join(dir, "plan.json");
writeFileSync(
  planPath,
  JSON.stringify({
    version: 1,
    items: [{ id: "slow", kind: "write", paths: ["slow.txt"], prompt: "out=slow.txt" }],
  }),
);

let insidePidNumber = 0;
let outsidePidNumber = 0;
let insidePpidBefore = "";
let insideArgsBefore = "";

/** Cleanup never sits downstream of an unbounded wait, and never kills a stranger. */
afterAll(() => {
  for (const pid of [insidePidNumber, outsidePidNumber]) {
    if (pid > 0 && alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone between the check and the signal, which is the good case.
      }
    }
  }
  rmSync(ROOT, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms`);
}

async function settle(proc: Bun.Subprocess, timeoutMs: number): Promise<void> {
  const outcome = await Promise.race([
    proc.exited.then(() => "exited" as const),
    Bun.sleep(timeoutMs).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error(`the run did not settle within ${timeoutMs} ms after the signal`);
  }
}

describe("ruling 63: the drain reaches an UNMARKED descendant that reparented to pid 1", () => {
  let stderr = "";

  test("setup: two orphaned, unmarked descendants exist, then one SIGINT arrives", async () => {
    const proc = Bun.spawn(
      [process.execPath, CLI, "run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--audience", "terminal"],
      {
        env: {
          HOME: ROOT,
          USER: process.env["USER"] ?? "test",
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = new Response(proc.stdout as ReadableStream).text();
    const err = new Response(proc.stderr as ReadableStream).text();

    await waitFor(() => existsSync(insidePid) && existsSync(outsidePid), 90_000, "the descendants were never spawned");
    insidePidNumber = Number(readFileSync(insidePid, "utf8").trim());
    outsidePidNumber = Number(readFileSync(outsidePid, "utf8").trim());
    // Both must be running and both must be growing before the signal, or the
    // assertions afterwards are about a process that was never there.
    await waitFor(() => bytes(insideBeat) > 0 && bytes(outsideBeat) > 0, 30_000, "neither heartbeat started");
    insidePpidBefore = psField(insidePidNumber, "ppid=");
    insideArgsBefore = psField(insidePidNumber, "args=");

    proc.kill("SIGINT");
    await settle(proc, CANCEL_DEADLINE_MS + 120_000);
    stderr = await err;
    void (await out);
    expect(insidePidNumber).toBeGreaterThan(0);
    expect(outsidePidNumber).toBeGreaterThan(0);
  }, 300_000);

  test("BOTH original links really were cut: unmarked, and ppid 1", () => {
    // Without this the test would pass on a machine where the sweep found the
    // escapee through the marker or the ppid graph, proving nothing about the
    // third link.
    expect(insideArgsBefore).not.toContain("--brigadier-run");
    expect(insidePpidBefore).toBe("1");
  });

  test("the escapee is OBSERVABLY GONE — absent from a fresh `ps`, and its trail stopped", async () => {
    expect(psField(insidePidNumber, "pid=")).toBe("");
    const before = bytes(insideBeat);
    await Bun.sleep(700);
    // Bytes, not a boolean the sweep returned. A file that has stopped growing
    // is the process being dead; a `reclaimed` field is the sweep grading its
    // own work.
    expect(bytes(insideBeat)).toBe(before);
    expect(before).toBeGreaterThan(0);
  }, 30_000);

  test("PAIRED CONTROL: the identical process OUTSIDE every recorded directory SURVIVES", async () => {
    // The rule is "inside a directory this run's manifest recorded", not "kill
    // everything". This is the assertion that keeps it from quietly becoming
    // the second thing.
    expect(psField(outsidePidNumber, "pid=")).not.toBe("");
    const before = bytes(outsideBeat);
    await Bun.sleep(700);
    expect(bytes(outsideBeat)).toBeGreaterThan(before);
  }, 30_000);

  test("and the run still kept ruling 63's promise in the ordinary way", () => {
    const runId = readdirSync(join(runs, "r"))[0] ?? "";
    expect(existsSync(join(runs, "r", runId, "record.json"))).toBe(true);
    expect(stderr).toContain("session/cancel");
  });
});
