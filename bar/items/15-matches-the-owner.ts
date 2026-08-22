// SPDX-License-Identifier: Apache-2.0
/**
 * Item 15 — The product matches what the owner asked for.
 *
 * Ruling 82, from D23. **This is the only item in the harness that does not ask
 * *does the code match the rulings*.** Every other one does, and that is exactly
 * how ruling 20 survived: locked on day one, filed in the coverage table as
 * *architectural exclusion — no user-visible promise*, and left to decide for
 * five days whether the product could think while nothing looked at it again.
 * Fourteen items, two independent verifiers and 1,771 local tests verified a
 * specification faithfully and had no organ for noticing it was the wrong one.
 *
 * **IT GRADES NO PROSE, and that is the design rather than a limitation.**
 * `PRODUCT.md` section 1 makes six mechanically checkable claims; this is six
 * assertions against the compiled binary. A judgement about whether the product
 * *feels* like section 1 would be an assertion whose author is also its subject,
 * and it would drift the first time anybody reworded the page.
 *
 * **WHAT THIS ITEM CANNOT PROVE, which its own output has to keep saying:** six
 * mechanical assertions cannot catch a divergence in the unmechanical half of
 * section 1. It is therefore blind to precisely the class of failure that let
 * ruling 20 through — a *judgement* about whether a promise was user-visible,
 * not a broken assertion. **This narrows the gap; it does not close it.**
 *
 * WHY ASSERTION 5 IS NOT WRITTEN HERE. Section 1 requires the operator's
 * repository to be byte-identical after a run, and item 4 already asserts that
 * against a real fan-out with a full capture — HEAD, `status --porcelain -uall`,
 * refs, the `.git/index` hash and a whole-tree hash. Restating it here would be
 * a second copy of one assertion, which is a second thing to drift; ruling 82
 * says *"reused rather than restated"* and this file cites rather than copies.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { probeFeature } from "../lib/feature.ts";
import { ensureDir } from "../lib/fs.ts";
import { combine, type LiveHalf } from "../lib/halves.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/**
 * Exit 6 is what a run that stopped to ask returns.
 *
 * Transcribed rather than imported — nothing under `bar/` imports from `src/`,
 * because a harness built out of the product's own constants shares the
 * product's bugs and cannot detect them.
 */
const EXIT_ASKED = 6;

const item: BarItem = {
  id: 15,
  title: "The product matches what the owner asked for",
  rulings: [82, 74, 75, 76, 77, 78, 85],
  // The goal path spends a metered planning turn, so the assertions that need a
  // real plan are live. Four of the six do not need one and run everywhere.
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];
    const checks = new Checks();

    // A HOME nothing has touched. Assertion 1's whole subject is what setup
    // does on a machine that has never run brigadier, and a warm HOME would
    // measure the second run while claiming to measure the first.
    const home = join(ctx.workdir, "fresh-home");
    const runs = join(ctx.workdir, "runs");
    const repo = join(ctx.workdir, "repo");
    for (const dir of [home, runs, repo]) ensureDir(dir);
    const env = baseEnv({ HOME: home, PATH: process.env["PATH"] ?? "" });

    // ---- assertion 1: setup runs clean on a fresh HOME, and detect agrees ---
    const setup = await probeFeature(ctx, ["setup", "--home", home, "--run-root", runs], {
      env,
      timeoutMs: 120_000,
      // `probeFeature`'s default treats output that LOOKS like usage as the
      // feature being absent, and setup's own text names other subcommands. So
      // the evidence is positive and specific: it exited 0 and printed the
      // fleet line only a real setup produces.
      evidence: (result) => result.code === 0 && /\bagents\s+\d+\/\d+ usable\b/.test(result.stdout),
    });
    did.push(`setup on a fresh HOME: ${setup.transcript}`);
    checks.expect(
      "`brigadier setup` exists and completes on a HOME that has never seen brigadier",
      setup.present,
      setup.transcript,
    );

    const detect = await probeFeature(ctx, ["detect", "--run-root", runs, "--json"], { env, timeoutMs: 120_000 });
    did.push(`detect after setup: exit ${detect.result.code}`);
    // AGREEMENT IS ASSERTED ON THE VENDOR NAMES, not on a substring of the
    // whole output: `expect(out.includes(id))` would pass on any binary that
    // happened to print the fleet twice for unrelated reasons.
    const setupAgents = agentsIn(setup.result.stdout);
    const detectAgents = detectedIn(detect.result.stdout);
    checks.expect(
      "`brigadier detect` reports the same usable fleet setup printed",
      setup.present && detect.present && sameSet(setupAgents, detectAgents),
      `setup named [${[...setupAgents].join(", ") || "none"}]; detect named [${[...detectAgents].join(", ") || "none"}]`,
    );

    // ---- assertion 2: a session engages brigadier without being named -------
    //
    // The MECHANISM is asserted, not a model's behaviour: whether a given model
    // acts on injected text is a property of that model on that day, and an item
    // that graded it would be measuring the vendor. What the artifact owes is
    // that the hook is registered in the plugin it ships and that the launcher
    // carries the plugin into a session.
    const plugin = await probeFeature(ctx, ["plugin", "hooks", "--home", home], { env, timeoutMs: 60_000 });
    did.push(`plugin hooks: ${plugin.transcript}`);
    const hookText = `${plugin.result.stdout}${plugin.result.stderr}`;
    checks.expect(
      "the plugin the artifact ships registers `UserPromptSubmit`, so a session engages brigadier unnamed",
      plugin.present && /UserPromptSubmit/.test(hookText),
      excerpt(hookText, 300),
    );

    // THE LAUNCHER IS OBSERVED, NOT ASKED. There is no `--dry-run` on
    // `brigadier claude` and this item does not ask for one: a bar item that
    // required new product surface to grade itself would be designing the
    // product around the harness. Instead a fake `claude` is planted on `PATH`
    // and dumps the argv it was handed — the same technique that measured the
    // ambient lever, and black-box by construction.
    const fakeBin = join(ctx.workdir, "fake-bin");
    const argvDump = join(ctx.workdir, "claude-argv.txt");
    plantArgvDump(fakeBin, argvDump);
    const launch = await ctx.run(["claude", "--version"], {
      env: { ...env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` },
      timeoutMs: 60_000,
    });
    const argv = existsSync(argvDump) ? readFileSync(argvDump, "utf8") : "";
    did.push(`launcher argv: exit ${launch.code}; handed the vendor ${excerpt(argv.replace(/\n/g, " "), 200)}`);
    checks.expect(
      "`brigadier claude` execs the real vendor with the plugin injected FOR THAT SESSION",
      /--plugin-dir/.test(argv) && /--append-system-prompt-file/.test(argv),
      argv === "" ? `the vendor was never reached; exit ${launch.code}: ${excerpt(launch.stderr, 200)}` : excerpt(argv.replace(/\n/g, " "), 300),
    );
    checks.expect(
      "it APPENDS to the vendor's system prompt rather than replacing it, and the operator's own argv survives",
      /--append-system-prompt-file/.test(argv) && !/--system-prompt-file/.test(argv.replace(/--append-system-prompt-file/g, "")) && /--version/.test(argv),
      excerpt(argv.replace(/\n/g, " "), 300),
    );

    // ---- assertion 6: a question round-trips through exit-and-resume --------
    //
    // CREDENTIAL-FREE, deliberately. A run that stops to ask stops BEFORE it
    // spends — that is ruling 85's whole point — so this assertion needs no
    // vendor at all, and putting it in the live half would have made the one
    // property D13 exists for unmeasurable on CI.
    plantRepo(repo);
    const asked = await ctx.run(
      ["run", "--goal", "fix the typo in the readme", "--repo", repo, "--run-root", runs],
      { env, timeoutMs: 180_000 },
    );
    did.push(`goal that should stop to ask: exit ${asked.code}; stdout ${excerpt(asked.stdout, 200)}`);
    checks.expect(
      "a run that needs a decision EXITS rather than waiting on a terminal it does not have",
      asked.code === EXIT_ASKED,
      `exit ${asked.code} (expected ${EXIT_ASKED}); stdout: ${excerpt(asked.stdout, 200)}`,
    );

    const pending = pendingRuns(runs);
    checks.expect(
      "it wrote what a resume needs: the goal, the repository, and the state D15 compares against",
      pending.length > 0 &&
        typeof pending[0]?.record["goal"] === "string" &&
        typeof pending[0]?.record["repo"] === "string" &&
        typeof pending[0]?.record["head"] === "string" &&
        Array.isArray(pending[0]?.record["agents"]),
      pending.length === 0 ? "no pending.json anywhere under the run root" : excerpt(JSON.stringify(pending[0]?.record), 300),
    );

    const runId = pending[0]?.runId ?? "";
    // `--repo` is deliberately ABSENT: the answer comes back from a session, out
    // of an unknown working directory, and a resume that needed to be told the
    // repository again would not be a round trip.
    const resumed = await ctx.run(["resume", runId, "--answer", "no", "--run-root", runs], {
      env,
      timeoutMs: 120_000,
    });
    did.push(`resume ${runId} --answer no: exit ${resumed.code}`);
    checks.expect(
      "`brigadier resume --answer` continues it without being told the repository again",
      runId !== "" && resumed.code === 0,
      `exit ${resumed.code}; stdout: ${excerpt(resumed.stdout, 200)}; stderr: ${excerpt(resumed.stderr, 200)}`,
    );
    checks.expect(
      "the answered question is gone, so it cannot be answered twice with two different answers",
      runId !== "" && !existsSync(join(runs, "r", runId, "pending.json")),
      `pending.json ${existsSync(join(runs, "r", runId, "pending.json")) ? "still present" : "removed"}`,
    );

    // ---- assertion 5: cited, not restated ----------------------------------
    checks.note(
      "the operator's repository is byte-identical afterwards",
      "asserted by ITEM 4 against a real fan-out, with HEAD, `git status --porcelain -uall`, refs, the `.git/index` " +
        "hash and a whole-tree hash captured either side. Reused rather than restated (ruling 82): a second copy of " +
        "an assertion is a second thing to drift, and this note is here so a reader of item 15 alone does not " +
        "conclude the claim is ungraded.",
    );

    // ---- assertions 3 and 4: the live half ---------------------------------
    //
    // A planning turn is metered, so these two need `--live`. They are the two
    // that make ruling 74 real, and skipping them still BLOCKS a tag — ruling
    // 48: a SKIPPED item blocks exactly as a FAIL does.
    //
    // **THEY RUN UNDER THE OPERATOR'S OWN `HOME`, NOT THE FRESH ONE ABOVE**, and
    // the reason is measured rather than convenient. MEASURED 2026-08-22 against
    // `claude 2.1.238`: under a scratch `HOME` the vendor answers `Not logged in
    // · Please run /login` and exits 1, against a real-`HOME` control that
    // answered and exited 0 — so a planning turn there fails at
    // `session/prompt` with `-32000 Authentication required` for a reason that
    // has nothing to do with the product.
    //
    // The two halves therefore need two environments, and that is a property of
    // the item rather than a compromise: **assertion 1's subject IS a machine
    // that has never run brigadier**, and assertions 3 and 4's subject is a
    // metered turn, which needs a credential. Running either under the other's
    // environment would grade the wrong thing.
    const liveEnv = baseEnv({ PATH: process.env["PATH"] ?? "" });
    let live: LiveHalf;
    if (!ctx.live) {
      live = {
        kind: "skipped",
        why:
          "assertions 3 and 4 commission a plan from a real vendor, which spends a metered turn. The four " +
          "credential-free assertions above ran and are graded",
      };
    } else {
      const goal = await ctx.run(
        ["run", "--goal", "add a second paragraph to the readme explaining what this repository is", "--repo", repo, "--run-root", runs, "--dry-run", "--no-research"],
        // The CONSTANT, not a literal. `bar/lib/timeout-order.test.ts` fails on
        // any deadline in an item that could collide with the subject's own
        // worker deadline: a harness that kills its subject before the subject
        // can explain itself is not measuring the subject.
        { env: liveEnv, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      did.push(`goal that should plan: exit ${goal.code}; stdout ${excerpt(goal.stdout, 200)}`);
      const liveChecks = new Checks();

      const planLine = /brigadier: plan ready → (\S+)/.exec(goal.stdout);
      const planPath = planLine?.[1] ?? "";
      liveChecks.expect(
        "`run --goal \"<sentence>\"` produced a plan nobody hand-authored",
        planPath !== "" && existsSync(planPath),
        planPath === "" ? `no plan line in stdout: ${excerpt(goal.stdout, 300)}` : `plan at ${planPath}`,
      );

      const planText = planPath !== "" && existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
      liveChecks.expect(
        "the plan lives in the RUN RECORD, never in the operator's repository (D4)",
        planPath.startsWith(runs) && !planPath.startsWith(repo),
        `plan at ${planPath}; run root ${runs}; repository ${repo}`,
      );

      // ASSERTION 4, and it is the one a convenience change would spend. The
      // plan's own bytes must not be on stdout: one line naming a file is the
      // entire product surface of a plan, and a session's window is not free.
      const leaked = leakedPlan(planText, goal.stdout);
      liveChecks.expect(
        "the session output carries a PATH and not the plan",
        planText !== "" && leaked === null,
        leaked === null
          ? `stdout is ${goal.stdout.length} bytes against a ${planText.length}-byte plan, and none of the plan's own ` +
            "prompt text appears in it"
          : `stdout carries the plan's own bytes: ${excerpt(leaked, 200)}`,
      );

      live = { kind: "ran", checks: liveChecks };
    }

    const result = combine(did, checks, live);
    return {
      ...result,
      observed:
        `${result.observed}\n\nWHAT THIS ITEM CANNOT PROVE: six mechanical assertions cannot catch a divergence in ` +
        "the unmechanical half of `PRODUCT.md` section 1. It grades no prose — that is what keeps it stable — and it " +
        "is therefore blind to exactly the class of failure that let ruling 20 through, which was a JUDGEMENT about " +
        "whether a promise was user-visible rather than a broken assertion. This item narrows the gap; it does not " +
        "close it, and a PASS here is not evidence that the product matches the owner in the ways nobody wrote down.",
    };
  },
};

/**
 * Vendor ids `brigadier setup` reported as usable.
 *
 * Parsed from setup's own summary line — `agents 3/6 usable — claude, copilot,
 * opencode` — rather than from a per-vendor table setup does not print. The
 * first draft of this looked for `✓ claude … usable` rows, matched nothing, and
 * reported an empty set against a detect that named two vendors: a harness
 * defect that reads exactly like a product defect, which is why the assertion
 * prints both sides.
 */
export function agentsIn(stdout: string): Set<string> {
  const found = new Set<string>();
  const line = /\bagents\s+\d+\/\d+ usable\s+—\s+([^\n]+)/.exec(stdout);
  for (const name of line?.[1]?.split(",") ?? []) {
    const id = name.trim().toLowerCase();
    if (/^(claude|codex|copilot|qwen|opencode|gemini)$/.test(id)) found.add(id);
  }
  return found;
}

/** Vendor ids `brigadier detect --json` reported as usable. */
export function detectedIn(stdout: string): Set<string> {
  const found = new Set<string>();
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const rows = Array.isArray(parsed) ? parsed : (parsed as { detections?: unknown[] }).detections ?? [];
    for (const row of rows as Array<{ id?: string; availability?: string }>) {
      if (row.availability === "usable" && typeof row.id === "string") found.add(row.id);
    }
  } catch {
    // A binary that cannot produce JSON fails the assertion that reads this,
    // rather than throwing here and losing every other assertion in the item.
  }
  return found;
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * Does the session's stdout carry the PLAN rather than a path to it?
 *
 * Compared on the plan's own `prompt` strings rather than on its length: a plan
 * is JSON, and a naive `stdout.includes(planText)` would miss a plan that was
 * pretty-printed differently on the way out — which is exactly how an inline
 * plan would actually arrive.
 */
export function leakedPlan(planText: string, stdout: string): string | null {
  if (planText === "") return null;
  let parsed: { items?: Array<{ prompt?: string }> };
  try {
    parsed = JSON.parse(planText) as { items?: Array<{ prompt?: string }> };
  } catch {
    return stdout.includes(planText.slice(0, 200)) ? planText.slice(0, 200) : null;
  }
  for (const item of parsed.items ?? []) {
    const prompt = item.prompt ?? "";
    // A long enough slice that a coincidence is not credible, and short enough
    // that a wrapped or re-indented copy still matches.
    const probe = prompt.replace(/\s+/g, " ").trim().slice(0, 60);
    if (probe.length >= 40 && stdout.replace(/\s+/g, " ").includes(probe)) return probe;
  }
  return null;
}

/** Every pending question under a run root, newest first. */
export function pendingRuns(runRoot: string): Array<{ runId: string; record: Record<string, unknown> }> {
  const dir = join(runRoot, "r");
  if (!existsSync(dir)) return [];
  const out: Array<{ runId: string; record: Record<string, unknown> }> = [];
  for (const runId of readdirSync(dir)) {
    const path = join(dir, runId, "pending.json");
    if (!existsSync(path)) continue;
    try {
      out.push({ runId, record: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> });
    } catch {
      out.push({ runId, record: {} });
    }
  }
  return out;
}

/**
 * A fake `claude` that records the argv it was handed and exits 0.
 *
 * `--version` is what it is driven with, because a real `claude --version` also
 * exits 0 without opening a session — so the same command works against the
 * real vendor if anybody ever wants to check this by hand.
 */
function plantArgvDump(dir: string, dumpPath: string): void {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "claude");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(dumpPath)}\nexit 0\n`);
  Bun.spawnSync(["chmod", "700", script]);
}

function plantRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "hello\n");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", "."], { cwd: repo });
  Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
  Bun.spawnSync(["git", "-c", "user.name=b", "-c", "user.email=b@e.invalid", "commit", "-q", "-m", "base"], {
    cwd: repo,
  });
}

export default item;
