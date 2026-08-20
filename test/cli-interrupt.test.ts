// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 63, at the process boundary, against a real signal.
 *
 * `test/interrupt.test.ts` drives the state machine directly and every one of
 * its tests passed while `src/run/interrupt.ts` had ZERO call sites — which
 * meant that in the shipped binary a killed run wrote no `record.json`, printed
 * no pointer, and left only whatever the NDJSON had already caught. A unit test
 * cannot see that. Only a test that spawns the CLI and sends it a signal can.
 *
 * WHAT IS ASSERTED, and why each is the escaped-bytes form rather than a flag:
 *
 *   - `record.json` on disk, read back, and the pointer in the bytes the binary
 *     actually printed;
 *   - the WAIT STATUS, not an exit code we chose. `process.exit(130)` imitates a
 *     signal-terminated status and is not one; `exitCode === null` with
 *     `signalCode === "SIGINT"` is what a parent shell, a CI runner and a
 *     supervisor each read differently, and it is the only assertion that can
 *     tell the two apart.
 *
 * MACHINE DISCIPLINE. Nothing here generates load: one CLI process at a time,
 * one planted agent per run, and every wait is bounded — the poll below has a
 * deadline, the drain's own wait is `CANCEL_DEADLINE_MS`, and the wait for exit
 * races a timeout that kills rather than hanging. The planted agent also exits
 * on its own if it is orphaned, so an abandoned run cannot leave a sleeping
 * process behind for the next test to inherit.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORD_POINTER } from "../src/report/record.ts";
import { CANCEL_DEADLINE_MS } from "../src/run/interrupt.ts";
import { plantLauncher } from "../bar/lib/fake-agent.ts";
import { isolatedPath } from "../bar/lib/fixtures.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ROOT = mkdtempSync(join(homedir(), ".brigadier-interrupt-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/**
 * An ACP agent that answers the handshake and then does not answer the turn.
 *
 * A worker that is genuinely in flight is the only state ruling 63's first
 * interrupt is about, and an agent that finishes instantly can never be in it.
 * It ignores `session/cancel` DELIBERATELY: the notification is unacknowledged
 * on the wire — #6's four-method surface gives nothing to await — and #48
 * measured a real client tolerating a 285-second turn, so an agent that obeyed
 * promptly would test the courtesy instead of the mechanism. The deadline and
 * the kill are the mechanism.
 *
 * `ppid` is polled so that an ABANDONED run — the second interrupt, which by
 * design kills nothing — cannot leave this sleeping on the operator's machine.
 */
const HANGING_AGENT = `
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
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "planted", version: "0.21.13" }, agentCapabilities: {} } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", models: { availableModels: [{ modelId: "fake-1[high]" }] } } });
    } else if (msg.method === "session/prompt") {
      await Bun.write("slow.txt", "in flight\\n");
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

/** The same agent, doing the work and stopping. The control for everything below. */
const PROMPT_AGENT = `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
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
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "planted", version: "0.21.13" }, agentCapabilities: {} } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", models: { availableModels: [{ modelId: "fake-1[high]" }] } } });
    } else if (msg.method === "session/prompt") {
      await Bun.write("slow.txt", "done\\n");
      Bun.spawnSync(["git", "add", "-A"], { cwd: process.cwd() });
      Bun.spawnSync(["git", "-c", "user.name=p", "-c", "user.email=p@e.invalid", "commit", "-q", "-m", "work"], { cwd: process.cwd() });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not implemented" } });
    }
  }
}
`;

/**
 * An agent that speaks nothing at all, so `detect` is still waiting on it.
 *
 * The IDLE case needs a process that is alive and has started no run, and a
 * command that returns in 40 ms cannot be signalled reliably. `detect` holding
 * a handshake open is exactly that state: brigadier is busy, and nothing is in
 * flight for an interrupt to drain.
 */
const SILENT_AGENT = `
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 200);
for await (const chunk of Bun.stdin.stream()) {
  // Read and answer nothing. The handshake timeout is what ends this, and the
  // point of the test is that a signal ends it sooner.
}
`;

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

interface World {
  dir: string;
  repo: string;
  runs: string;
  bin: string;
  plan: string;
}

function makeWorld(name: string, source: string): World {
  const dir = join(ROOT, name);
  const repo = join(dir, "repo");
  const runs = join(dir, "runs");
  const bin = join(dir, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(runs, { recursive: true });
  mkdirSync(bin, { recursive: true });

  git(repo, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "base"]);

  const agent = join(dir, "agent.ts");
  writeFileSync(agent, source);
  plantLauncher(bin, "qwen", [process.execPath, agent]);

  const plan = join(dir, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      version: 1,
      items: [{ id: "slow", kind: "write", paths: ["slow.txt"], prompt: "out=slow.txt" }],
    }),
  );
  return { dir, repo, runs, bin, plan };
}

function start(world: World) {
  return Bun.spawn(
    [process.execPath, CLI, "run", "--plan", world.plan, "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal"],
    {
      env: {
        HOME: ROOT,
        USER: process.env["USER"] ?? "test",
        PATH: isolatedPath(world.bin),
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

/**
 * Wait until a worker is genuinely in flight, or give up.
 *
 * Bounded, and it polls a FILE rather than the run's stdout: the streams are
 * being drained into promises that do not settle until the process closes them,
 * so the NDJSON is the only thing readable while the run is still going. That is
 * ruling 70's flight recorder doing exactly the job it exists for.
 */
async function waitForWorker(runs: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dir = join(runs, "r");
    if (existsSync(dir)) {
      for (const id of readdirSync(dir)) {
        const record = join(dir, id, "record.ndjson");
        if (existsSync(record) && readFileSync(record, "utf8").includes('"process-spawned"')) return id;
      }
    }
    await Bun.sleep(50);
  }
  throw new Error("no worker was ever spawned, so nothing was ever in flight to interrupt");
}

/** Wait for exit, or kill. Cleanup never sits downstream of an unbounded wait. */
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

// ------------------------------------------------------------------------

describe("the FIRST interrupt in flight drains the run (ruling 63)", () => {
  const world = makeWorld("first-sigint", HANGING_AGENT);
  let stdout = "";
  let stderr = "";
  let runId = "";
  let exitCode: number | null = -1;
  let signalCode: string | null = "unset";

  test("setup: a worker is in flight, and one SIGINT arrives", async () => {
    const proc = start(world);
    const out = new Response(proc.stdout as ReadableStream).text();
    const err = new Response(proc.stderr as ReadableStream).text();
    runId = await waitForWorker(world.runs);
    proc.kill("SIGINT");
    await settle(proc, CANCEL_DEADLINE_MS + 90_000);
    stdout = await out;
    stderr = await err;
    exitCode = proc.exitCode;
    signalCode = proc.signalCode;
    expect(runId).not.toBe("");
  }, 180_000);

  test("`session/cancel` went to the live worker, and the deadline was said out loud", () => {
    expect(stderr).toContain("session/cancel");
    expect(stderr).toContain("1 live worker(s)");
    expect(stderr).toContain("no further item will be dispatched");
  });

  test("record.json exists — where before the wiring there was none", () => {
    const path = join(world.runs, "r", runId, "record.json");
    expect(existsSync(path)).toBe(true);
    const record = JSON.parse(readFileSync(path, "utf8")) as { runId: string; items: unknown[] };
    expect(record.runId).toBe(runId);
    expect(record.items.length).toBeGreaterThan(0);
  });

  test("the pointer was PRINTED — ruling 58's travelling half", () => {
    expect(stdout).toContain(`${RECORD_POINTER} ${join(world.runs, "r", runId, "record.json")}`);
  });

  test("ruling 63's promise is four facts and no reassurance", () => {
    expect(stdout).toContain("interrupted by SIGINT — what this run left behind:");
    expect(stdout).toMatch(/\d+ item\(s\) landed/);
    expect(stdout).toMatch(/\d+ did not/);
    // Nothing here says "everything was cleaned up", which is the sentence the
    // ruling exists to forbid.
    expect(stdout).not.toMatch(/all (?:workers|processes) (?:were )?(?:cleaned|terminated) successfully/i);
  });

  test("the exit status is the SIGNAL's, not a number we chose", () => {
    expect(signalCode).toBe("SIGINT");
    expect(exitCode).toBeNull();
    // 130 is what a hand-picked code would have been. It is not a wait status a
    // shell can distinguish from a program that chose to exit 130.
    expect(exitCode).not.toBe(130);
  });
});

describe("NEGATIVE CONTROL: without the drain there is neither record nor pointer", () => {
  const world = makeWorld("uncatchable", HANGING_AGENT);
  let stdout = "";
  let runId = "";
  let signalCode: string | null = "unset";

  test("setup: the same run, killed with a signal no handler can catch", async () => {
    // This is the state the binary was in before `src/run/interrupt.ts` had a
    // call site: the process dies where it stands. Without it, "SIGINT produced
    // a record" would also be true of a run that writes one no matter how it
    // ends, and the wiring would be proving nothing.
    const proc = start(world);
    const out = new Response(proc.stdout as ReadableStream).text();
    runId = await waitForWorker(world.runs);
    proc.kill("SIGKILL");
    await settle(proc, 60_000);
    stdout = await out;
    signalCode = proc.signalCode;
  }, 120_000);

  test("no record.json, no pointer — only the NDJSON survives", () => {
    expect(signalCode).toBe("SIGKILL");
    expect(existsSync(join(world.runs, "r", runId, "record.json"))).toBe(false);
    expect(stdout).not.toContain(RECORD_POINTER);
    // Ruling 70's whole point: the flight recorder is still evidence.
    const ndjson = readFileSync(join(world.runs, "r", runId, "record.ndjson"), "utf8");
    expect(ndjson).toContain('"run-started"');
    expect(ndjson).not.toContain('"run-finished"');
  });
});

describe("the SECOND interrupt abandons and RE-RAISES (ruling 63)", () => {
  const world = makeWorld("second-sigint", HANGING_AGENT);
  let stdout = "";
  let runId = "";
  let exitCode: number | null = -1;
  let signalCode: string | null = "unset";
  let elapsed = 0;

  test("setup: two SIGINTs, the second while the first is still draining", async () => {
    const proc = start(world);
    const out = new Response(proc.stdout as ReadableStream).text();
    runId = await waitForWorker(world.runs);
    proc.kill("SIGINT");
    // Comfortably inside the drain: the handler runs the moment the signal is
    // delivered and then waits `CANCEL_DEADLINE_MS` before it kills anything.
    await Bun.sleep(750);
    const from = Date.now();
    proc.kill("SIGINT");
    await settle(proc, 60_000);
    elapsed = Date.now() - from;
    stdout = await out;
    exitCode = proc.exitCode;
    signalCode = proc.signalCode;
  }, 120_000);

  test("the process is GENUINELY signal-terminated — the wait status, not an exit code", () => {
    expect(signalCode).toBe("SIGINT");
    expect(exitCode).toBeNull();
  });

  test("it abandoned rather than finishing the drain", () => {
    // The distinguishing fact, and the reason this is not the same test as the
    // one above: the first interrupt's drain writes `record.json` and prints the
    // pointer, and this one gets to neither because it left immediately.
    expect(stdout).not.toContain(RECORD_POINTER);
    expect(existsSync(join(world.runs, "r", runId, "record.json"))).toBe(false);
    // "Immediately" measured rather than asserted: it did not sit out the
    // remainder of the cancel deadline.
    expect(elapsed).toBeLessThan(CANCEL_DEADLINE_MS);
  });
});

describe("NEGATIVE CONTROL: a run nobody interrupts is not signal-terminated", () => {
  test("it exits with an ordinary status and prints the pointer", async () => {
    // Without this, every assertion above is also satisfied by a binary that
    // dies on a signal it never received.
    const world = makeWorld("uninterrupted", PROMPT_AGENT);
    const proc = start(world);
    const out = new Response(proc.stdout as ReadableStream).text();
    await settle(proc, 120_000);
    const stdout = await out;
    expect(proc.signalCode).toBeNull();
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain(RECORD_POINTER);
    expect(stdout).not.toContain("interrupted by");
    const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
    expect(existsSync(join(world.runs, "r", runId, "record.json"))).toBe(true);
  }, 180_000);
});

describe("an interrupt BEFORE anything is in flight exits immediately (ruling 63)", () => {
  test("`detect`, mid-handshake, dies with the signal's own status and does not linger", async () => {
    // v1's rule, and the reason it is a rule: there is nothing to clean up, so a
    // handler that delays here is pure downside. The timeout is 30 s and the
    // handshake never completes, so anything under a second is the handler
    // exiting rather than the probe finishing.
    const world = makeWorld("idle", SILENT_AGENT);
    const proc = Bun.spawn([process.execPath, CLI, "detect", "qwen", "--timeout", "30000"], {
      env: {
        HOME: ROOT,
        USER: process.env["USER"] ?? "test",
        PATH: isolatedPath(world.bin),
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new Response(proc.stdout as ReadableStream).text();
    await Bun.sleep(750);
    const from = Date.now();
    proc.kill("SIGINT");
    await settle(proc, 30_000);
    const elapsed = Date.now() - from;
    await out;

    expect(proc.signalCode).toBe("SIGINT");
    expect(proc.exitCode).toBeNull();
    // It did not sit out the handshake timeout, which is what "immediately"
    // means here and what a state machine that treated idle as draining would
    // have done instead.
    expect(elapsed).toBeLessThan(5_000);
  }, 120_000);
});
