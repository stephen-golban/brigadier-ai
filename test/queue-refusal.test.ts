// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 59: a refused delegation is COUNTED and REPORTED, run-level.
 *
 * THE DEFECT. Ruling 57's binary refusal already worked — bar item 9's ledger
 * proves it happened against a real vendor's tool shell: `CALL worker=<run>/1
 * argv: run --plan whatever` then `DONE worker=<run>/1 exit=3`. The marker
 * reached the shell and the binary refused, which is ruling 57's one unmeasured
 * assumption measured and holding. And `record.refusedDelegations` was the
 * literal `0`, written unconditionally at the end of every run, so the report
 * line never appeared. A guard that fires and is never observed is
 * indistinguishable from one that never fires.
 *
 * WHAT THIS FILE DRIVES. The planted agent does what a real model did: from
 * inside the worker's environment it invokes the brigadier CLI with `run
 * --plan whatever`. Nothing is simulated about the refusal — it is the same
 * binary, the same `ORCHESTRATING` set, and the same environment marker a real
 * vendor's tool shell inherits. The agent writes the child's exit code to a
 * file so the test can assert on `3` rather than on a report's wording.
 *
 * RUN-LEVEL IS LOAD-BEARING (ruling 58). The report is capped at 2,000 tokens
 * and passing items collapse to a count, so a per-item note on an item that
 * then passed would be the first thing dropped. The assertions below therefore
 * check the line survives on an item that PASSED and integrated.
 *
 * MEASURED against `git 2.50.1` and `bun 1.3.14` on 2026-08-18.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WORKER_MARKER } from "../src/agent/marker.ts";
import { refusedDelegationLine } from "../src/report/index.ts";
import { RUN_ROOT_ENV, readRefusals, recordRefusal, refusalLedgerPath } from "../src/queue/refusal.ts";
import { Sink } from "../src/secrets/sink.ts";

/** Ruling 65: the only writer. `recordRefusal` takes it rather than owning one. */
const sink = new Sink();

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/**
 * A builder that tries to delegate before doing its work.
 *
 * `Bun.spawnSync` with no `env` inherits this process's environment, which is
 * the worker environment brigadier built — including `BRIGADIER_WORKER` and
 * `BRIGADIER_RUN_ROOT`. That inheritance is the mechanism under test: a shell
 * that constructed a clean environment would carry neither, and ruling 57's own
 * "unmeasured, and named rather than absorbed" note is about exactly that.
 */
const AGENT_SOURCE = `
const config = JSON.parse(await Bun.file(Bun.argv[2]).text());
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
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: config.id, version: "1.0.0" }, agentCapabilities: {} } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
    } else if (msg.method === "session/set_mode" || msg.method === "session/set_model") {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "session/prompt") {
      const brief = String(msg.params?.prompt?.[0]?.text ?? "");
      const out = /out=(\\S+)/.exec(brief)?.[1];
      if (config.delegate) {
        const child = Bun.spawnSync([config.bun, config.cli, "run", "--plan", "whatever"], { stdout: "pipe", stderr: "pipe" });
        await Bun.write(config.attempt, "exit=" + child.exitCode + "\\n" + child.stderr.toString());
      }
      if (out !== undefined) {
        await Bun.write(out, "written by " + config.id + "\\n");
        Bun.spawnSync(["git", "add", "-A"], { cwd: process.cwd() });
        Bun.spawnSync(["git", "-c", "user.name=p", "-c", "user.email=p@e.invalid", "commit", "-q", "-m", "work"], { cwd: process.cwd() });
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not implemented" } });
    }
  }
}
`;

/** Ruling 61 refuses a run root inside a temp region, so the scratch tree is under `$HOME`. */
const ROOT = mkdtempSync(join(homedir(), ".brigadier-refusal-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

interface World {
  dir: string;
  repo: string;
  runs: string;
  bin: string;
  attempt: string;
}

function makeWorld(name: string, delegate: boolean): World {
  const dir = join(ROOT, name);
  const repo = join(dir, "repo");
  const runs = join(dir, "runs");
  const bin = join(dir, "bin");
  const attempt = join(dir, "delegation-attempt.txt");
  for (const path of [repo, runs, bin]) mkdirSync(path, { recursive: true });

  git(repo, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "base"]);

  const agent = join(dir, "agent.ts");
  writeFileSync(agent, AGENT_SOURCE);
  const config = join(dir, "qwen.json");
  writeFileSync(config, JSON.stringify({ id: "qwen", delegate, attempt, bun: process.execPath, cli: CLI }));
  const script = join(bin, "qwen");
  writeFileSync(script, `#!/bin/sh\nexec ${process.execPath} ${agent} ${config} "$@"\n`);
  chmodSync(script, 0o755);
  return { dir, repo, runs, bin, attempt };
}

function brigadier(world: World, args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: {
      HOME: ROOT,
      USER: process.env["USER"] ?? "test",
      PATH: `${world.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

interface RecordShape {
  refusedDelegations: number;
  items: Array<{ id: string; status: string }>;
}

function runOf(world: World): { runId: string; record: RecordShape; branch: string } {
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const record = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as RecordShape;
  return { runId, record, branch: `refs/heads/brigadier/${runId}` };
}

function planFile(world: World): string {
  const path = join(world.dir, "plan.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      items: [{ id: "solo", kind: "write", paths: ["solo.txt"], prompt: "out=solo.txt" }],
    }),
  );
  return path;
}

// ------------------------------------------------ the ledger, on its own

describe("ruling 59: the marker is an IDENTITY, and that is what gives a refusal somewhere to land", () => {
  test("a bare `1` marker is still refused and reports that it has NO HOME", () => {
    // Ruling 57 shipped the boolean. A worker spawned by an older brigadier
    // must still be refused — it simply cannot be counted, and saying so is the
    // difference between an under-count and a silent one.
    const recorded = recordRefusal("run", sink, { [WORKER_MARKER]: "1", [RUN_ROOT_ENV]: ROOT });
    expect(recorded.kind).toBe("no-home");
  });

  test("no marker at all is `not-a-worker`: there is nothing to refuse and nothing to record", () => {
    expect(recordRefusal("run", sink, {}).kind).toBe("not-a-worker");
  });

  test("an identity with no run root cannot find the ledger, and says which variable is missing", () => {
    const recorded = recordRefusal("run", sink, { [WORKER_MARKER]: "abc/1" });
    expect(recorded.kind).toBe("no-home");
    expect(recorded.kind === "no-home" ? recorded.why : "").toContain(RUN_ROOT_ENV);
  });

  test("two refusals from two processes append two whole lines", () => {
    const root = join(ROOT, "ledger");
    mkdirSync(join(root, "r", "abc"), { recursive: true });
    const env = { [WORKER_MARKER]: "abc/2", [RUN_ROOT_ENV]: root };
    expect(recordRefusal("run", sink, env, 11, 1).kind).toBe("recorded");
    expect(recordRefusal("plan", sink, env, 12, 2).kind).toBe("recorded");
    const tally = readRefusals(refusalLedgerPath(root, "abc"));
    expect(tally.count).toBe(2);
    expect(tally.items).toEqual([2]);
    expect(tally.damagedLines).toBe(0);
  });

  test("an absent ledger is ZERO refusals and no line at all", () => {
    // The negative control for the line itself: a line printed on every run is
    // wallpaper, and an operator stops reading it exactly when it starts being true.
    expect(readRefusals(join(ROOT, "ledger", "r", "nope", "refusals.ndjson")).count).toBe(0);
    expect(refusedDelegationLine(0)).toBeNull();
  });
});

// ------------------------------ the real binary, refused inside a real worker

describe("a worker that tries to delegate is refused, counted, and reported RUN-LEVEL", () => {
  const world = makeWorld("delegates", true);
  const result = brigadier(world, [
    "run", "--plan", planFile(world), "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal",
  ]);
  const { runId, record, branch } = runOf(world);

  test("the refusal really happened: the CLI exited 3 inside the worker", () => {
    // Bar item 9's `DONE worker=<run>/1 exit=3`, reproduced against the same
    // binary. Asserted on the child's exit code, because that is the fact
    // ruling 57's guard actually produces.
    const attempt = readFileSync(world.attempt, "utf8");
    expect(attempt).toContain("exit=3");
    expect(attempt).toContain("this session IS a brigadier worker");
    expect(attempt).not.toContain("NOT counted");
  });

  test("ruling 59: the run's record counts it", () => {
    expect(record.refusedDelegations).toBe(1);
    const tally = readRefusals(refusalLedgerPath(world.runs, runId));
    expect(tally.count).toBe(1);
    expect(tally.items).toEqual([1]);
  });

  test("and the report carries ONE RUN-LEVEL line, on an item that then PASSED", () => {
    // Run-level is what survives ruling 58's cap: a note on an item that passed
    // would be the first thing collapsed. The item below did pass and did land,
    // and the line is still there.
    expect(result.stdout).toContain("1 worker attempted to delegate and were refused");
    expect(result.stdout).toContain("AGENTS.md");
    expect(record.items[0]?.status).toBe("integrated");
    expect(result.code).toBe(0);
    expect(git(world.repo, ["cat-file", "blob", `${branch}:solo.txt`])).toContain("written by qwen");
  });
});

// -------------------------------------- the control: nobody tried, no line

describe("NEGATIVE CONTROL: a run where nothing delegates prints no line at all", () => {
  const world = makeWorld("well-behaved", false);
  const result = brigadier(world, [
    "run", "--plan", planFile(world), "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal",
  ]);
  const { runId, record } = runOf(world);

  test("zero refusals, no ledger, and the phrase is absent from the report", () => {
    expect(existsSync(world.attempt)).toBe(false);
    expect(record.refusedDelegations).toBe(0);
    expect(existsSync(refusalLedgerPath(world.runs, runId))).toBe(false);
    expect(result.stdout).not.toContain("attempted to delegate");
    expect(result.code).toBe(0);
  });
});
