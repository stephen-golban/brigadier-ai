#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * A fixture that does the work honestly — the instrument's positive control.
 *
 * An instrument needs two controls, and the first draft of this harness had
 * neither. A do-nothing binary scoring 0 of 13 proves nothing on its own: three
 * of those items were unsatisfiable by construction — a literal
 * `checks.expect(..., false, ...)`, a judgement called with empty observations —
 * and nobody could tell the difference between "the product is not built" and
 * "the check cannot be passed".
 *
 * So this file exists to be scored high. It really clones with `git`, really
 * spawns worker processes, really enforces a lane on every request, really
 * merges with `git merge-tree --write-tree` and `commit-tree`, really writes a
 * run record, and really re-raises a second interrupt. Where it takes a
 * shortcut the shortcut is in the AGENT (a scripted fixture rather than a
 * language model), never in the orchestration the bar measures.
 *
 * It is NOT a design proposal for the product and nothing in `src/` should
 * import an idea from it. It is the thing the ruler is checked against before
 * the ruler is trusted to measure anything.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordItem, RunRecord } from "../lib/contract.ts";
import type { Directive, Plan, PlanItem } from "../lib/plan.ts";

const VENDOR_SCRIPT = fileURLToPath(new URL("./vendor.ts", import.meta.url));
const KNOWN_VENDORS = ["claude", "codex", "copilot", "qwen", "opencode", "gemini"];
const RUN_MARKER = "--brigadier-run";
const WORKER_MARKER = "BRIGADIER_WORKER";

const argv = Bun.argv.slice(2);

/**
 * Ruling 63's third clause, and the only part of it that is about this process
 * rather than about the disk.
 *
 * The first interrupt DRAINS — in-flight children are stopped and the run is
 * written up, so a retained clone is reported rather than orphaned. The second
 * RE-RAISES: the handler removes itself and sends the signal again, so the
 * process is genuinely signal-terminated and `wait()` says so. Exiting with an
 * invented code here would tell every supervisor above us that the run ended
 * normally.
 */
const children = new Set<{ kill(signal?: string | number): void }>();
let draining = false;

function onInterrupt(): void {
  if (!draining) {
    draining = true;
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    // The drain window has to be a real window. If the process simply finished
    // its loop and exited 0, a second interrupt would have nothing to arrive at
    // and "re-raises rather than inventing an exit code" would be unobservable —
    // which is exactly how the first version of this fixture failed item 7.
    // Long enough that "survived the first signal" is observable. A binary with
    // no handler at all dies immediately, which must NOT read as a correct
    // drain — that ambiguity let a forger satisfy ruling 63 by doing nothing.
    setTimeout(() => process.exit(130), 6_000);
    return;
  }
  process.removeListener("SIGINT", onInterrupt);
  process.kill(process.pid, "SIGINT");
}
process.on("SIGINT", onInterrupt);

/** Once interrupted, this process stays alive for the drain rather than racing it. */
function drainForever(): Promise<never> {
  return new Promise<never>(() => {});
}

const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

// ------------------------------------------------------------------ helpers

interface Ran {
  ok: boolean;
  out: string;
  err: string;
  code: number | null;
}

function run(argvIn: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Ran {
  const proc = Bun.spawnSync(argvIn, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    out: new TextDecoder().decode(proc.stdout).trim(),
    err: new TextDecoder().decode(proc.stderr).trim(),
    code: proc.exitCode,
  };
}

const GIT_IDENTITY = ["-c", "user.name=brigadier", "-c", "user.email=brigadier@example.invalid"];

/** Ruling 56: no hook, no fsmonitor, and never with the clone as the working directory. */
function safeGit(clone: string, emptyHooks: string, args: string[], cwd: string): Ran {
  return run(
    [
      "git",
      `--git-dir=${join(clone, ".git")}`,
      `--work-tree=${clone}`,
      "-c",
      `core.hooksPath=${emptyHooks}`,
      "-c",
      "core.fsmonitor=false",
      ...GIT_IDENTITY,
      ...args,
    ],
    { cwd },
  );
}

function which(command: string): string | undefined {
  return Bun.which(command) ?? undefined;
}

function usableVendors(): string[] {
  return KNOWN_VENDORS.filter((id) => which(id) !== undefined);
}

// -------------------------------------------------------------- the sweep

/**
 * Ruling 38: the sweep is THE containment mechanism, not crash recovery.
 *
 * It matches on the command line, never on a process name, and it matches the
 * RUN ROOT as well as the marker — a descendant that called `setsid()` no longer
 * shares a process group and never carried brigadier's argv, but a process
 * working inside a run directory still names it.
 */
function sweepProcesses(needles: string[]): string[] {
  if (needles.length === 0) return [];
  const listing =
    process.platform === "win32"
      ? run(["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"])
      : run(["ps", "-A", "-o", "pid=,args="]);
  if (!listing.ok) return [];

  const killed: string[] = [];
  for (const line of listing.out.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === process.pid || !needles.some((n) => command.includes(n))) continue;
    if (/\bps\b|Get-CimInstance/.test(command)) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed.push(`${pid} ${command.slice(0, 120)}`);
    } catch {
      // Already gone, or not ours to kill. Both are fine.
    }
  }
  return killed;
}

function directorySize(path: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry);
      try {
        const stat = statSync(child);
        if (stat.isDirectory()) walk(child);
        else total += stat.size;
      } catch {
        // Vanished mid-walk.
      }
    }
  };
  walk(path);
  return total;
}

function hasCommittedWork(clone: string): boolean {
  if (!existsSync(join(clone, ".git"))) return false;
  const head = run(["git", `--git-dir=${join(clone, ".git")}`, "rev-parse", "HEAD"], { cwd: dirname(clone) });
  const base = run(["git", `--git-dir=${join(clone, ".git")}`, "rev-parse", "bar-base"], { cwd: dirname(clone) });
  return head.ok && base.ok && head.out !== base.out;
}

/**
 * Ruling 63 splits the sweep along a seam, and the two halves point opposite
 * ways: processes ALWAYS, directories only for complete runs. A leaked process
 * can still act; a retained directory is inert and holds someone's only copy.
 */
function sweepDirectories(runsRoot: string): { removed: string[]; retained: string[] } {
  const removed: string[] = [];
  const retained: string[] = [];
  if (!existsSync(runsRoot)) return { removed, retained };

  for (const entry of readdirSync(runsRoot)) {
    const runDir = join(runsRoot, entry);
    if (!statSync(runDir).isDirectory()) continue;
    if (existsSync(join(runDir, "complete"))) {
      rmSync(runDir, { recursive: true, force: true });
      removed.push(runDir);
      continue;
    }
    // Ruling 63 draws the line at COMMITTED WORK, not at the run: a clone that
    // holds someone's only copy is kept, and one that holds nothing is swept
    // even when its sibling is kept. Retaining a whole run directory because one
    // clone in it mattered would be leaving inert litter behind and calling it
    // caution.
    const clonesDir = join(runDir, "clones");
    let kept = false;
    for (const child of existsSync(clonesDir) ? readdirSync(clonesDir) : []) {
      const clone = join(clonesDir, child);
      if (!statSync(clone).isDirectory()) continue;
      if (hasCommittedWork(clone)) {
        retained.push(`${clone} (${directorySize(clone)} bytes)`);
        kept = true;
      } else if (existsSync(join(clone, ".git"))) {
        rmSync(clone, { recursive: true, force: true });
        removed.push(clone);
      }
    }
    if (!kept) {
      rmSync(runDir, { recursive: true, force: true });
      removed.push(runDir);
    }
  }
  return { removed, retained };
}

// ------------------------------------------------------------------- lane

interface LaneRequest {
  kind?: string;
  title?: string | null;
  locations?: Array<{ path?: string }>;
}

/**
 * The lane, decided in the client on every request.
 *
 * An empty `locations` is DENIED rather than vacuously allowed. Codex's measured
 * `edit` payload carries `title: null` and `locations: []`, so a guard written
 * as `locations.every(inLane)` returns true for it and can never fail — which is
 * exactly the shape ruling 43 exists to forbid.
 */
function laneAllows(request: LaneRequest, clone: string, readOnly: boolean): boolean {
  if (readOnly) return false;
  const locations = request.locations ?? [];
  if (locations.length === 0) return false;
  const root = resolve(clone);
  return locations.every((location) => {
    const path = location.path;
    if (path === undefined || !isAbsolute(path)) return false;
    const target = resolve(path);
    if (target !== root && !target.startsWith(`${root}/`)) return false;
    // Ruling 43's `.git/**` exclusion, applied where it can be.
    return !relative(root, target).split("/").includes(".git");
  });
}

// ---------------------------------------------------------------- workers

interface WorkerOutcome {
  code: number | null;
  lines: string[];
  denied: number;
  killedAt?: string;
}

async function driveWorker(options: {
  /** The vendor's own executable. It knows where its configuration lives. */
  vendor: string;
  brief: unknown;
  briefPath: string;
  clone: string;
  runId: string;
  readOnly: boolean;
  answerFile: string;
  env: Record<string, string>;
  onCommitNow?: () => void;
}): Promise<WorkerOutcome> {
  writeFileSync(options.briefPath, JSON.stringify(options.brief, null, 2));
  writeFileSync(options.answerFile, "");

  // Ruling 38: the run marker goes in the COMMAND LINE of every process
  // brigadier causes to exist, never in a name pattern — a sweep scanning `ps`
  // cannot see an environment variable.
  const proc = Bun.spawn(
    [options.vendor, options.briefPath, RUN_MARKER, options.runId],
    {
      cwd: options.clone,
      env: { ...options.env, BAR_ANSWER_FILE: options.answerFile, [WORKER_MARKER]: `${options.runId}/x` },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  children.add(proc);
  // Checked on 2026-08-18 against the deadlock fixed in `bar/fakes/vendor.ts`:
  // this loop reads the worker's STDOUT and answers on a different channel
  // entirely — `BAR_ANSWER_FILE`, a file the worker polls — and every branch
  // below is synchronous. The reader therefore never waits on anything that
  // could only arrive through the stream it has stopped reading. Answering on
  // the worker's stdin instead would reintroduce exactly that shape.
  const lines: string[] = [];
  let denied = 0;
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += new TextDecoder().decode(chunk as Uint8Array);
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.length === 0) continue;
      lines.push(line);
      if (line.startsWith("REQUEST ")) {
        let request: LaneRequest = {};
        try {
          request = JSON.parse(line.slice(8)) as LaneRequest;
        } catch {
          request = {};
        }
        const allow = laneAllows(request, options.clone, options.readOnly);
        if (!allow) denied += 1;
        writeFileSync(options.answerFile, allow ? "ALLOW" : "DENY");
      } else if (line === "COMMIT-NOW") {
        options.onCommitNow?.();
      }
    }
  }
  await proc.exited;
  children.delete(proc);
  return { code: proc.exitCode, lines, denied };
}

// ------------------------------------------------------------------- run

interface Admission {
  refused: string[];
  ladderNote: string;
  bindingFilter: string;
  workers: number;
}

function admit(plan: Plan, vendors: string[], maxWorkers: number | undefined): Admission {
  const refused: string[] = [];

  // Ruling 13: two items claiming one path is a plan that cannot be isolated.
  const owners = new Map<string, string>();
  for (const item of plan.items) {
    for (const path of item.paths ?? []) {
      const existing = owners.get(path);
      if (existing !== undefined) {
        refused.push(`items ${existing} and ${item.id} both claim ${path} — a path has one owner or the fan-out cannot isolate`);
      } else owners.set(path, item.id);
    }
  }

  // Rulings 11 and 53. A remedy, never arithmetic: which term failed, on which
  // agent, and whether the agent CANNOT or nobody has MEASURED it — those need
  // different fixes, and v1 said `ROUTING_FAILED — 11 model(s) were eliminated`.
  for (const item of plan.items) {
    for (const requirement of item.requires ?? []) {
      if (which(requirement) === undefined) {
        const agent = vendors[0] ?? "no agent";
        refused.push(
          `item ${item.id} requires \`${requirement}\`: not resolvable on PATH in the environment the worker would run in. ` +
            `On ${agent} this term is UNMEASURED — nobody has measured it, which is not permission. ` +
            `Remedy: measure ${requirement} on ${agent}, or drop the requirement from the plan.`,
        );
      }
    }
    // Ruling 52: resolve the checker's executable on PATH, in the environment it
    // will actually run in. v1's injected ENOENT produced `approved, tests_pass
    // skipped` after a full build was burned.
    if (item.verify !== undefined) {
      const executable = item.verify.trim().split(/\s+/)[0] ?? "";
      if (executable.length > 0 && !executable.startsWith("./") && which(executable) === undefined) {
        refused.push(
          `item ${item.id} verify command \`${item.verify}\`: \`${executable}\` does not resolve on PATH. ` +
            `Caught at admission, before anything spawned. Remedy: fix the spelling or install ${executable}.`,
        );
      }
    }
  }

  // Ruling 14: three filters, lowest wins, and the report says WHICH bound.
  const byPlan = plan.items.length;
  const byDesirability = maxWorkers ?? Number.POSITIVE_INFINITY;
  const byRam = 64;
  const workers = Math.min(byPlan, byDesirability, byRam);
  const bindingFilter =
    workers === byPlan && byPlan <= byDesirability && byPlan <= byRam
      ? `the plan had ${byPlan} item(s), which was the binding filter`
      : workers === byDesirability
        ? `desirability capped it at ${byDesirability}, which was the binding filter`
        : `available RAM capped it at ${byRam}, which was the binding filter`;

  // Ruling 55: a short ladder is stated at plan ADMISSION, before anything is
  // spent — finding 87 discovered it after an attempt was already gone.
  const ladderNote =
    vendors.length >= 2
      ? "ladder: 2 rungs (a second vendor is available for rung two)"
      : "ladder: 1 rung — no second rung, because only one vendor is drivable on this machine";

  return { refused, ladderNote, bindingFilter, workers };
}

function capReport(lines: Array<{ blocking: boolean; text: string }>, maxLines: number): string[] {
  const blocking = lines.filter((l) => l.blocking).map((l) => l.text);
  if (blocking.length >= maxLines) return blocking;
  const passing = lines.filter((l) => !l.blocking);
  const kept = passing.slice(0, maxLines - blocking.length);
  const collapsed = passing.length - kept.length;
  return [
    ...blocking,
    ...kept.map((l) => l.text),
    ...(collapsed > 0 ? [`${collapsed} passing item(s) collapsed to this count`] : []),
  ];
}

async function doRun(): Promise<number> {
  const planPath = value("plan");
  const repo = value("repo");
  if (planPath === undefined || repo === undefined) {
    process.stderr.write("run: --plan and --repo are required\n");
    return 2;
  }

  const runId = `run-${randomBytes(4).toString("hex")}`;
  const runsRoot = value("run-root") ?? join(homedir(), ".brigadier", "runs");
  mkdirSync(runsRoot, { recursive: true });

  // Ruling 38: the sweep runs at START, before anything new is spawned.
  //
  // SCOPED TO THIS RUN ROOT, and the scoping is the fixture keeping up with the
  // product rather than a softening of it. A bare `--brigadier-run` needle
  // matches EVERY marked process on the machine, so a second brigadier running
  // beside this one — another agent's suite, a concurrent bar scoring, an
  // operator's own run under a different root — had its workers SIGKILLed by a
  // fixture that was only supposed to be reclaiming its own leftovers. That
  // produced exactly the signature this file's own item 4 kept showing under
  // load: one worker dying mid-item, so its file never reaches the merged tree,
  // and a different failing item on every run. `src/run/start.ts` refuses the
  // same thing on the product side — `foreignMarked` is REPORTED and never
  // signalled, and `runInFlight` leaves a run whose orchestrator is alive
  // entirely alone — so an unscoped needle here also made the positive control
  // model behaviour the product does not have.
  //
  // Nothing this fixture must reclaim is lost. Every leftover of a run under
  // this root — worker, reviewer, or an escaped descendant — carries that run's
  // directory in its command line, which the first needle matches; the marker
  // needles add ruling 38's own channel for the run ids this root has a record
  // of, which is the same set `sweepAtStart` considers in scope.
  const knownRunIds = readdirSync(runsRoot).filter((entry) => entry.startsWith("run-"));
  const swept = sweepProcesses([
    join(runsRoot, "run-"),
    ...knownRunIds.map((id) => `${RUN_MARKER} ${id}`),
  ]);
  const sweptDirs = sweepDirectories(runsRoot);

  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
  const vendors = usableVendors();
  const admission = admit(plan, vendors, value("max-workers") === undefined ? undefined : Number(value("max-workers")));

  process.stdout.write(`${admission.ladderNote}\n`);
  if (admission.refused.length > 0) {
    // Ruling 11: refused BEFORE anything is spawned. Zero processes, zero clones
    // — and nothing from a committed file is ever executed to find that out.
    for (const line of admission.refused) process.stderr.write(`refused: ${line}\n`);
    return 4;
  }
  if (flag("dry-run")) {
    process.stdout.write(`admitted: ${admission.workers} worker(s) — ${admission.bindingFilter}\n`);
    return 0;
  }

  const runRoot = join(runsRoot, runId);
  mkdirSync(runRoot, { recursive: true });
  const emptyHooks = join(runRoot, "no-hooks");
  mkdirSync(emptyHooks, { recursive: true });

  // Ruling 33 repairing ruling 7: the base commit carries the owner's
  // uncommitted TRACKED and UNTRACKED work. Ruling 50: and nothing gitignored.
  // Built through a private index so the operator's `.git/index` is untouched.
  const operatorHead = run(["git", "rev-parse", "HEAD"], { cwd: repo }).out;
  const scratchIndex = join(runRoot, "scratch-index");
  const indexEnv = { ...process.env, GIT_INDEX_FILE: scratchIndex } as Record<string, string>;
  run(["git", "read-tree", "HEAD"], { cwd: repo, env: indexEnv });
  run(["git", "add", "-A"], { cwd: repo, env: indexEnv });
  const baseTree = run(["git", "write-tree"], { cwd: repo, env: indexEnv });
  const baseCommit = run(["git", ...GIT_IDENTITY, "commit-tree", baseTree.out, "-p", "HEAD", "-m", `brigadier base ${runId}`], {
    cwd: repo,
    env: indexEnv,
  });
  const baseRef = `refs/brigadier/base/${runId}`;
  run(["git", "update-ref", baseRef, baseCommit.out], { cwd: repo });

  const secretEnv = value("secret-env");
  const softCeiling = value("soft-ceiling") === undefined ? undefined : Number(value("soft-ceiling"));
  const hardCeiling = value("hard-ceiling") === undefined ? undefined : Number(value("hard-ceiling"));

  // Ruling 66: a RANGE, because #44 measured two identical Codex runs 15× apart.
  const estimateLow = plan.items.length * 0.02;
  const estimateHigh = plan.items.length * 0.30;
  process.stdout.write(
    `estimate ${estimateLow.toFixed(2)} – ${estimateHigh.toFixed(2)} USD ` +
      `(provenance: #44 measured 15× between two identical runs; published tooling puts real cost at 3–5× naive estimates)\n`,
  );
  if (flag("estimate")) {
    process.stdout.write(`admitted: ${admission.workers} worker(s) — ${admission.bindingFilter}\n`);
    rmSync(runRoot, { recursive: true, force: true });
    run(["git", "update-ref", "-d", baseRef], { cwd: repo });
    return 0;
  }

  const records: RecordItem[] = [];
  const integrated: Array<{ id: string; sha: string }> = [];
  let spend = 0;
  let softHit = false;
  let hardHit = false;
  let refusedDelegations = 0;
  const allCaught: string[] = [];

  const waves: PlanItem[][] = [
    plan.items.filter((i) => (i.dependsOn ?? []).length === 0),
    plan.items.filter((i) => (i.dependsOn ?? []).length > 0),
  ];

  let integrationTip = baseCommit.out;
  for (const wave of waves) {
    for (const item of wave.slice(0, admission.workers === 0 ? 0 : undefined)) {
      const perItem = 0.05;
      if (hardCeiling !== undefined && spend >= hardCeiling) {
        hardHit = true;
        records.push({ id: item.id, status: "cancelled" });
        continue;
      }
      if (softCeiling !== undefined && spend >= softCeiling) {
        softHit = true;
        records.push({ id: item.id, status: "unrun" });
        continue;
      }
      // Ruling 54: wave 2 clones from wave 1's integration commit, so an item
      // whose prerequisite did not integrate is UNRUN rather than run.
      const unmetPrerequisite = (item.dependsOn ?? []).find((id) => !integrated.some((i) => i.id === id));
      if (unmetPrerequisite !== undefined) {
        records.push({ id: item.id, status: "unrun" });
        continue;
      }

      const builder = vendors[records.length % Math.max(vendors.length, 1)] ?? vendors[0];
      if (builder === undefined) {
        records.push({ id: item.id, status: "failed" });
        continue;
      }

      const clone = join(runRoot, "clones", item.id);
      mkdirSync(join(runRoot, "clones"), { recursive: true });
      run(["git", "clone", "--local", "--quiet", repo, clone], { cwd: runRoot });
      run(["git", "fetch", "--quiet", "origin", `${baseRef}:refs/heads/bar-base`], { cwd: clone });
      if ((item.dependsOn ?? []).length > 0) {
        // Ruling 54: wave 2 clones from wave 1's INTEGRATION commit, so it can
        // see its prerequisite's output.
        run(["git", "fetch", "--quiet", repo, `${integrationTip}:refs/heads/bar-wave`], { cwd: clone });
        run(["git", "checkout", "--quiet", "-B", "work", "bar-wave"], { cwd: clone });
      } else {
        run(["git", "checkout", "--quiet", "-B", "work", "bar-base"], { cwd: clone });
      }
      run(["git", "update-ref", "refs/heads/bar-base", "HEAD"], { cwd: clone });
      // Ruling 51: a worker can push into the operator's repository through the
      // clone's own `origin`. Removing it is a speed bump rather than a
      // boundary, and it is removed anyway — the boundary is the ref diff.
      run(["git", "remote", "remove", "origin"], { cwd: clone });
      // Where the clone stood BEFORE the worker touched it. Since 2026-08-18
      // the fixture agent commits its own work — brigadier's worker brief tells
      // a real agent to, and ruling 56 forbids the orchestrator from running
      // git inside a clone an agent has touched — so "did work land" is HEAD
      // having MOVED, not this fixture's own commit having succeeded. The
      // commit below is now expected to be a no-op and deciding on its exit
      // code would mark every successful item `failed`.
      const headBefore = safeGit(clone, emptyHooks, ["rev-parse", "HEAD"], runRoot).out;

      const workerEnv: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        USER: process.env["USER"] ?? "",
        // Ruling 17: the config root is pointed somewhere brigadier owns, so a
        // user-global instruction file is not read.
        CLAUDE_CONFIG_DIR: join(runRoot, "agent-config"),
        XDG_CONFIG_HOME: join(runRoot, "agent-config"),
        NO_COLOR: "1",
      };
      if (secretEnv !== undefined && process.env[secretEnv] !== undefined) {
        workerEnv[secretEnv] = process.env[secretEnv] as string;
      }

      let commitNow = false;
      const outcome = await driveWorker({
        vendor: builder,
        brief: {
          itemId: item.id,
          clone,
          role: "builder",
          ...(item.directive ? { directive: item.directive as Directive } : {}),
          ...(secretEnv !== undefined ? { secretEnv } : {}),
        },
        briefPath: join(runRoot, `${item.id}.brief.json`),
        clone,
        runId,
        readOnly: item.kind === "read-only",
        answerFile: join(runRoot, `${item.id}.answer`),
        env: workerEnv,
        onCommitNow: () => {
          // The worker says its work is done and then hangs on purpose. Commit
          // NOW, so an interrupt a moment later finds a clone holding real work
          // — which is precisely the state ruling 63 says must be retained.
          commitNow = true;
          safeGit(clone, emptyHooks, ["add", "-A"], runRoot);
          safeGit(clone, emptyHooks, ["commit", "--no-verify", "-q", "-m", `${item.id}: work`], runRoot);
        },
      });
      spend += perItem;
      // `startsWith`, not equality: the fixture now names the outcome AND the
      // exit code it saw, so an equality check would silently stop counting.
      if (outcome.lines.some((l) => l.startsWith("DELEGATION-REFUSED"))) refusedDelegations += 1;

      // Ruling 49: a read-only item's directory is NEVER read back, so nothing
      // it wrote can reach the branch or any report. Not "the agent could not
      // write" — three of five measured vendors give no lane at all.
      if (item.kind === "read-only") {
        records.push({ id: item.id, status: "integrated", kind: "read-only", agent: builder, model: `${builder}-m`, effort: "medium" });
        continue;
      }

      // A fallback for a worker that wrote without committing, kept so this
      // fixture still integrates one. It is a no-op against a worker that did
      // commit, which is now the normal case.
      safeGit(clone, emptyHooks, ["add", "-A"], runRoot);
      safeGit(clone, emptyHooks, ["commit", "--no-verify", "-q", "-m", `${item.id}: work`], runRoot);
      const head = safeGit(clone, emptyHooks, ["rev-parse", "HEAD"], runRoot);
      const landed = head.ok && head.out.length > 0 && head.out !== headBefore;
      if (!landed && !commitNow) {
        records.push({ id: item.id, status: "failed", agent: builder, model: `${builder}-m`, effort: "medium" });
        continue;
      }

      // Ruling 52: the verify command was already resolved on PATH at admission,
      // so a failure here is the CHECK failing rather than the checker missing.
      let verifyFailed = false;
      if (item.verify !== undefined) {
        const parts = item.verify.trim().split(/\s+/);
        verifyFailed = !run(parts, { cwd: clone }).ok;
      }

      // Ruling 32: the reviewer's vendor differs from the builder's where it can,
      // and a weakened check is stated rather than rendered as a pass.
      const reviewer = vendors.find((v) => v !== builder) ?? builder;
      let verdict: RecordItem["reviewVerdict"] = "skipped";
      let caught: string[] = [];
      if (flag("review")) {
        // Ruling 52's framing: the reviewer gets the exact diff from the
        // owner's committed state, so uncommitted work the base commit carried
        // is visible to it too. Diffing from the base commit would hide it.
        // Taken in the CLONE: at review time the work has not been fetched into
        // the operator's repository yet, so diffing there produced nothing and
        // the reviewer was handed an empty string.
        const diff = safeGit(clone, emptyHooks, ["diff", `${operatorHead}..HEAD`], runRoot).out;
        const reviewOutcome = await driveWorker({
          vendor: reviewer,
          brief: { itemId: item.id, clone, role: "reviewer", diff },
          briefPath: join(runRoot, `${item.id}.review.json`),
          clone,
          runId,
          readOnly: true,
          answerFile: join(runRoot, `${item.id}.review.answer`),
          env: workerEnv,
        });
        const line = reviewOutcome.lines.find((l) => l.startsWith("VERDICT "));
        if (line === undefined) {
          // Ruling 52: no verdict is `error`, and `error` BLOCKS. v1 merged its
          // most delicate change on `review: not run (REVIEWER_FAILED)`.
          verdict = "error";
        } else {
          const parsed = JSON.parse(line.slice(8)) as { verdict: string; found: string[] };
          caught = parsed.found;
          for (const marker of caught) if (!allCaught.includes(marker)) allCaught.push(marker);
          verdict = parsed.verdict === "approved" ? "pass" : "fail";
        }
      }

      const record: RecordItem = {
        id: item.id,
        status: verifyFailed || verdict === "error" || verdict === "fail" ? "failed" : "integrated",
        kind: "write",
        agent: builder,
        builderAgent: builder,
        ...(flag("review") ? { reviewerAgent: reviewer, reviewVerdict: verdict } : {}),
        model: `${builder}-m`,
        effort: "medium",
        // Ruling 67: printed per item, and only ever DOWNWARD — an upgrade
        // spends money the operator did not ask for.
        ...(item.difficulty ? { difficulty: item.difficulty, clampedTo: item.difficulty === "hard" ? "medium" : item.difficulty } : {}),
        attempts: 1,
        attemptsAvailable: vendors.length >= 2 ? 2 : 1,
        commit: head.out,
        checks: [
          { name: "worker exited 0", outcome: outcome.code === 0 ? "pass" : "fail", blocking: true },
          ...(item.verify !== undefined
            ? [{ name: "tests_pass", outcome: verifyFailed ? ("fail" as const) : ("pass" as const), blocking: true }]
            : []),
          ...(flag("review") ? [{ name: "review", outcome: verdict, blocking: true } as const] : []),
        ],
        ...(caught.length > 0 ? { caughtDefects: caught } : {}),
      } as RecordItem;
      records.push(record);
      if (record.status !== "integrated") continue;

      // Ruling 51: FETCH, never push, and no working tree on the integration side.
      run(["git", "fetch", "--quiet", clone, `HEAD:refs/brigadier/item/${runId}/${item.id}`], { cwd: repo });
      const merged = run(["git", "merge-tree", "--write-tree", integrationTip, head.out], { cwd: repo });
      if (!merged.ok) {
        records[records.length - 1] = { ...record, status: "failed" };
        continue;
      }
      const commit = run(
        ["git", ...GIT_IDENTITY, "commit-tree", merged.out.split("\n")[0] ?? "", "-p", integrationTip, "-p", head.out, "-m", `${item.id}: integrated`],
        { cwd: repo },
      );
      integrationTip = commit.out;
      integrated.push({ id: item.id, sha: head.out });
    }
  }

  const integrationRef = `refs/heads/brigadier/${runId}`;
  if (integrated.length > 0) run(["git", "update-ref", integrationRef, integrationTip], { cwd: repo });

  // Interrupted. Ruling 63: the clones that hold committed work stay where they
  // are, un-merged and un-deleted, and this process waits out its drain so a
  // second signal has something to re-raise against.
  if (draining) {
    run(["git", "update-ref", "-d", baseRef], { cwd: repo });
    process.stdout.write("interrupted: draining, retained clones left in place\n");
    await drainForever();
  }

  // Ruling 50: the scratch base ref is cleaned up, and the operator's tree is
  // byte-identical afterwards INCLUDING after that cleanup.
  run(["git", "update-ref", "-d", baseRef], { cwd: repo });
  for (const item of integrated) run(["git", "update-ref", "-d", `refs/brigadier/item/${runId}/${item.id}`], { cwd: repo });

  const transcripts = join(runRoot, "transcripts");
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(
    join(transcripts, "full.log"),
    `${records.map((r) => `[${r.id}] agent=${r.agent ?? "none"} status=${r.status}\n${"turn detail\n".repeat(30)}`).join("")}`,
  );

  const quota: Record<string, "read" | "unreadable" | "unpriceable"> = {};
  for (const vendor of vendors) {
    // #42 measured opencode reaching a model with NO credential at all through
    // its own gateway, so a successful turn proves nothing about the account.
    quota[vendor] = vendor === "opencode" ? "unpriceable" : "read";
  }

  const record: RunRecord = {
    runId,
    integrationRef,
    runRoot,
    bindingFilter: admission.bindingFilter,
    workers: admission.workers,
    refusedDelegations,
    ambientSuppressed: ["user-global instruction files (config root redirected)", "brigadier's own plugin (worker marker set)"],
    ...(flag("review")
      ? {
          review: {
            crossVendor: records.some((r) => r.builderAgent !== undefined && r.reviewerAgent !== r.builderAgent),
            ...(vendors.length < 2 ? { sameVendorReason: "only one vendor is drivable on this machine" } : {}),
            caught: allCaught.length,
            planted: Number(value("planted") ?? 0),
            caughtDefects: allCaught,
          },
        }
      : {}),
    cost: {
      currency: "USD",
      estimateLow,
      estimateHigh,
      provenance: "#44 measured two identical Codex runs at 427,723 and 28,245 bytes — 15×",
      actual: spend,
      ...(softCeiling !== undefined ? { softCeiling } : {}),
      ...(hardCeiling !== undefined ? { hardCeiling } : {}),
      softCeilingHit: softHit,
      hardCeilingHit: hardHit,
      quota,
      levers: ["prompt cache (measured at 16.5× elsewhere; this run makes no claim to have saved anything)"],
      lowerBound: vendors.includes("opencode"),
    },
    transcriptsPath: transcripts,
    items: records,
  };

  const recordPath = join(runRoot, "record.json");
  const redact = (text: string): string => {
    const secret = secretEnv === undefined ? undefined : process.env[secretEnv];
    if (secret === undefined || secret.length === 0) return text;
    // Ruling 65: redaction at ONE sink, over every enumerated encoding.
    let out = text;
    for (const form of [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret, "utf8").toString("base64"),
    ]) {
      if (form.length > 0) out = out.split(form).join("[redacted]");
    }
    return out;
  };
  writeFileSync(recordPath, redact(JSON.stringify(record, null, 2)));
  writeFileSync(join(transcripts, "full.log"), redact(readFileSync(join(transcripts, "full.log"), "utf8")));
  writeFileSync(join(runRoot, "complete"), "");
  // Ruling 63: directories only for COMPLETE runs. This run completed, so its
  // clones go now rather than lingering until someone happens to start again —
  // a clone left behind is a checkout of the operator's tree sitting on disk.
  // The record and the transcripts stay: item 11 requires the full record to be
  // there, and a report that names a path nothing is at is a report that lies.
  rmSync(join(runRoot, "clones"), { recursive: true, force: true });

  // Report. Under a host-session audience it is capped, and ruling 52's rule is
  // that a cap prints fewer ITEMS and never fewer CHECKS — so a failing item and
  // every one of its blocking checks always survives.
  const lines = records.map((r) => ({
    blocking: r.status !== "integrated",
    text:
      r.status === "integrated"
        ? `${r.id}: integrated (agent ${r.agent}, model ${r.model}, effort ${r.effort}${r.difficulty ? `, difficulty: ${r.difficulty} (clamped to ${r.clampedTo})` : ""}, attempts ${r.attempts} of ${r.attemptsAvailable}${(r.attemptsAvailable ?? 0) < 2 ? " — no second rung" : " (second rung available)"})`
        : `${r.id}: ${r.status.toUpperCase()} — ${(r.checks ?? []).filter((c) => c.blocking && c.outcome !== "pass").map((c) => c.name).join(", ") || r.status}`,
  }));
  const host = value("audience") === "host-session";
  for (const line of capReport(lines, host ? 12 : 1000)) process.stdout.write(`${line}\n`);

  process.stdout.write(`${admission.workers} worker(s) — ${admission.bindingFilter}\n`);
  if (record.review) {
    process.stdout.write(
      record.review.crossVendor
        ? "review ran cross-vendor\n"
        : `review ran same-vendor — ${record.review.sameVendorReason}\n`,
    );
    process.stdout.write(`catch rate ${record.review.caught} of ${record.review.planted} (v1's baseline was 0 of 3)\n`);
  }
  if (refusedDelegations > 0) {
    process.stdout.write(
      `${refusedDelegations} worker(s) attempted to delegate to brigadier and were refused — check the repository's AGENTS.md and the brief.\n`,
    );
  }
  process.stdout.write("ambient instruction files were suppressed for every worker\n");
  process.stdout.write(
    `actual ${spend.toFixed(2)} USD against predicted ${estimateLow.toFixed(2)} – ${estimateHigh.toFixed(2)}` +
      `${record.cost?.lowerBound ? " (a LOWER BOUND: a vendor in this run is unpriceable)" : ""}\n`,
  );
  process.stdout.write(
    `ceilings — soft ${softHit ? "reached: no new items dispatched" : "not reached"}, hard ${hardHit ? "reached: work in flight cancelled" : "not reached"}\n`,
  );
  for (const [vendor, state] of Object.entries(quota)) process.stdout.write(`quota — ${vendor}: ${state}\n`);
  process.stdout.write(`levers active: ${record.cost?.levers.join("; ")}\n`);
  if (swept.length > 0 || sweptDirs.removed.length > 0) {
    process.stdout.write(`sweep reclaimed ${swept.length} process(es) and ${sweptDirs.removed.length} directory(ies)\n`);
  }
  for (const retained of sweptDirs.retained) {
    process.stdout.write(`retained (interrupted, has committed work, not merged and not deleted): ${retained}\n`);
  }
  process.stdout.write(`transcripts: ${transcripts}\n`);
  process.stdout.write(`run-record: ${recordPath}\n`);

  return records.every((r) => r.status === "integrated") ? 0 : 1;
}

// -------------------------------------------------------------- other verbs

/**
 * Ruling 68: every row with its evidence class and its citation, no citation a
 * LINE ANCHOR — v1 lost 8 of 44 rows to one comment-only sweep — and a model the
 * table has never heard of is used, sorted last, and NAMED.
 */
function competence(): number {
  const rows = [
    ["claude-opus", "0.92", "measured", "#46 ACP handshake and window probe"],
    ["codex-gpt5", "0.88", "measured", "#41 sandbox and permission probe"],
    ["copilot-1.0.80", "0.71", "reported", "vendor model card, retrieved 2026-08-17"],
    ["qwen-code", "0.54", "measured", "#50 permission-request census"],
    ["a-model-nobody-ranked", "unranked", "editorial", "not in the table — used, sorted last, and named rather than excluded"],
  ];
  for (const row of rows) process.stdout.write(`${row.join("  ")}\n`);
  return 0;
}

function licenses(): number {
  process.stdout.write("brigadier — Apache-2.0\nCopyright 2026 Stephen Golban\n\n");
  process.stdout.write("Third-party components compiled into this binary:\n\n  bun 1.3.14 — MIT\n");
  if (flag("full")) {
    process.stdout.write("\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n");
    process.stdout.write("APPENDIX: How to apply the Apache License to your work.\n");
    process.stdout.write("\nGNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1, February 1999\n");
    process.stdout.write("This library is free software; you can redistribute it and/or modify it.\n");
    process.stdout.write(
      "To relink: clone https://github.com/oven-sh/WebKit pinned to 532c8b70b9142c17e07737ab6d3da68d7500cbca\n",
    );
    process.stdout.write("tinycc corresponding source, pinned to 0123456789abcdef0123456789abcdef01234567\n");
  }
  return 0;
}

const USAGE = "brigadier (fixture) — run, competence, licenses, agents\n";

const exitCode = await (async () => {
  const command = argv[0];
  // Ruling 57, read before any command dispatch and before any input is read.
  if (command !== undefined && ["run", "plan"].includes(command) && (process.env[WORKER_MARKER] ?? "") !== "") {
    process.stderr.write("brigadier is already running: this session IS a brigadier worker.\n\nDo the work directly.\n");
    return 3;
  }
  switch (command) {
    case "run":
      return doRun();
    case "competence":
      return competence();
    case "licenses":
      return licenses();
    case "agents":
      process.stdout.write("qwen — Qwen Code\n  command    qwen --acp\n  measured   0.21.13\n\n");
      return 0;
    case undefined:
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      return 2;
  }
})();

process.exit(exitCode);
