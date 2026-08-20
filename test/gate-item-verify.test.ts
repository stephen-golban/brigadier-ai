// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 52's PER-ITEM verify command, driven as a process against planted ACP
 * agents.
 *
 * THE DEFECT THIS FILE EXISTS FOR. `PlannedItem.verify` was resolved on `PATH`
 * at plan validation — before a single worker existed, exactly as ruling 52
 * asks — and then never executed. Only the wave-level `--verify` ran, against
 * the merged result. So an item could declare `verify: <its own tests>`, have
 * the executable proved to exist, and integrate without the command ever being
 * run. v1's version of this produced *approved, `tests_pass` skipped,
 * `(approved by codex)`* after a full build was burned; this version never even
 * had a slot to skip.
 *
 * AND THE SECOND HALF, which is the same defect one level up: a blocking check
 * did not keep an item OUT OF THE TREE. Only the review check did. So the
 * assertions below are on `git cat-file blob` — the bytes in the object store —
 * with a SIBLING ITEM THAT DOES LAND in the same run, because "nothing is on
 * the branch" is also satisfied by a run that published nothing at all and that
 * is not what is being claimed.
 *
 * MEASURED against `git 2.50.1` and `bun 1.3.14` on 2026-08-18.
 *
 * The negative controls, each of which fails on a plausible wrong build:
 *
 *   misspelled command   refused at ADMISSION, with ZERO processes spawned and
 *                        no run root created — asserted on the filesystem and
 *                        on a file the agent writes the instant it starts
 *   failing command      the item is `fail`, blocks, and its bytes are ABSENT
 *                        while its sibling's bytes are PRESENT
 *   passing command      the same plan with the exit code flipped integrates —
 *                        without this, "nothing merged" would pass on a binary
 *                        that merges nothing
 *   no command           `unconfigured`, does NOT block, and still prints
 *   merged-result gate   still runs, in its own section, on the integration
 *                        commit — the per-item run must not have replaced it
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plantLauncher } from "../bar/lib/fake-agent.ts";
import { isolatedPath } from "../bar/lib/fixtures.ts";
import { writeScript } from "../bar/lib/fs.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/**
 * A builder that writes one file, commits it, and leaves a footprint the
 * instant it starts.
 *
 * The footprint is what makes "zero processes spawned" an assertion rather than
 * a hope: a refusal that happened after the agent was launched looks identical
 * in the report to one that happened before it.
 */
const AGENT_SOURCE = `
const config = JSON.parse(await Bun.file(Bun.argv[2]).text());
await Bun.write(config.spawnedAt, "spawned\\n");
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
      const one = (re) => re.exec(brief)?.[1];
      const out = one(/out=(\\S+)/);
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
const ROOT = mkdtempSync(join(homedir(), ".brigadier-itemverify-test-"));
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
  spawnedAt: string;
  /** Every verify script appends one line here, so "did it run" is a fact on disk. */
  ran: string;
}

function makeWorld(name: string, vendors: readonly string[]): World {
  const dir = join(ROOT, name);
  const repo = join(dir, "repo");
  const runs = join(dir, "runs");
  const bin = join(dir, "bin");
  const spawnedAt = join(dir, "agent-spawned.txt");
  const ran = join(dir, "verify-ran.txt");
  for (const path of [repo, runs, bin]) mkdirSync(path, { recursive: true });

  git(repo, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "base"]);

  const agent = join(dir, "agent.ts");
  writeFileSync(agent, AGENT_SOURCE);
  for (const id of vendors) {
    const config = join(dir, `${id}.json`);
    writeFileSync(config, JSON.stringify({ id, spawnedAt }));
    plantLauncher(bin, id, [process.execPath, agent, config]);
  }

  // Two checkers that differ only in their exit code. The name is on PATH, so
  // `resolveVerify` finds it the way it finds an operator's real command.
  for (const [command, code] of [["verify-ok", 0], ["verify-bad", 1]] as const) {
    // `writeScript`, not a bare shebang: this checker stands on `PATH` as the
    // operator's own verify command, and on Windows an extension-less file with
    // a `#!` line is not executable however its mode bits are set. `cd` is what
    // `$(pwd)` is for — the assertion is that the checker ran in the CLONE.
    writeScript(
      join(bin, command),
      `#!/bin/sh\necho "${command} in $(pwd)" >> ${ran}\nexit ${code}\n`,
      `@echo off\r\necho ${command} in %CD%>> ${ran}\r\nexit /b ${code}\r\n`,
    );
  }
  return { dir, repo, runs, bin, spawnedAt, ran };
}

function brigadier(world: World, args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: {
      HOME: ROOT,
      USER: process.env["USER"] ?? "test",
      PATH: isolatedPath(world.bin),
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

interface RecordShape {
  items: Array<{
    id: string;
    status: string;
    checks: Array<{ name: string; outcome: string; blocking: boolean; qualifier?: string; detail?: string }>;
  }>;
}

/**
 * The run's record, or a failure that says what the binary actually did.
 *
 * The CLI's own output is in the message on purpose: a bare `ENOENT ... /r` says
 * only that no run directory exists, which is the symptom of every refusal
 * there is. The exit code and stderr say which one, and a test that cannot tell
 * a refused plan from a crashed one costs a whole debugging session.
 */
function runOf(world: World, result: { code: number | null; stdout: string; stderr: string }): {
  runId: string;
  record: RecordShape;
  branch: string;
} {
  if (!existsSync(join(world.runs, "r"))) {
    throw new Error(
      `no run directory under ${world.runs}: brigadier exited ${String(result.code)} without starting a run.\n` +
        `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
  }
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const record = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as RecordShape;
  return { runId, record, branch: `refs/heads/brigadier/${runId}` };
}

/** The one thing a printer cannot produce: the bytes, out of the object store. */
function blob(world: World, branch: string, path: string): string {
  const proc = Bun.spawnSync(["git", "cat-file", "blob", `${branch}:${path}`], {
    cwd: world.repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
}

function planFile(world: World, name: string, items: ReadonlyArray<Record<string, unknown>>): string {
  const path = join(world.dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, items }));
  return path;
}

function checkOf(record: RecordShape, id: string, name: string) {
  return record.items.find((item) => item.id === id)?.checks.find((check) => check.name === name);
}

// ------------------- admission: a misspelled command, and nothing is spent

describe("ruling 52: a verify command that is not on PATH is refused at ADMISSION", () => {
  const world = makeWorld("admission", ["qwen"]);
  const path = planFile(world, "typo", [
    { id: "a", kind: "write", paths: ["a.txt"], prompt: "out=a.txt", verify: "bun-tsetraltsen-typo" },
  ]);
  const result = brigadier(world, ["run", "--plan", path, "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal"]);

  test("it refuses, and names the TOKEN that failed rather than the whole command", () => {
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("bun-tsetraltsen-typo");
    expect(result.stderr).toContain("PATH");
    expect(result.stderr).toContain("ruling 52");
  });

  test("ZERO PROCESSES were spawned, and no run root was created", () => {
    // Asserted on the filesystem rather than on the word "refused". Ruling 52's
    // whole reason for resolving this at plan validation is that a clone spent
    // discovering a missing checker is a clone spent learning what a lookup
    // already knew — so the evidence has to be that nothing was spent.
    expect(existsSync(world.spawnedAt)).toBe(false);
    expect(existsSync(world.ran)).toBe(false);
    expect(readdirSync(world.runs)).toEqual([]);
    expect(git(world.repo, ["branch", "--list", "brigadier/*"])).toBe("");
  });
});

// ---------------- a failing per-item verify blocks, while its sibling lands

describe("ruling 52: a per-item verify that FAILS keeps that item's bytes off the branch", () => {
  const world = makeWorld("fails", ["qwen"]);
  const path = planFile(world, "mixed", [
    { id: "good", kind: "write", paths: ["good.txt"], prompt: "out=good.txt", verify: "verify-ok" },
    { id: "bad", kind: "write", paths: ["bad.txt"], prompt: "out=bad.txt", verify: "verify-bad" },
  ]);
  const result = brigadier(world, ["run", "--plan", path, "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal"]);
  const { record, branch } = runOf(world, result);

  test("the command ACTUALLY RAN, once per item, inside that item's clone", () => {
    // Without this the two assertions below would also pass on a build that
    // still never executes anything and simply blocks everything.
    const lines = readFileSync(world.ran, "utf8").trim().split("\n");
    expect(lines.filter((line) => line.startsWith("verify-ok")).length).toBe(1);
    expect(lines.filter((line) => line.startsWith("verify-bad")).length).toBe(1);
    // The cwd is the item's clone, under brigadier's run root — not the
    // operator's repository, which ruling 51 refuses to touch.
    expect(lines.every((line) => line.includes(world.runs))).toBe(true);
    expect(lines.some((line) => line.includes(world.repo))).toBe(false);
  });

  test("`fail`, blocking, and the failing item is not `integrated`", () => {
    const check = checkOf(record, "bad", "verify");
    expect(check?.outcome).toBe("fail");
    expect(check?.blocking).toBe(true);
    // `fail` and not `error`: the remedy is the WORKER's. Ruling 52 keeps them
    // apart because `error` would say the checker broke and send nobody anywhere.
    expect(check?.outcome).not.toBe("error");
    expect(record.items.find((item) => item.id === "bad")?.status).not.toBe("integrated");
    expect(result.code).toBe(1);
  });

  test("the BYTES are absent for the failing item and PRESENT for its sibling", () => {
    // The sibling is the control that makes this mean something: "nothing is on
    // the branch" is also true of a run that published nothing, and that is a
    // different failure wearing the same assertion.
    expect(blob(world, branch, "good.txt")).toContain("written by qwen");
    expect(blob(world, branch, "bad.txt")).toBe("");
    expect(git(world.repo, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`])).not.toBe("");
    expect(git(world.repo, ["fsck", "--no-progress", "--connectivity-only", "--strict"])).toBe("");
  });

  test("the failing item's path is not in the branch's TREE, and its clone is kept", () => {
    // `git ls-tree` reads the object store; a status word in a report reads a
    // string somebody composed. Ruling 52 is about the second standing in for
    // the first.
    const tree = git(world.repo, ["ls-tree", "--name-only", "-r", branch]);
    expect(tree.split("\n")).toContain("good.txt");
    expect(tree.split("\n")).not.toContain("bad.txt");
    // Ruling 63: the work is not deleted either. The clone may hold the only
    // copy of it, and the record says where.
    const kept = record.items.find((item) => item.id === "bad");
    expect(kept?.status).toBe("retained");
    expect(result.stdout).toContain("retained clone item 2");
  });
});

// ------------- the same plan with the exit code flipped, so "blocks" means something

describe("NEGATIVE CONTROL: a per-item verify that PASSES integrates the identical item", () => {
  const world = makeWorld("passes", ["qwen"]);
  const path = planFile(world, "both-ok", [
    { id: "good", kind: "write", paths: ["good.txt"], prompt: "out=good.txt", verify: "verify-ok" },
    { id: "bad", kind: "write", paths: ["bad.txt"], prompt: "out=bad.txt", verify: "verify-ok" },
  ]);
  const result = brigadier(world, ["run", "--plan", path, "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal"]);
  const { record, branch } = runOf(world, result);

  test("both land, both are `pass`, and the run exits 0", () => {
    expect(result.code).toBe(0);
    expect(checkOf(record, "bad", "verify")?.outcome).toBe("pass");
    expect(checkOf(record, "bad", "verify")?.blocking).toBe(false);
    expect(blob(world, branch, "good.txt")).toContain("written by qwen");
    expect(blob(world, branch, "bad.txt")).toContain("written by qwen");
  });
});

// ------------------------------- no command at all, which does NOT block

describe("ruling 52: an item with no verify command is `unconfigured`, prints, and does not block", () => {
  const world = makeWorld("unconfigured", ["qwen"]);
  const path = planFile(world, "bare", [
    { id: "solo", kind: "write", paths: ["solo.txt"], prompt: "out=solo.txt" },
  ]);
  const result = brigadier(world, ["run", "--plan", path, "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal"]);
  const { record, branch } = runOf(world, result);

  test("a first-time user with no verify command still gets a product that runs", () => {
    expect(result.code).toBe(0);
    expect(blob(world, branch, "solo.txt")).toContain("written by qwen");
    expect(existsSync(world.ran)).toBe(false);
  });

  test("and it is PRINTED in the same slot at the same size, never omitted", () => {
    const check = checkOf(record, "solo", "verify");
    expect(check?.outcome).toBe("unconfigured");
    expect(check?.blocking).toBe(false);
    // Ruling 52: the difference between an unmet requirement and an absent one
    // is real; the difference in how loudly they print is not.
    expect(result.stdout).toContain("verify: unconfigured");
  });
});

// ------------- the merged-result gate is a SEPARATE run, in a SEPARATE section

describe("ruling 52: the verify command runs once MORE on the integration commit, reported separately", () => {
  const world = makeWorld("merged", ["qwen"]);
  const path = planFile(world, "two", [
    { id: "one", kind: "write", paths: ["one.txt"], prompt: "out=one.txt", verify: "verify-ok" },
    { id: "two", kind: "write", paths: ["two.txt"], prompt: "out=two.txt", verify: "verify-ok" },
  ]);
  const result = brigadier(world, [
    "run", "--plan", path, "--repo", world.repo, "--run-root", world.runs,
    "--verify", "verify-ok", "--audience", "terminal",
  ]);
  const { record, branch } = runOf(world, result);

  test("THREE runs of the command: one per item, and one on the merge", () => {
    // Two clean items whose merge breaks the build is the classic integration
    // failure. The per-item gate cannot see it and this is the assertion that
    // the per-item work did not quietly replace the merged one.
    const lines = readFileSync(world.ran, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    // The merged-result run happens in its own dedicated clone under `gate/`,
    // which is what makes it a different directory from either item's.
    expect(lines.filter((line) => line.includes("/gate/")).length).toBe(1);
  });

  test("it is reported in its OWN section, never folded into the item list", () => {
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("the merged result:");
    expect(result.stdout).toContain("verify (merged result): pass");
    // And the per-item checks are still there, distinctly.
    expect(checkOf(record, "one", "verify")?.outcome).toBe("pass");
    expect(checkOf(record, "two", "verify")?.outcome).toBe("pass");
    expect(blob(world, branch, "one.txt")).toContain("written by qwen");
    expect(blob(world, branch, "two.txt")).toContain("written by qwen");
  });
});
