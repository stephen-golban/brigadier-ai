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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plantAgent } from "../bar/lib/fake-agent.ts";
import { PROFILES } from "../src/agent/profiles.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
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

/**
 * The flag `src/cli.ts` reads as `Number(value("workers"))`.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-20 by another builder, driving the
 * real module before the guard existed: `--workers abc` produced `workers: NaN`,
 * printed `NaN worker(s) in wave 1 — RAM capped it…`, dispatched ZERO items and
 * exited SUCCESS; `--workers 2.5` printed `2.5 worker(s)` and stepped the batch
 * cursor by 2.5. A run that does nothing and reports success for it is the
 * failure `BAR.md` opens on, and a typo reached it.
 *
 * The PATH here holds ONE planted ACP agent and nothing else. That is the point
 * of the fixture rather than decoration: with no agent at all, admission would
 * refuse for its own reasons and "nothing was created" would be true of a binary
 * carrying no guard whatsoever. With one, the ONLY thing between these commands
 * and a run root full of clones is the refusal under test — and `--dry-run` is
 * deliberately NOT passed for the same reason.
 */
describe("--workers is refused at the boundary, before anything is created", () => {
  const { repo, plan } = world("workers");
  const bin = join(ROOT, "workers", "bin");
  plantAgent(bin, "qwen", { name: "qwen", version: PROFILES.qwen.measuredVersion });
  const env = { PATH: bin };
  // Never created by this file. Its absence afterwards is the evidence.
  const runRoot = join(ROOT, "workers", "runs-never");
  const branches = () =>
    Bun.spawnSync(["git", "branch", "--list", "brigadier/*"], { cwd: repo }).stdout.toString().trim();

  const rejected = [
    ["non-numeric", "abc"],
    ["negative", "-1"],
    ["zero", "0"],
    ["fractional", "2.5"],
    ["blank", ""],
    // `value()` returns the next token whatever it is, so a forgotten value
    // hands the next flag to `Number`. That is a typo too, and it is refused.
    ["flag-shaped", "--review"],
  ] as const;

  for (const [shape, bad] of rejected) {
    test(`--workers with a ${shape} value is a usage error that says what was not done`, () => {
      const before = readdirSync(join(ROOT, "workers"));
      const result = brigadier(["run", "--plan", plan, "--repo", repo, "--run-root", runRoot, "--workers", bad], env);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--workers must be a whole number of at least 1");
      // What the operator typed, quoted back, rather than `NaN`.
      expect(result.stderr).toContain(`it was \`${bad}\``);
      expect(result.stderr).toContain("Nothing was spawned and nothing was cloned");
      // Ruling 65: every byte through the one sink, and the refusal is on stderr.
      // An empty stdout is also the evidence of PLACEMENT — it stopped before the
      // admission block a plan of this size would otherwise have printed.
      expect(result.stdout).toBe("");
      expect(result.stdout).not.toContain("worker(s)");

      // BAR.md item 8: zero processes, zero clones. The message claims it; this
      // checks it. The run root is where `executeRun` puts every clone, and
      // `src/cli.ts` creates it with `mkdirSync(runRoot, { recursive: true })`.
      expect(existsSync(runRoot)).toBe(false);
      // A clone that landed anywhere else in this world would show up here.
      expect(readdirSync(join(ROOT, "workers"))).toEqual(before);
      // And no merge branch, which a run creates in the operator's own repo.
      expect(branches()).toBe("");
    });
  }

  test("NEGATIVE CONTROL: a valid --workers is admitted and reaches the arithmetic", () => {
    // Otherwise a guard that refused everything would pass every assertion
    // above. `--dry-run` here because the value has to travel all the way into
    // ruling 14's arithmetic to be worth checking, and that happens at admission.
    const one = brigadier(
      ["run", "--plan", plan, "--repo", repo, "--run-root", runRoot, "--workers", "1", "--dry-run"],
      env,
    );
    expect(one.code).toBe(0);
    expect(one.stderr).not.toContain("--workers must be");
    expect(one.stdout).toContain("admitted");
    // Not merely accepted — HONOURED, and this number is machine-independent:
    // `admittedWorkers` floors the budgets at 1 and takes the minimum, so a
    // budget of 1 admits exactly one worker on every host, whatever RAM says.
    // The BINDING FILTER is not asserted, because it is not machine-independent:
    // a host under about 13 GiB has a feasibility candidate of 0 or 1 and gets
    // ruling 54's *RAM capped it* sentence for the same count.
    expect(one.stdout).toContain("1 worker(s) in wave 1");
    expect(one.stdout).not.toContain("NaN");
  });

  test("NEGATIVE CONTROL: the emptiness probe can see a run root that IS there", () => {
    // The check above reports "nothing was created" by looking at `runRoot`. A
    // probe pointed at the wrong path reports that too, and forever. This
    // repository has already shipped a check that passed because the thing it
    // checked had not happened, so the probe is made to fail once, on purpose.
    expect(existsSync(runRoot)).toBe(false);
    mkdirSync(join(runRoot, "run-sentinel"), { recursive: true });
    expect(existsSync(runRoot)).toBe(true);
    expect(readdirSync(runRoot)).toEqual(["run-sentinel"]);
    rmSync(runRoot, { recursive: true, force: true });
  });
});
