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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordItem, RunRecord } from "../lib/contract.ts";
import { cloneDirsUnder, productRunDir } from "../lib/layout.ts";
import type { Directive, Plan, PlanItem } from "../lib/plan.ts";

const VENDOR_SCRIPT = fileURLToPath(new URL("./vendor.ts", import.meta.url));
const KNOWN_VENDORS = ["claude", "codex", "copilot", "qwen", "opencode", "gemini"];
const RUN_MARKER = "--brigadier-run";
const WORKER_MARKER = "BRIGADIER_WORKER";

// --------------------------------------------------------------- the unit
//
// TOKENS, NEVER MONEY, and in this file that is a correction rather than a
// style. The fixture priced itself in dollars — `currency: "USD"`, 0.05 per
// item — while `src/queue/estimate.ts` states in its header that converting
// tokens to currency needs a per-model rate this repository has never measured,
// and REFUSES to do it. A positive control that contradicts the product's own
// contract is not measuring the product: item 13 calibrates its two ceilings
// from what an uncapped run actually spent, and a run that spent `0.2` of
// something gives it nothing to calibrate with, so every ceiling below it fires
// before dispatch or never.
//
// The arithmetic is the product's own, constant for constant, so a reader can
// check this file against `src/queue/estimate.ts` rather than against a guess.
const CHARS_PER_TOKEN = 4;
/** #23 measured `chars/4` underestimating a real artifact by 22%. Applied, not noted. */
const NAIVE_CORRECTION = 1.22;
/** #14: ~46 KB of agent→client traffic for a ONE-LINE change, on both vendors. */
const MEASURED_ITEM_BYTES = 46 * 1024;
/** Published tooling puts real cost at 3–5×; #44 measured 15× between two identical runs. */
const SPREAD_LOW = 1;
const SPREAD_HIGH = 5;
/** Ruling 58, which is ruling 39's repo-map budget reused as a precedent. */
const HOST_REPORT_TOKEN_CEILING = 2_000;
/** Ruling 14's second filter. `src/work/fanout.ts`'s `DEFAULT_DESIRABILITY_CAP`. */
const DESIRABILITY_CAP = 3;

/**
 * Ruling 14's THIRD filter, computed from this machine — reimplemented here,
 * never imported, because a positive control assembled from the code under test
 * proves nothing about it.
 *
 * It was the constant 64, and a constant is not a cap. No plan the bar drives
 * has 64 items, so RAM could never be the lowest filter, this fixture could
 * never emit ruling 54's third sentence, and it was therefore the positive
 * control for two of the three causes and a silent gap for the third. MEASURED
 * on 2026-08-20: item 4 climbed to an eight-item plan with a budget far above
 * any machine and still got `the plan had 8 item(s)` back, because 8 < 64.
 *
 * Ruling 54: the input is `totalmem()` and NEVER `freemem()` — free memory on a
 * healthy machine reads near zero and two samples seconds apart differ by
 * gigabytes, so the obvious implementation returns no workers at all on a
 * machine the operating system itself calls 41% free. The reserves are the
 * operating system's own footprint and, under decision 25, the host agent
 * brigadier is running inside: it is an agent, so it gets an agent's budget.
 */
const GIB = 1024 ** 3;
const WORKER_BUDGET_BYTES = 3 * GIB;
const OS_RESERVE_BYTES = 4 * GIB;
const HOST_AGENT_RESERVE_BYTES = 3 * GIB;

function ramCap(): number {
  const spare = totalmem() - OS_RESERVE_BYTES - HOST_AGENT_RESERVE_BYTES;
  return Math.max(0, Math.floor(spare / WORKER_BUDGET_BYTES));
}
/** `src/gate/run.ts`: how much of a failing checker's own output reaches its check. */
const VERIFY_TAIL_LINES = 12;

/** What a piece of text costs the window it lands in. The estimator the bar uses. */
function tokensOf(text: string): number {
  return Math.ceil((text.length / CHARS_PER_TOKEN) * NAIVE_CORRECTION);
}

/** The naive floor for one item, before the spread. */
function naiveItemTokens(): number {
  return Math.ceil((MEASURED_ITEM_BYTES / CHARS_PER_TOKEN) * NAIVE_CORRECTION);
}

/** Ruling 30's vocabulary. `max` and `ultra` are absent rather than filtered. */
const EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;
type EffortGrade = (typeof EFFORT_ORDER)[number];
/** Ruling 30: hard, across every vendor. Only the operator's own flag moves it. */
const EFFORT_CEILING: EffortGrade = "high";
/** Ruling 40: a vendor with no measured lever says so, and says it in these words. */
const NO_LEVER = "none measured";

/**
 * Ruling 31: DERIVED from (kind, difficulty), never taken from the plan.
 *
 * Ruling 49's read-only step-down is applied afterwards — an item nobody diffs,
 * merges or reads back cannot have a more expensive attempt checked, so paying
 * for one buys an unverifiable answer — and ruling 30's ceiling last.
 */
function derivedEffort(kind: string | undefined, difficulty: string | undefined): EffortGrade {
  const base: Record<string, EffortGrade> = { easy: "low", medium: "medium", hard: "high" };
  const asked = base[difficulty ?? "medium"] ?? "medium";
  const stepped: EffortGrade =
    kind === "read-only" ? (EFFORT_ORDER[Math.max(0, EFFORT_ORDER.indexOf(asked) - 1)] ?? asked) : asked;
  return EFFORT_ORDER.indexOf(stepped) > EFFORT_ORDER.indexOf(EFFORT_CEILING) ? EFFORT_CEILING : stepped;
}

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
 *
 * IT RETURNS PIDS, NOT A COUNT, and that is ruling 63's fourth fact rather than
 * a convenience. This function used to hand back pre-rendered strings and its
 * only caller printed `sweep reclaimed 1 process(es)`. A sweep that kills
 * silently is indistinguishable from a sweep that found nothing, and the pid is
 * the only remedy an operator can act on — so the pid travels, into
 * `describeSweep`'s lines for a reader and into the run record's `swept` event
 * for anything reading afterwards. Item 7 asks for exactly this and used to read
 * its own `stat` instead, which passed against a product that printed nothing.
 */
interface Reclaimed {
  pid: number;
  commandLine: string;
}

function sweepProcesses(needles: string[]): Reclaimed[] {
  if (needles.length === 0) return [];
  const listing =
    process.platform === "win32"
      ? run(["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"])
      : run(["ps", "-A", "-o", "pid=,args="]);
  if (!listing.ok) return [];

  const killed: Reclaimed[] = [];
  for (const line of listing.out.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === process.pid || !needles.some((n) => command.includes(n))) continue;
    if (/\bps\b|Get-CimInstance/.test(command)) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed.push({ pid, commandLine: command.slice(0, 120) });
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
  // `<run-root>/r/<run-id>/<item>` — ruling 61's short shape, taken from the
  // product's own source by `bar/lib/layout.ts`. The fixture held a shape of
  // its own invention (`<run-root>/<run-id>/clones/<id>`) for nine rounds, and
  // it agreed with item 7's equally invented one, so the pair looked healthy
  // while both were looking where the product puts nothing.
  const runs = join(runsRoot, productRunDir());
  if (!existsSync(runs)) return { removed, retained };

  for (const entry of readdirSync(runs)) {
    const runDir = join(runs, entry);
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
    let kept = false;
    for (const child of readdirSync(runDir)) {
      if (!/^[0-9]+$/.test(child)) continue;
      const clone = join(runDir, child);
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
  /** Ruling 66's hard ceiling reached this worker while it was still running. */
  cancelled?: boolean;
}

/**
 * Ruling 65's four enumerated encodings, applied at this fixture's ONE sink.
 *
 * Hoisted to module scope because two different writers need it: the transcript
 * at the end of the run, and the brief file `driveWorker` writes at the start of
 * each turn. Ruling 65's whole shape is that there is ONE redactor and
 * everything brigadier writes goes through it — a fixture with a redactor that
 * only the last writer can reach is not modelling that.
 */
function redactGranted(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
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
}

/**
 * One transcript line, in the shape `src/queue/execute.ts` writes.
 *
 * The product pushes `<itemId> <direction> <raw frame>` for the builder and
 * `<itemId> review <in|out> <raw frame>` for the reviewer, then writes the whole
 * file through the sink. `bar/lib/item5-verifier-transcript.ts` parses exactly
 * that, and `bar/items/12-secret-not-persisted.ts` asserts the sink's
 * placeholder stands in it — so the format is a contract, not a rendering
 * choice.
 *
 * ONE level of JSON escaping, and that is load-bearing. The frame's `text` is
 * prose, so a secret inside it is escaped exactly once and the enumerated
 * `json-escaped` form matches it. Serialising an already-serialised object here
 * would escape it TWICE, and a doubly-escaped value matches none of the four
 * enumerated encodings — it would sail straight through the redactor, which is
 * the "re-encodes it in a scheme we do not enumerate" limit BAR.md states out
 * loud.
 */
function frameLine(label: string, direction: "in" | "out", session: string, text: string): string {
  const frame =
    direction === "out"
      ? { jsonrpc: "2.0", method: "session/prompt", params: { sessionId: session, prompt: [{ type: "text", text }] } }
      : {
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
        };
  return `${label} ${direction} ${JSON.stringify(frame)}`;
}

async function driveWorker(options: {
  /** The vendor's own executable. It knows where its configuration lives. */
  vendor: string;
  brief: unknown;
  briefPath: string;
  clone: string;
  runId: string;
  /** Ruling 59's identity: the 1-based ordinal the run routes this item under. */
  item: number;
  /** The transcript prefix `execute.ts` uses — `<itemId>` or `<itemId> review`. */
  label: string;
  /** The prose brigadier would put on the wire. Carries the reviewer's diff. */
  promptText: string;
  /** Accumulates this run's frames, written through the sink at the end. */
  transcript: string[];
  /** The granted value, so everything this function writes goes through the sink. */
  secret: string | undefined;
  readOnly: boolean;
  answerFile: string;
  env: Record<string, string>;
  onCommitNow?: () => void;
  /**
   * Ruling 66's counter, called with every byte that crosses this wire.
   *
   * The unit is TOKENS and the bytes are real ones: the prompt brigadier sent
   * and every line the worker answered, which is the same traffic #14 measured.
   * Returning `true` means the hard ceiling has been reached and this worker is
   * to be cancelled where it stands — the one behaviour that tells a hard
   * ceiling apart from a soft one, and the reason this is a callback rather than
   * a number added up afterwards. A cost counted only when a worker EXITS
   * cannot cancel anything in flight, and a fixture whose hard ceiling only ever
   * declines to dispatch is modelling the soft one twice.
   */
  charge?: (text: string) => boolean;
  /** Registers the child so a ceiling crossed by a SIBLING can reach this one. */
  inFlight?: Set<{ kill(signal?: string | number): void }>;
}): Promise<WorkerOutcome> {
  // Through the sink, like everything else. A reviewer's brief carries the diff,
  // and the diff carries whatever the worker committed.
  writeFileSync(options.briefPath, redactGranted(JSON.stringify(options.brief, null, 2), options.secret));
  writeFileSync(options.answerFile, "");

  // Ruling 38: the run marker goes in the COMMAND LINE of every process
  // brigadier causes to exist, never in a name pattern — a sweep scanning `ps`
  // cannot see an environment variable.
  const proc = Bun.spawn(
    [options.vendor, options.briefPath, RUN_MARKER, options.runId],
    {
      cwd: options.clone,
      // Ruling 59 upgrades this marker from a boolean to an IDENTITY:
      // `<run-id>/<item>`, where `<item>` is the 1-based ordinal the run routes
      // by. `src/agent/marker.ts`'s `workerIdentity` parses the tail with
      // `Number.isInteger(item) && item >= 1` and returns null otherwise — so
      // the literal `x` this fixture used to emit made a refusing worker report
      // `no-home`, and per-item attribution against this fixture impossible.
      // Item 9 had to build a labelled-pigeonhole fallback around it, which
      // collapsed "the guard fired" into "the guard never got the chance".
      env: {
        ...options.env,
        BAR_ANSWER_FILE: options.answerFile,
        [WORKER_MARKER]: `${options.runId}/${options.item}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  children.add(proc);
  options.inFlight?.add(proc);
  let cancelled = false;
  /** Charge, and stop where we stand if that crossed the hard ceiling. */
  const spendOn = (text: string): void => {
    if (options.charge?.(text) !== true || cancelled) return;
    cancelled = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone; the read loop below ends either way.
    }
  };
  // Checked on 2026-08-18 against the deadlock fixed in `bar/fakes/vendor.ts`:
  // this loop reads the worker's STDOUT and answers on a different channel
  // entirely — `BAR_ANSWER_FILE`, a file the worker polls — and every branch
  // below is synchronous. The reader therefore never waits on anything that
  // could only arrive through the stream it has stopped reading. Answering on
  // the worker's stdin instead would reintroduce exactly that shape.
  const session = `${options.runId}/${options.item}`;
  // The frame brigadier SENDS. In the product this is a `session/prompt` over
  // ACP; here the fixture speaks its own CLI protocol, so the frame is
  // synthesised — but the BYTES are the real ones, which is the half that
  // matters: a reviewer's prompt carries the diff of what the worker committed.
  options.transcript.push(frameLine(options.label, "out", session, options.promptText));
  spendOn(options.promptText);

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
      options.transcript.push(frameLine(options.label, "in", session, line));
      spendOn(line);
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
  options.inFlight?.delete(proc);
  return { code: proc.exitCode, lines, denied, ...(cancelled ? { cancelled: true } : {}) };
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
  // `src/work/fanout.ts`'s DEFAULT_DESIRABILITY_CAP, and it is load-bearing
  // rather than cosmetic: it is what makes a run DISPATCH IN BATCHES, which is
  // in turn the only shape in which ruling 66's two ceilings are
  // distinguishable. A fixture that dispatched one item at a time can never
  // cross a hard ceiling with work in flight — the soft one always stops
  // dispatch first — so its hard ceiling could only ever decline to start
  // something, which is the soft ceiling's behaviour under the other name.
  const byDesirability = maxWorkers ?? DESIRABILITY_CAP;
  const byRam = ramCap();
  const workers = Math.min(byPlan, byDesirability, byRam);
  const bindingFilter =
    workers === byPlan && byPlan <= byDesirability && byPlan <= byRam
      ? `the plan had ${byPlan} item(s), which was the binding filter`
      : workers === byDesirability
        ? `desirability capped it at ${byDesirability}, which was the binding filter`
        : `available RAM capped it at ${byRam}, which was the binding filter: this machine's TOTAL memory, ` +
          `less the operating system's share and the host agent's own, leaves room for that many at 3 GiB each`;

  // Ruling 55: a short ladder is stated at plan ADMISSION, before anything is
  // spent — finding 87 discovered it after an attempt was already gone.
  const ladderNote =
    vendors.length >= 2
      ? "ladder: 2 rungs (a second vendor is available for rung two)"
      : "ladder: 1 rung — no second rung, because only one vendor is drivable on this machine";

  return { refused, ladderNote, bindingFilter, workers };
}

/**
 * The admission block, SIZED FOR WHOEVER PAYS FOR IT.
 *
 * Ruling 58's ceiling is on the CHANNEL, not on the report alone: everything
 * this process writes to stdout lands in the same context window and is charged
 * once. So the two O(items) sections here — wave membership and the per-item
 * admission facts — collapse to counts in `host-session` and stay in full for a
 * terminal reader, exactly as `src/queue/admit.ts`'s `describeAdmission` does.
 *
 * THAT DIFFERENCE IS ALSO THE POSITIVE CONTROL FOR ITEM 11, and that is why it
 * had to exist here. Item 11 asserts that `--verbose` buys a host session
 * NOTHING — the same bytes, to the character — and a comparison of two
 * identical strings is worth nothing from an instrument that cannot see a
 * difference at all. It proves the instrument can by comparing the same command
 * under two audiences. This fixture emitted the same 139 bytes for both, so the
 * control could not fire and the check beside it was vacuous: it would have
 * passed against a binary that ignored its entire command line.
 *
 * Nothing is LOST in the capped rendering that a reader cannot reach: the plan
 * file is named on the first line and is where every per-item fact came from.
 *
 * The per-item lines deliberately do NOT start `<id>:`. Item 11 and item 13 find
 * the report's block for an item by anchoring at `^\s*<id>:\s`, and an
 * admission block that used the same shape would hand them the wrong lines
 * whenever a run is driven for a terminal.
 */
function describeAdmission(
  plan: Plan,
  admission: Admission,
  planPath: string,
  vendors: string[],
  capped: boolean,
): string[] {
  const waves = [
    plan.items.filter((i) => (i.dependsOn ?? []).length === 0),
    plan.items.filter((i) => (i.dependsOn ?? []).length > 0),
  ].filter((wave) => wave.length > 0);
  const lines = [
    `admitted — ${planPath}: ${plan.items.length} item(s) in ${waves.length} wave(s)`,
    vendors.length === 0
      ? "  agents     none resolved on PATH"
      : `  agents     ${vendors.length} resolved on PATH: ${vendors.join(", ")}`,
    "             resolving a name is not driving an agent — `brigadier detect` opens a session,",
    "             and that is the only thing that proves one is usable (ruling 46).",
    `  ladder     ${admission.ladderNote}`,
  ];
  for (const [index, wave] of waves.entries()) {
    lines.push(
      capped
        ? `  wave ${index + 1}     ${wave.length} item(s)`
        : `  wave ${index + 1}     ${wave.map((i) => i.id).join(", ")}`,
    );
  }
  if (capped) {
    // Ruling 58's collapse rule: print fewer ITEMS, never fewer KINDS OF FACT.
    // Every category a terminal reader would have seen is still named, so a
    // category cannot vanish by looking empty — the clamp in particular, which
    // ruling 67 exists to keep visible.
    const clamped = plan.items.filter((i) => i.difficulty === "hard");
    const declared = plan.items.filter((i) => i.difficulty !== undefined && i.difficulty !== "hard");
    const verified = plan.items.filter((i) => i.verify !== undefined);
    lines.push(
      `  items      ${plan.items.length} collapsed to these counts; per-item facts are in ${planPath}`,
      `             difficulty clamped down: ${clamped.length}${clamped.length > 0 ? ` (${clamped.map((i) => i.id).join(", ")})` : ""}`,
      `             difficulty declared and kept: ${declared.length}`,
      `             verify command resolved: ${verified.length}; not configured: ${plan.items.length - verified.length}`,
    );
  } else {
    for (const item of plan.items) {
      const clamp = item.difficulty === undefined ? "" : `, difficulty ${item.difficulty}${item.difficulty === "hard" ? " (clamps to medium)" : ""}`;
      lines.push(
        `  item ${item.id}  ${item.kind ?? "write"}${clamp}, paths ${(item.paths ?? []).join(" ") || "none declared"}, ` +
          `verify ${item.verify === undefined ? "not configured" : `resolved: ${item.verify}`}`,
      );
    }
  }
  lines.push(
    "  ruling 37  a verify command committed in the repository is never read and never run:",
    "             brigadier runs the command the operator handed it, and nothing else.",
  );
  return lines;
}

/**
 * One item's BLOCK: the head line the report gives it, and its checks under it.
 *
 * A block rather than a line, because ruling 52 is about checks and a check has
 * nowhere to live on a one-line rendering. `bar/lib/item11-structure.ts` reads
 * exactly this shape — the head line anchored at `^<id>:` and everything
 * indented beneath it — and it reads it that way because a whole-report
 * containment test could not tell `fifty-4` from `fifty-43`, nor an item's own
 * `verify` check from the tail sentence *"the merged result was verified"*.
 */
interface ItemBlock {
  blocking: boolean;
  text: string;
}

/**
 * The report, capped where the audience pays for it — and OVER the cap, out
 * loud, where ruling 52 says it must be.
 *
 * The cap is applied by REMOVING PASSING ITEMS one budget at a time and it stops
 * at the blocking set, which is the whole of ruling 52 in a loop. When the
 * blocking items ALONE exceed what is left of the ceiling there is nothing more
 * to drop: the report goes over and SAYS SO, because a report that quietly
 * exceeds a budget has spent the reader's window without telling them.
 *
 * `alreadySpent` is not a refinement. Ruling 58's ceiling is on the CHANNEL:
 * the admission block and the estimate landed on the same stdout and were
 * charged to the same window, so the report may spend the ceiling MINUS what
 * they cost. A budget that governs only the last thing written is not a budget —
 * MEASURED on the product on 2026-08-18, where a fifty-item run printed 3,682
 * tokens against a 2,000-token ceiling while its report was inside budget the
 * whole time.
 */
function composeReport(
  blocks: ItemBlock[],
  head: string[],
  tail: string[],
  capped: boolean,
  alreadySpent: number,
): string[] {
  const passingCount = blocks.filter((b) => !b.blocking).length;
  const assemble = (keep: number): string[] => {
    let budget = keep;
    const body: string[] = [];
    let collapsed = 0;
    for (const block of blocks) {
      if (block.blocking) {
        body.push(block.text);
        continue;
      }
      if (budget > 0) {
        budget -= 1;
        body.push(block.text);
      } else collapsed += 1;
    }
    if (collapsed > 0) {
      body.push(
        `${collapsed} passing item(s) collapsed to this count — the cap can hide a success and can never hide a failure (ruling 58)`,
      );
    }
    return [...head, ...body, ...tail];
  };

  if (!capped) return assemble(passingCount);

  const ceiling = Math.max(0, HOST_REPORT_TOKEN_CEILING - Math.max(0, alreadySpent));
  for (let keep = passingCount; keep >= 0; keep -= 1) {
    const lines = assemble(keep);
    if (tokensOf(lines.join("\n")) <= ceiling) return lines;
  }
  const lines = assemble(0);
  const cost = tokensOf(lines.join("\n"));
  return [
    ...lines,
    // AT COLUMN ZERO, where the product makes its run-level statements, and
    // naming the number it broke. Ruling 52 has no exception for space at any
    // level: not one failing item and not one of their checks was dropped to
    // fit, so the excess is the honest outcome and stating it is the rest of it.
    `this report is OVER ruling 58's ${HOST_REPORT_TOKEN_CEILING.toLocaleString("en-US")}-token ceiling: the blocking items ` +
      `alone cost ${cost.toLocaleString("en-US")} tokens against the ${ceiling.toLocaleString("en-US")} this stdout had ` +
      "left. Nothing was dropped to fit — ruling 52 has no exception for space, so a failure is never traded for room.",
  ];
}

/**
 * Ruling 67's clamp, and it only ever goes DOWN.
 *
 * The default effort ceiling sits at `medium` for an undeclared plan, so a
 * `hard` declaration is clamped to it and everything else is kept. An upgrade
 * would spend money the operator did not ask for, which is the one direction
 * ruling 67 forbids outright.
 */
function clampDifficulty(difficulty: string): string {
  return difficulty === "hard" ? "medium" : difficulty;
}

/**
 * Ruling 29's third member, and the three fields amendment §19 says were
 * DECLARED AND NEVER ASSIGNED.
 *
 * `effort` alone is not the triple: a field that renders as the nine characters
 * `undefined` satisfies every containment test ever written against it, which is
 * exactly how the product's own record carried the hole for as long as it
 * existed. So the machine-readable grade is written beside the rendered one, it
 * is DERIVED from (kind, difficulty) per ruling 31 rather than taken from the
 * plan, and #45's `effortConfirmed` is the literal `false` because neither
 * measured vendor's effort setting is confirmable over the protocol — there is
 * no way to earn a `true` and no value that may imply one.
 */
function effortFields(
  kind: "write" | "read-only",
  difficulty: string | undefined,
): Pick<RecordItem, "effort" | "effortRequested" | "effortLever" | "effortDisposition" | "effortConfirmed"> {
  const requested = derivedEffort(kind, difficulty === undefined ? undefined : clampDifficulty(difficulty));
  return {
    // Ruling 29: the qualifier lives INSIDE the rendered value. `high` alone
    // would read as the effort that RAN.
    effort: `${requested} (set, NOT confirmed — #45)`,
    effortRequested: requested,
    // Ruling 40: absent is not zero, and it is not default-is-fine.
    effortLever: NO_LEVER,
    effortDisposition: `requested ${requested}; this vendor exposes no effort lever this build has measured`,
    effortConfirmed: false,
  };
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

  // Ruling 58's audience, DEFAULTING TO `host-session` because that is what
  // `src/cli.ts` defaults to and decision 25 makes the product host-first. A
  // fixture whose default was the uncapped rendering would be graded on the one
  // path the product's own users do not take.
  const audience = value("audience") ?? "host-session";
  const capped = audience === "host-session";
  // Every byte this process puts on stdout, counted as it goes. Ruling 58's
  // ceiling is on the CHANNEL: the report's budget is the ceiling minus what the
  // admission block and the estimate already charged to the same window.
  let spentOnStdout = 0;
  const say = (line: string): void => {
    spentOnStdout += tokensOf(`${line}\n`);
    process.stdout.write(`${line}\n`);
  };

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
  const runsDir = join(runsRoot, productRunDir());
  const knownRunIds = (existsSync(runsDir) ? readdirSync(runsDir) : []).filter((entry) => entry.startsWith("run-"));
  const swept = sweepProcesses([
    join(runsDir, "run-"),
    ...knownRunIds.map((id) => `${RUN_MARKER} ${id}`),
  ]);
  const sweptDirs = sweepDirectories(runsRoot);

  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
  const vendors = usableVendors();
  // `--workers`, which is the flag `src/cli.ts` reads. This was `--max-workers`,
  // a flag the product has never had, so every run that thought it was setting
  // ruling 14's desirability filter was silently getting the default of 3.
  const workersFlag = value("workers");
  const admission = admit(plan, vendors, workersFlag === undefined ? undefined : Number(workersFlag));

  say(admission.ladderNote);
  if (admission.refused.length > 0) {
    // Ruling 11: refused BEFORE anything is spawned. Zero processes, zero clones
    // — and nothing from a committed file is ever executed to find that out.
    for (const line of admission.refused) process.stderr.write(`refused: ${line}\n`);
    return 4;
  }
  // Ruling 14's binding filter. Item 4 finds this by its SHAPE — a worker
  // count, an em dash, a reason — and classifies it by the filter it NAMES, so
  // the wording below is this fixture's own rather than the product's, which is
  // the property that makes this a control instead of an echo. It used to be
  // printed first only because item 4 read "the first line with an em dash",
  // and that regex found `admitted — <plan path>` in the real product: the
  // harness was reading a different line here than there.
  say(`admitted: ${admission.workers} worker(s) — ${admission.bindingFilter}`);
  for (const line of describeAdmission(plan, admission, planPath, vendors, capped)) say(line);
  if (flag("dry-run")) return 0;

  // `<run-root>/r/<run-id>`, the product's own composition.
  const runRoot = join(runsRoot, productRunDir(), runId);
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
  const baseRef = `refs/brigadier/${runId}/base`;
  run(["git", "update-ref", baseRef, baseCommit.out], { cwd: repo });

  const secretEnv = value("secret-env");
  const softCeiling = value("soft-ceiling") === undefined ? undefined : Number(value("soft-ceiling"));
  const hardCeiling = value("hard-ceiling") === undefined ? undefined : Number(value("hard-ceiling"));

  // Ruling 66: a RANGE, because #44 measured two identical Codex runs 15× apart.
  // IN TOKENS. `src/queue/estimate.ts` refuses to convert to currency for want
  // of a measured per-model rate, and a fixture quoting dollars was contradicting
  // the product's own contract in the field item 13 reads first.
  const estimateLow = plan.items.length * naiveItemTokens() * SPREAD_LOW;
  const estimateHigh = plan.items.length * naiveItemTokens() * SPREAD_HIGH;
  say(
    `estimate ${estimateLow.toLocaleString("en-US")} – ${estimateHigh.toLocaleString("en-US")} tokens ` +
      `(provenance: ${MEASURED_ITEM_BYTES} bytes of agent→client traffic per item (#14), read as tokens at ` +
      `chars/${CHARS_PER_TOKEN} with #23's measured +22% correction, widened to ${SPREAD_LOW}–${SPREAD_HIGH}× because ` +
      "#44 measured 15× between two identical runs; published tooling puts real cost at 3–5× naive estimates)",
  );
  say(
    "  the unit is tokens rather than money: converting to currency needs a per-model rate and this build has " +
      "never measured one, so a dollar figure would be exactly the false precision ruling 70 is about.",
  );
  if (flag("estimate")) {
    rmSync(runRoot, { recursive: true, force: true });
    run(["git", "update-ref", "-d", baseRef], { cwd: repo });
    return 0;
  }

  // The product identifies an item by its 1-BASED ORDINAL, not by the plan's
  // string id: the ordinal names the clone directory, the run marker and the
  // item ref, and the id is only the operator's handle. The fixture has to hold
  // the same contract, because an item asserting on the ordinal against a
  // fixture that never published one would be measuring the fixture.
  const numberOf = new Map(plan.items.map((planned, index) => [planned.id, index + 1]));
  const itemRefOf = (id: string): string => `refs/brigadier/${runId}/item/${numberOf.get(id) ?? 0}`;
  /** Every field the record owes for an item, whether or not it was dispatched. */
  const identity = (id: string): Pick<RecordItem, "id" | "number" | "itemRef"> => ({
    id,
    number: numberOf.get(id) ?? 0,
    itemRef: itemRefOf(id),
  });

  // Ruling 51's deliverable, named before the first wave because wave 2's base
  // IS the branch wave 1 published.
  const integrationRefName = `refs/heads/brigadier/${runId}`;

  const records: RecordItem[] = [];
  // Every frame this run exchanges, written through the sink at the end.
  // `src/queue/execute.ts` keeps exactly this array for exactly this reason.
  const transcriptLines: string[] = [];
  const grantedValue = secretEnv === undefined ? undefined : process.env[secretEnv];
  const integrated: Array<{ id: string; sha: string }> = [];
  let spend = 0;
  let softHit = false;
  let hardHit = false;
  let refusedDelegations = 0;
  const allCaught: string[] = [];

  // ────────────────── THE APPENDED RECORD (ruling 70) ──────────────────
  //
  // NDJSON beside the JSON one, appended and never rewritten, because the two
  // behave completely differently under the failure they exist for: a single
  // JSON document truncated by a kill is unparseable IN ITS ENTIRETY, and an
  // NDJSON file loses its last line and keeps every earlier one.
  //
  // It is also the only artifact that can answer a question about ORDER, which
  // is what ruling 52's write-ahead is: a blocking check's slot is opened
  // holding `not-run` BEFORE the check runs, so a crash leaves a BLOCKING value
  // on disk rather than an absent field. The JSON record written at the end
  // holds the settled value either way and cannot distinguish the two.
  const ndjsonPath = join(runRoot, "record.ndjson");
  const event = (payload: Record<string, unknown>): void => {
    // `JSON.stringify` escapes every newline inside a string, so one event is
    // always one line and the only partial line a reader can see is the last.
    appendFileSync(ndjsonPath, `${JSON.stringify({ at: Date.now(), ...payload })}\n`);
  };
  event({ type: "run-started", runId, repo, runRoot, pid: process.pid });
  // Ruling 63's fourth fact, written down as well as printed. The sweep ran
  // before this directory existed, so the event is emitted here — the ORDER of
  // the actions is unchanged, and a sweep whose pids reached neither the report
  // nor the record is a sweep an operator cannot act on.
  event({
    type: "swept",
    sweptBy: "start",
    runId,
    item: null,
    reclaimedPids: swept.map((row) => row.pid),
    survivors: [],
  });
  event({ type: "base-recorded", wave: 0, ref: baseRef, sha: baseCommit.out });

  // ──────────────────── RULING 66'S COUNTER ────────────────────
  //
  // In TOKENS, over the bytes that really crossed the wire — the prompt sent and
  // every line answered — which is the traffic #14 measured. Not a constant per
  // item: a constant cannot be crossed part-way through an item, and an item
  // that can only be charged for after it finishes cannot be cancelled while it
  // runs, which is the entire difference between the two ceilings.
  const inFlight = new Set<{ kill(signal?: string | number): void }>();
  const chargeOnly = (text: string): void => {
    spend += tokensOf(text);
  };
  /** Charge, and say whether that crossed the HARD ceiling. Kills siblings too. */
  const chargeAndCancel = (text: string): boolean => {
    chargeOnly(text);
    if (hardCeiling === undefined || spend < hardCeiling) return false;
    if (!hardHit) {
      hardHit = true;
      // SAID AS IT HAPPENS, ON STDERR, NAMING THE WORKERS THIS LINE IS ABOUT.
      //
      // `src/queue/execute.ts:1235` writes exactly this as the ceiling fires,
      // and this fixture was killing the same set in silence — so item 13's
      // "the hard ceiling cancelled work already running, and says so" was
      // being asked of a run that did the cancelling and never said it. The
      // count is `inFlight.size` READ HERE, before the kills, because the one
      // fact an operator needs is how many live workers were stopped, and a
      // number computed anywhere else is a number about a different moment.
      process.stderr.write(
        `HARD CEILING — ${(hardCeiling ?? 0).toLocaleString("en-US")} tokens reached. ` +
          `\`session/cancel\` sent to ${inFlight.size} live worker(s) and each is killed immediately: ` +
          "ruling 66's hard ceiling cancels work already running, and `session/cancel` is an " +
          "unacknowledged notification, so the kill is the mechanism and the cancel is the courtesy.\n",
      );
      // Ruling 66: the hard ceiling cancels work ALREADY RUNNING. A sibling in
      // the same batch is exactly that, and it does not find out on its own.
      for (const child of inFlight) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    return true;
  };

  const waves: PlanItem[][] = [
    plan.items.filter((i) => (i.dependsOn ?? []).length === 0),
    plan.items.filter((i) => (i.dependsOn ?? []).length > 0),
  ];

  /** One item, cloned and ready to be driven. Built before the batch is dispatched. */
  interface Prepared {
    item: PlanItem;
    number: number;
    clone: string;
    builder: string;
    itemBaseRef: string;
    itemBaseSha: string;
    headBefore: string;
    workerEnv: Record<string, string>;
  }

  let integrationTip = baseCommit.out;
  let assigned = 0;
  for (const wave of waves) {
    const eligible = admission.workers === 0 ? [] : wave;
    const width = Math.max(1, admission.workers);
    // ──────────────────────── BATCHES, NOT ONE AT A TIME ────────────────────
    //
    // Ruling 14's fan-out is what makes ruling 66's two ceilings tell apart at
    // all, and this fixture ran strictly sequentially for fifteen rounds. With
    // one item in flight the soft ceiling always stops dispatch before the hard
    // one is reached, so the hard ceiling could never cancel anything and its
    // half of ruling 66 was unobservable against the control that is supposed to
    // prove it observable. Item 13 calibrates both ceilings from an uncapped
    // run's own spend; the arithmetic only separates them when several workers
    // are charging the same counter at once.
    for (let cursor = 0; cursor < eligible.length; cursor += width) {
      const batch = eligible.slice(cursor, cursor + width);
      const prepared: Prepared[] = [];

      for (const item of batch) {
        const number = numberOf.get(item.id) ?? 0;
        // Ruling 66, in the order the two ceilings settle: the hard one cancels,
        // the soft one declines to dispatch anything further.
        if (hardHit || (hardCeiling !== undefined && spend >= hardCeiling)) {
          hardHit = true;
          records.push({ ...identity(item.id), status: "cancelled" });
          continue;
        }
        if (softCeiling !== undefined && spend >= softCeiling) {
          softHit = true;
          records.push({ ...identity(item.id), status: "unrun" });
          continue;
        }
        // Ruling 54: wave 2 clones from wave 1's integration commit, so an item
        // whose prerequisite did not integrate is UNRUN rather than run.
        const unmetPrerequisite = (item.dependsOn ?? []).find((id) => !integrated.some((i) => i.id === id));
        if (unmetPrerequisite !== undefined) {
          records.push({ ...identity(item.id), status: "unrun" });
          continue;
        }

        const builder = vendors[assigned % Math.max(vendors.length, 1)] ?? vendors[0];
        assigned += 1;
        if (builder === undefined) {
          records.push({ ...identity(item.id), status: "failed" });
          continue;
        }

        // The LEFT-HAND SIDE of this item's ownership diff, recorded per item
        // because ruling 54 gives wave 2 a different base from wave 1: the
        // integration commit wave 1 published. Without it `git diff
        // <base>..<itemRef>` cannot be recomputed from the record by anyone.
        const wave2 = (item.dependsOn ?? []).length > 0;
        const itemBaseRef = wave2 ? integrationRefName : baseRef;
        const itemBaseSha = wave2 ? integrationTip : baseCommit.out;

        const clone = join(runRoot, String(number));
        run(["git", "clone", "--local", "--quiet", repo, clone], { cwd: runRoot });
        run(["git", "fetch", "--quiet", "origin", `${baseRef}:refs/heads/bar-base`], { cwd: clone });
        if (wave2) {
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
        event({ type: "clone-recorded", item: number, dir: clone });
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
        prepared.push({ item, number, clone, builder, itemBaseRef, itemBaseSha, headBefore, workerEnv });
      }

      // ---- the batch, driven CONCURRENTLY --------------------------------
      const driven = await Promise.all(
        prepared.map(async (p) => {
          let commitNow = false;
          // Ruling 52's write-ahead: the slot is opened holding `not-run` before
          // anything is spawned, so a crash here leaves a blocking value.
          event({ type: "check-slot", item: p.number, check: "worker exited 0", outcome: "not-run" });
          if (p.item.verify !== undefined) {
            event({ type: "check-slot", item: p.number, check: "tests_pass", outcome: "not-run" });
          }
          if (flag("review")) {
            event({ type: "check-slot", item: p.number, check: "review", outcome: "not-run" });
          }
          const outcome = await driveWorker({
            vendor: p.builder,
            brief: {
              itemId: p.item.id,
              clone: p.clone,
              role: "builder",
              ...(p.item.directive ? { directive: p.item.directive as Directive } : {}),
              ...(secretEnv !== undefined ? { secretEnv } : {}),
            },
            briefPath: join(runRoot, `${p.item.id}.brief.json`),
            clone: p.clone,
            runId,
            item: p.number,
            label: p.item.id,
            // The prompt as the plan wrote it — `writePlan` already folded the
            // directive in, so this is the text a real agent would receive.
            promptText: p.item.prompt,
            transcript: transcriptLines,
            secret: grantedValue,
            readOnly: p.item.kind === "read-only",
            answerFile: join(runRoot, `${p.item.id}.answer`),
            env: p.workerEnv,
            charge: chargeAndCancel,
            inFlight,
            onCommitNow: () => {
              // The worker says its work is done and then hangs on purpose. Commit
              // NOW, so an interrupt a moment later finds a clone holding real work
              // — which is precisely the state ruling 63 says must be retained.
              commitNow = true;
              safeGit(p.clone, emptyHooks, ["add", "-A"], runRoot);
              safeGit(p.clone, emptyHooks, ["commit", "--no-verify", "-q", "-m", `${p.item.id}: work`], runRoot);
            },
          });
          // A worker whose SIBLING crossed the hard ceiling was killed by that
          // crossing rather than by its own charge, and it must not be reported
          // as a worker that failed on its merits.
          const cancelled = outcome.cancelled === true || (hardHit && outcome.code !== 0);
          return { p, outcome, commitNow, cancelled };
        }),
      );

      // ---- settled SEQUENTIALLY, in plan order ---------------------------
      //
      // The merge chain is linear by construction: `merge-tree` takes the
      // integration tip as its left-hand side, and two concurrent settlements
      // would each take the same tip and lose one of the two results.
      for (const { p, outcome, commitNow, cancelled } of driven) {
        const { item, clone, builder, itemBaseRef, itemBaseSha, headBefore, number } = p;
        if (cancelled) {
          // Ruling 66's hard ceiling: work already running, stopped where it
          // stood. A different status and a different verb from `unrun`.
          records.push({ ...identity(item.id), status: "cancelled", agent: builder, baseRef: itemBaseRef, baseSha: itemBaseSha });
          event({ type: "check-settled", item: number, check: "worker exited 0", outcome: "not-run", detail: "cancelled by the hard ceiling" });
          continue;
        }
        event({
          type: "check-settled",
          item: number,
          check: "worker exited 0",
          outcome: outcome.code === 0 ? "pass" : "fail",
          detail: null,
        });
        // `startsWith`, not equality: the fixture now names the outcome AND the
        // exit code it saw, so an equality check would silently stop counting.
        if (outcome.lines.some((l) => l.startsWith("DELEGATION-REFUSED"))) refusedDelegations += 1;

        // Ruling 49: a read-only item's directory is NEVER read back, so nothing
        // it wrote can reach the branch or any report. Not "the agent could not
        // write" — three of five measured vendors give no lane at all.
        if (item.kind === "read-only") {
          records.push({
            ...identity(item.id),
            status: "integrated",
            kind: "read-only",
            agent: builder,
            builderAgent: builder,
            model: `${builder}-m`,
            ...effortFields("read-only", item.difficulty),
            attempts: 1,
            attemptsAvailable: vendors.length >= 2 ? 2 : 1,
            baseRef: itemBaseRef,
            baseSha: itemBaseSha,
            checks: [{ name: "worker exited 0", outcome: outcome.code === 0 ? "pass" : "fail", blocking: true }],
          } as RecordItem);
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
          records.push({
            ...identity(item.id),
            status: "failed",
            agent: builder,
            builderAgent: builder,
            model: `${builder}-m`,
            ...effortFields("write", item.difficulty),
            baseRef: itemBaseRef,
            baseSha: itemBaseSha,
            checks: [{ name: "worker exited 0", outcome: outcome.code === 0 ? "pass" : "fail", blocking: true }],
          } as RecordItem);
          continue;
        }

        // Ruling 52: the verify command was already resolved on PATH at admission,
        // so a failure here is the CHECK failing rather than the checker missing.
        // Its own last lines travel with it: `src/gate/run.ts` carries
        // `VERIFY_TAIL_LINES` of the checker's output into the failing check, and
        // a check that says only `fail` sends its reader back to a terminal that
        // has already scrolled.
        let verifyFailed = false;
        let verifyDetail: string | undefined;
        if (item.verify !== undefined) {
          const parts = item.verify.trim().split(/\s+/);
          const ran = run(parts, { cwd: clone });
          verifyFailed = !ran.ok;
          const tail = `${ran.out}\n${ran.err}`.trim().split("\n").slice(-VERIFY_TAIL_LINES).join("\n");
          if (verifyFailed && tail.length > 0) verifyDetail = tail;
          event({
            type: "check-settled",
            item: number,
            check: "tests_pass",
            outcome: verifyFailed ? "fail" : "pass",
            detail: verifyDetail ?? null,
          });
        }

        // Ruling 32: the reviewer's vendor differs from the builder's where it can,
        // and a weakened check is stated rather than rendered as a pass.
        const reviewer = vendors.find((v) => v !== builder) ?? builder;
        // Ruling 52's INITIAL_OUTCOME. Never reaches the record — `reviewVerdict`
        // and the `review` check are both spread in only under `flag("review")`,
        // by which point this has been overwritten — but the placeholder is the
        // blocking write-ahead value rather than a word the product cannot emit.
        let verdict: RecordItem["reviewVerdict"] = "not-run";
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
            item: number,
            label: `${item.id} review`,
            // THE frame that carries a granted secret in this fixture: the diff of
            // what the worker committed. Ruling 52's brief, and the only thing
            // here that gives ruling 65's sink anything to do.
            promptText: `review the diff below and answer with a VERDICT line.\n${diff}`,
            transcript: transcriptLines,
            secret: grantedValue,
            readOnly: true,
            answerFile: join(runRoot, `${item.id}.review.answer`),
            env: p.workerEnv,
            // Charged, never cancelled: a reviewer stopped half-way would render
            // as `error` and block an item the ceiling had nothing to say about.
            charge: (text) => {
              chargeOnly(text);
              return false;
            },
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
          event({ type: "check-settled", item: number, check: "review", outcome: verdict, detail: null });
        }

        const record: RecordItem = {
          ...identity(item.id),
          status: verifyFailed || verdict === "error" || verdict === "fail" ? "failed" : "integrated",
          kind: "write",
          agent: builder,
          builderAgent: builder,
          ...(flag("review") ? { reviewerAgent: reviewer, reviewVerdict: verdict } : {}),
          model: `${builder}-m`,
          ...effortFields("write", item.difficulty),
          // Ruling 67: printed per item, and only ever DOWNWARD — an upgrade
          // spends money the operator did not ask for.
          ...(item.difficulty ? { difficulty: item.difficulty, clampedTo: clampDifficulty(item.difficulty) } : {}),
          attempts: 1,
          attemptsAvailable: vendors.length >= 2 ? 2 : 1,
          commit: head.out,
          baseRef: itemBaseRef,
          baseSha: itemBaseSha,
          checks: [
            { name: "worker exited 0", outcome: outcome.code === 0 ? "pass" : "fail", blocking: true },
            ...(item.verify !== undefined
              ? [
                  {
                    name: "tests_pass",
                    outcome: verifyFailed ? ("fail" as const) : ("pass" as const),
                    blocking: true,
                    ...(verifyDetail === undefined ? {} : { detail: verifyDetail }),
                  },
                ]
              : []),
            ...(flag("review") ? [{ name: "review", outcome: verdict, blocking: true } as const] : []),
          ],
          ...(caught.length > 0 ? { caughtDefects: caught } : {}),
        } as RecordItem;
        records.push(record);
        if (record.status !== "integrated") continue;

        // Ruling 51: FETCH, never push, and no working tree on the integration side.
        run(["git", "fetch", "--quiet", clone, `HEAD:${itemRefOf(item.id)}`], { cwd: repo });
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
        event({ type: "item-landed", item: number, ref: itemRefOf(item.id), sha: head.out });
      }
    }
  }
  const integrationRef = integrationRefName;
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
  for (const entry of integrated) run(["git", "update-ref", "-d", itemRefOf(entry.id)], { cwd: repo });

  const transcripts = join(runRoot, "transcripts");
  mkdirSync(transcripts, { recursive: true });
  // ─────────────── THIS FILE IS A CONTROL, NOT FILLER ────────────────
  //
  // It used to be `"turn detail\n".repeat(30)` — a constant, carrying nothing
  // any worker ever produced. THAT LINE IS WHY AN INDEPENDENT CRITIC COULD
  // DELETE RULING 65'S REDACTION SINK ENTIRELY AND BAR ITEM 12 STILL PASSED:
  // with no granted value anywhere in this file, redacting it and not redacting
  // it produce byte-identical output, so the fixture could not fail the check it
  // is a fixture to. The item was not the only thing at fault; nothing here
  // could have detected the deletion.
  //
  // So the transcript now carries the REAL frames — the prompt brigadier sent
  // and every line the worker answered — in `src/queue/execute.ts`'s own format,
  // and the reviewer's prompt carries the diff of what the worker committed.
  // That is the one place a granted secret enters this fixture's writing path,
  // which is what makes `redact` below load-bearing and its deletion detectable.
  //
  // Two readers depend on this and both would go quiet if it became a constant
  // again: `bar/lib/item5-verifier-transcript.ts` parses `<itemId> review in
  // <frame>`, and `bar/items/12-secret-not-persisted.ts` asserts the sink's
  // placeholder stands here where the raw value would otherwise be. Do not
  // "simplify" it back.
  const transcriptBody = `${transcriptLines.join("\n")}\n`;

  const quota: Record<string, "read" | "unreadable" | "unpriceable"> = {};
  for (const vendor of vendors) {
    // #42 measured opencode reaching a model with NO credential at all through
    // its own gateway, so a successful turn proves nothing about the account.
    quota[vendor] = vendor === "opencode" ? "unpriceable" : "read";
  }

  // Ruling 51: THE NAME IS NOT THE THING. `integrationSha` is what
  // `git rev-parse` answers, and its absence is the machine-readable form of
  // "this run published nothing" — so it is written only when the branch was
  // really updated. `runChecks` carries the run-level fact that follows from it.
  const publishedSha = integrated.length > 0 ? integrationTip : undefined;
  const record: RunRecord = {
    runId,
    integrationRef,
    ...(publishedSha === undefined ? {} : { integrationSha: publishedSha }),
    // Ruling 50's scratch base, so `git diff <base>..<itemRef>` stays
    // re-derivable from the record after the ref itself is cleaned up.
    base: { ref: baseRef, sha: baseCommit.out },
    runChecks: [
      publishedSha === undefined
        ? { name: "the deliverable branch exists", outcome: "fail", blocking: true }
        : { name: "the deliverable branch exists", outcome: "pass", blocking: true },
    ],
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
      // TOKENS, and it is a REFUSAL. `src/queue/estimate.ts` types its own
      // estimate's unit as the literal `"tokens"` and states in its header that
      // converting to currency needs a per-model rate this repository has never
      // measured — so a fixture recording `USD` was not a rounding error, it was
      // the positive control asserting the opposite of the product's contract in
      // the first field item 13 reads.
      currency: "tokens",
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
  // Ruling 65: ONE sink. `redactGranted` is module-level so that `driveWorker`
  // writes through the same redactor this does — a second copy is a second
  // place to forget, which is v1's failure 1 in miniature.
  const redact = (text: string): string => redactGranted(text, grantedValue);
  writeFileSync(recordPath, redact(JSON.stringify(record, null, 2)));
  writeFileSync(join(transcripts, "full.log"), redact(transcriptBody));
  event({ type: "run-finished", outcome: "complete" });
  writeFileSync(join(runRoot, "complete"), "");
  // Ruling 63: directories only for COMPLETE runs. This run completed, so its
  // clones go now rather than lingering until someone happens to start again —
  // a clone left behind is a checkout of the operator's tree sitting on disk.
  // The record and the transcripts stay: item 11 requires the full record to be
  // there, and a report that names a path nothing is at is a report that lies.
  for (const clone of cloneDirsUnder(runsRoot)) {
    if (clone.runId === runId) rmSync(clone.path, { recursive: true, force: true });
  }

  // ───────────────────────────── THE REPORT ─────────────────────────────
  //
  // ONE BLOCK PER ITEM: the head line the operator reads, and that item's CHECKS
  // indented beneath it. Ruling 52's rule is that a cap prints fewer ITEMS and
  // never fewer CHECKS, and a one-line-per-item rendering has nowhere to keep a
  // check — so this fixture printed a comma-joined list of the names of failing
  // checks and nothing at all for a passing one, and `bar/lib/item11-structure.ts`
  // could not find a single check where ruling 52 says it must be.
  //
  // The triple is rendered as `(agent, model, effort)` because ruling 29 makes
  // the routing unit a triple and item 13 reads it as one; the clamp is on the
  // same line because ruling 67 exists to stop a silent downgrade, and a
  // downgrade recorded in a file nobody opens is silent.
  const blocks: ItemBlock[] = records.map((r) => {
    const triple = `(${r.agent ?? "none"}, ${r.model ?? "none"}, ${String(r.effort ?? "none")})`;
    const clamp = r.difficulty === undefined ? "" : `, difficulty: ${r.difficulty} (clamped to ${r.clampedTo})`;
    const rungs =
      r.attempts === undefined
        ? ""
        : `, attempts ${r.attempts} of ${r.attemptsAvailable}${(r.attemptsAvailable ?? 0) < 2 ? " — no second rung" : " (second rung available)"}`;
    const lines = [`${r.id}: ${r.status} ${triple}${clamp}${rungs}`];
    for (const check of r.checks ?? []) {
      // Ruling 52: the qualifier lives INSIDE the rendered result, never in a
      // footnote — `review: pass (same-vendor)`.
      lines.push(`  ${check.name}: ${check.outcome}${check.qualifier === undefined ? "" : ` (${check.qualifier})`}`);
      // The checker's own last words, and only where they are the remedy. A
      // failing check that says `fail` and nothing else sends its reader back to
      // a terminal that has already scrolled.
      if (check.detail !== undefined && check.outcome !== "pass") {
        for (const line of check.detail.split("\n")) lines.push(`      ${line}`);
      }
    }
    return { blocking: r.status !== "integrated", text: lines.join("\n") };
  });

  const tail: string[] = [`${admission.workers} worker(s) — ${admission.bindingFilter}`];
  if (record.review) {
    tail.push(
      record.review.crossVendor
        ? "review ran cross-vendor"
        : `review ran same-vendor — ${record.review.sameVendorReason}`,
    );
    tail.push(`catch rate ${record.review.caught} of ${record.review.planted} (v1's baseline was 0 of 3)`);
  }
  if (refusedDelegations > 0) {
    tail.push(
      `${refusedDelegations} worker(s) attempted to delegate to brigadier and were refused — check the repository's AGENTS.md and the brief.`,
    );
  }
  tail.push("ambient instruction files were suppressed for every worker");
  tail.push(
    `actual ${spend.toLocaleString("en-US")} tokens against predicted ${estimateLow.toLocaleString("en-US")} – ` +
      `${estimateHigh.toLocaleString("en-US")}` +
      `${record.cost?.lowerBound ? " (a LOWER BOUND: a vendor in this run is unpriceable)" : ""}`,
  );
  // ONLY WHEN A CEILING WAS GIVEN, which is item 13's negative control and not a
  // tidy-up: a ceiling line printed on every run is wallpaper, and an operator
  // stops reading it at exactly the point it starts being true.
  if (softCeiling !== undefined || hardCeiling !== undefined) {
    if (hardHit) {
      tail.push(
        `HARD CEILING FIRED at ${(hardCeiling ?? 0).toLocaleString("en-US")} tokens — work already running was CANCELLED where it stood`,
      );
    }
    if (softHit) {
      tail.push(
        `soft ceiling reached at ${(softCeiling ?? 0).toLocaleString("en-US")} tokens — no further items were dispatched; work in flight was left to finish`,
      );
    }
    if (!hardHit && !softHit) {
      tail.push(
        `ceilings — soft ${softCeiling === undefined ? "not set" : "not reached"}, hard ${hardCeiling === undefined ? "not set" : "not reached"}`,
      );
    }
    // RULING 66'S ORDERING, and only beside a ceiling that ACTED.
    //
    // `src/report/run-report.ts:539` prints this and this fixture did not, so a
    // run that fired a ceiling left the operator free to read the ESTIMATE as
    // the thing that stopped it. #44 measured 427,723 against 28,245 bytes on
    // two identical runs, which is why no prediction may be the control. Guarded
    // by `hardHit || softHit` for the same reason the block above is guarded: a
    // sentence printed on every run is wallpaper by the time it is true.
    if (hardHit || softHit) {
      tail.push(
        "the ceiling is the primary control and the estimate is not: #44 measured 427,723 against " +
          "28,245 bytes on two identical runs, so no prediction is load-bearing enough to be the thing " +
          "that stops a run. The number above was measured as this run happened.",
      );
    }
  }
  for (const [vendor, state] of Object.entries(quota)) tail.push(`quota — ${vendor}: ${state}`);
  for (const lever of record.cost?.levers ?? []) tail.push(`  lever active: ${lever}`);
  tail.push(
    "brigadier makes no claim to have saved anything: those are levers that were active, not a measurement of " +
      "what this run would otherwise have cost (ruling 70).",
  );
  for (const retained of sweptDirs.retained) {
    tail.push(`retained (interrupted, has committed work, not merged and not deleted): ${retained}`);
  }
  tail.push(`transcripts: ${transcripts}`);
  tail.push(`run-record: ${recordPath}`);

  // Ruling 63's fourth fact, in the words `src/run/sweep.ts` prints it: the
  // EXACT PIDS, one line each, because a sweep that kills silently is
  // indistinguishable from a sweep that found nothing and the pid is the only
  // remedy an operator can act on. This fixture printed `sweep reclaimed 1
  // process(es)` for nine rounds and item 7 read its own `stat` instead of the
  // product's output, so neither half could see the other's silence.
  //
  // AS DETAIL, which is dropped for a host session — `src/report/budget.ts`
  // drops `detail` under `host-session` and the run record carries the same
  // pids in its `swept` event either way, which is why item 7 asks for the
  // uncapped report AND reads the record.
  const detail: string[] = [];
  if (swept.length > 0 || sweptDirs.removed.length > 0) {
    detail.push(
      `sweep ${runId} (start): ${swept.length} process(es) reclaimed, 0 unconfirmed; ` +
        `${sweptDirs.removed.length} directory(ies) removed`,
    );
    for (const row of swept) detail.push(`  reclaimed pid ${row.pid} (item 0): ${row.commandLine}`);
    detail.push(
      "  completeness: partial — an empty survivor list is not proof the sweep found everything",
    );
  }

  for (const line of composeReport(blocks, [], [...tail, ...(capped ? [] : detail)], capped, spentOnStdout)) {
    process.stdout.write(`${line}\n`);
  }

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
