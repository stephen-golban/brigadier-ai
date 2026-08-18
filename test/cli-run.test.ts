// SPDX-License-Identifier: Apache-2.0
/**
 * The `run` and `plan` verbs at the process boundary.
 *
 * Everything here is asserted on the exit code and the bytes, because that is
 * the whole of what a host model or a shell can see. The refusals in
 * particular: ruling 57's is checked BEFORE command dispatch, so it has to be
 * observable on a command the binary would otherwise have handled and on one it
 * would not.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const ROOT = mkdtempSync(join(homedir(), ".brigadier-cli-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function brigadier(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: {
      HOME: ROOT,
      USER: process.env["USER"] ?? "test",
      PATH: process.env["PATH"] ?? "",
      NO_COLOR: "1",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function world(name: string): { repo: string; runs: string; plan: string } {
  const dir = join(ROOT, name);
  const repo = join(dir, "repo");
  const runs = join(dir, "runs");
  mkdirSync(repo, { recursive: true });
  mkdirSync(runs, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "-b", "main", "."], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
  Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "base"],
    { cwd: repo },
  );
  const plan = join(dir, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      version: 1,
      items: [
        { id: "a", kind: "write", paths: ["a.txt"], prompt: "out=a.txt", difficulty: "hard" },
        { id: "b", kind: "write", paths: ["b.txt"], prompt: "out=b.txt" },
      ],
    }),
  );
  return { repo, runs, plan };
}

describe("`run` needs a plan, and says so", () => {
  test("no --plan is a usage error, not a crash", () => {
    const result = brigadier(["run"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--plan <path>");
  });

  test("NEGATIVE CONTROL: with a plan it does not print usage", () => {
    const { repo, runs, plan } = world("usage");
    const result = brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runs, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("--plan <path>");
  });

  test("`run` is discoverable — `--help` names it", () => {
    expect(brigadier(["--help"]).stdout).toContain("brigadier run --plan");
  });
});

describe("--dry-run and --estimate stop before anything is created", () => {
  const { repo, runs, plan } = world("dry");

  test("--dry-run admits the plan, names the ladder, and creates nothing", () => {
    const before = readdirSync(runs);
    const result = brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runs, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("admitted");
    expect(result.stdout).toContain("ladder");
    expect(result.stdout).toContain("worker(s) in wave 1");
    // Ruling 67, per item, at admission.
    expect(result.stdout).toContain("difficulty: hard (clamped to medium)");
    expect(readdirSync(runs)).toEqual(before);
  });

  test("`plan` is the same thing under its own verb", () => {
    const result = brigadier(["plan", "--plan", plan, "--repo", repo, "--run-root", runs]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("admitted");
    expect(result.stdout).toContain("nothing was started");
  });

  test("--estimate prints a RANGE with its provenance (ruling 66)", () => {
    const result = brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runs, "--estimate"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/\d[\d.,]*\s*–\s*\d[\d.,]*/);
    expect(result.stdout).toContain("provenance");
    expect(result.stdout).toContain("#44");
  });

  test("NEGATIVE CONTROL: the estimate is not a single number", () => {
    const result = brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runs, "--estimate"]);
    const range = /(\d[\d.,]*)\s*–\s*(\d[\d.,]*)/.exec(result.stdout);
    expect(range).not.toBeNull();
    expect(range?.[1]).not.toBe(range?.[2]);
  });

  test("ruling 70: no line claims a saving", () => {
    const result = brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runs, "--estimate"]);
    const claim = /\b(saved|savings|reduced (?:cost|spend|tokens) by)\b/i;
    const disclaimer = /\b(no claim|makes no claim|not a claim|claims nothing|cannot be read as|is not a saving)\b/i;
    const offenders = result.stdout.split("\n").filter((line) => claim.test(line) && !disclaimer.test(line));
    expect(offenders).toEqual([]);
    // And the lever IS reported, so the check above is not passing on silence.
    expect(result.stdout).toContain("16.5×");
  });
});

describe("ruling 61: a temp-rooted run root is refused before anything is created", () => {
  test("the refusal names the remedy", () => {
    const { repo, plan } = world("temp");
    // `TMPDIR` is passed through so the child agrees with this process about
    // where the temp region IS. Ruling 15's realpath rule is why that matters:
    // on macOS `/var` is a symlink to `/private/var`, and a child that resolved
    // a different root would be judging a different tree.
    const result = brigadier(
      ["run", "--plan", plan, "--repo", repo, "--run-root", join(tmpdir(), "brigadier-nope"), "--dry-run"],
      { TMPDIR: process.env["TMPDIR"] ?? tmpdir() },
    );
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("temp region");
    expect(result.stderr).toContain("--run-root");
  });

  test("NEGATIVE CONTROL: a run root outside every temp region is accepted", () => {
    const { repo, runs, plan } = world("nontemp");
    expect(brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runs, "--dry-run"]).code).toBe(0);
  });
});

describe("ruling 57: an orchestrating command refuses inside a worker", () => {
  const { repo, runs, plan } = world("marker");
  const marked = { BRIGADIER_WORKER: "some-run/3" };

  test("`run` refuses, and tells the reader what to do instead", () => {
    const result = brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runs], marked);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("this session IS a brigadier worker");
    expect(result.stderr).toContain("Do the work directly");
  });

  test("the marker is read BEFORE command dispatch", () => {
    // `plan` would otherwise have been handled; the refusal has to fire without
    // the command ever being looked at, because v1's nudge hook read the marker
    // before reading stdin and that detail is the guard.
    const result = brigadier(["plan", "--plan", plan], marked);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("this session IS a brigadier worker");
  });

  test("NEGATIVE CONTROL: the same commands without the marker are not refused", () => {
    const result = brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runs, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("brigadier worker");
  });

  test("NEGATIVE CONTROL: a read-only command is still allowed inside a worker", () => {
    // Refusing introspection would make the refusal look arbitrary to a model
    // trying to understand its situation, and it cannot cause finding 114.
    expect(brigadier(["licenses"], marked).code).toBe(0);
  });
});

describe("ruling 37: a verify command committed in the repository is never read", () => {
  test("a brigadier.json in the repository does not become the gate", () => {
    const { repo, runs, plan } = world("hostile");
    const canary = join(ROOT, "hostile-ran.txt");
    const script = join(repo, "verify.sh");
    writeFileSync(script, `#!/bin/sh\necho ran > ${canary}\n`);
    Bun.spawnSync(["chmod", "+x", script]);
    writeFileSync(join(repo, "brigadier.json"), JSON.stringify({ verify: "./verify.sh" }));
    const result = brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runs, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("never read and never run");
    expect(readdirSync(ROOT)).not.toContain("hostile-ran.txt");
  });

  test("NEGATIVE CONTROL: the operator's own --verify IS resolved, before a worker exists", () => {
    // Otherwise "the committed one did not run" would also be true of a binary
    // that runs no verify command at all.
    const { repo, runs, plan } = world("operator-verify");
    const result = brigadier([
      "run", "--plan", plan, "--repo", repo, "--run-root", runs, "--verify", "definitely-not-real-9f3a",
    ]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("definitely-not-real-9f3a");
    expect(result.stderr).toContain("is on PATH");
  });
});
