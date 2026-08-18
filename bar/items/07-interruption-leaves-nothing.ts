// SPDX-License-Identifier: Apache-2.0
/**
 * Item 7 — An interruption leaves nothing behind, including what escaped.
 *
 * Rulings 15, 38, 5, 63.
 *
 * The first draft of this item **could never pass**. It carried a literal
 * `checks.expect(..., false, ...)` and a hardcoded `outcome: "FAIL"` on the live
 * path, and `judgeInterrupt` — exported, unit-tested, carefully written — was
 * called by nothing. An item that cannot pass is indistinguishable from a
 * product that cannot satisfy it, which is the same class of defect as an item
 * that cannot fail.
 *
 * It is now driven for real, in this order:
 *
 *   1. start a run whose second item detaches a descendant with `setsid()` —
 *      #43 measured Bun's job object carrying `BREAKAWAY_OK` AND
 *      `SILENT_BREAKAWAY_OK`, so on Windows `cmd /c start` does the same thing
 *      and neither is hypothetical. The descendant appends to a HEARTBEAT file
 *      every 200 ms, which is what makes "still running" observable without
 *      asking anyone;
 *   2. wait until a clone exists and the first item has committed real work;
 *   3. `SIGKILL` the orchestrator — not `SIGTERM`, so no handler can tidy up;
 *   4. start again, and let ruling 38's sweep run. The heartbeat must STOP
 *      growing: a file that is still being written to is a process that is still
 *      able to act, and no report can make it otherwise;
 *   5. assert ruling 63's other direction — the clone that had COMMITTED work is
 *      still on disk, reported with its path and its bytes, not merged and not
 *      deleted. v1's finding 92 is the precedent: an external signal killed a
 *      supervisor, both workers had done real work, and it was unrecoverable;
 *   6. send two `SIGINT`s and check the WAIT STATUS, not a printed line. A
 *      second interrupt during the drain must re-raise the signal rather than
 *      exit with an invented code, so the process is genuinely
 *      signal-terminated.
 *
 * Ruling 38 promoted the sweep from crash recovery to THE containment mechanism
 * precisely because the job object is opt-out by design and brigadier cannot fix
 * it. An item that only killed a well-behaved child would pass on a product that
 * leaks every real one.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { derive, nonce } from "../lib/derive.ts";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir, listTree } from "../lib/fs.ts";
import { makeRepo, plantSeeds } from "../lib/git.ts";
import { combine, noCredentialFreeChecks, type LiveHalf } from "../lib/halves.ts";
import { isAlive } from "../lib/inflight.ts";
import { writePlan } from "../lib/plan.ts";
import { baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/**
 * The heartbeat, read four times, because the obvious two-reading version is a
 * race and it fired as one.
 *
 * A descendant ticking every 200 ms will land another tick between "read the
 * size" and "the sweep's `kill` actually arrives", so `after === before` is not
 * the property. The property is in two parts, and each needs its own pair of
 * readings: it kept writing after the orchestrator died (so something really
 * escaped), and it stopped writing after the sweep (so the sweep really reached
 * it). The second is measured across four tick intervals, which a live process
 * cannot sit through silently.
 */
export interface InterruptObservations {
  /** Size when the orchestrator was SIGKILLed. */
  heartbeatAtKill: number;
  /** Size after a settle window. Greater than `atKill` means it outlived its parent. */
  heartbeatBeforeSweep: number;
  /** First reading after the sweep. */
  heartbeatAfterSweep: number;
  /** Read again four tick intervals later. Equal means it has genuinely stopped. */
  heartbeatSettled: number;
  /**
   * The escapee's own pid, and whether it was alive at each stage.
   *
   * File sizes are a proxy and this is the fact. A descendant that quietly died
   * on its own reads exactly like a successful sweep on sizes alone — which it
   * did, and a forger with no sweep at all passed on it.
   */
  escapeePid: number;
  aliveBeforeSweep: boolean;
  aliveAfterSweep: boolean;
  /** Did the orchestrator SURVIVE the first interrupt long enough to drain? */
  survivedFirstInterrupt: boolean;
  /** Clone directories still present after the sweep, and whether each held commits. */
  survivingClones: Array<{ path: string; hadCommits: boolean; bytes: number }>;
  reportAfterSweep: string;
  /** The wait status of the second interrupt. `signal` must be set, not a code. */
  secondInterrupt: { code: number | null; signal: string | null };
}

export function judgeInterrupt(o: InterruptObservations): Checks {
  const checks = new Checks();

  // The escaped descendant, asserted on its PID and on the bytes it is or is not
  // still writing. The pid is the decisive one: a descendant that self-terminated
  // reads exactly like a successful sweep on file sizes alone.
  checks.expect(
    "a descendant really escaped and was STILL ALIVE when the sweep started",
    o.escapeePid > 0 && o.aliveBeforeSweep && o.heartbeatBeforeSweep > o.heartbeatAtKill,
    `escapee pid ${o.escapeePid || "NONE PUBLISHED"}; alive before the sweep: ${o.aliveBeforeSweep}; ` +
      `heartbeat ${o.heartbeatAtKill} -> ${o.heartbeatBeforeSweep} bytes across the settle window. ` +
      "Without this, the check below passes on a descendant that died by itself — or never existed",
  );
  checks.expect(
    "the next start's sweep reclaimed it (ruling 38)",
    !o.aliveAfterSweep && o.heartbeatSettled === o.heartbeatAfterSweep,
    `kill(${o.escapeePid}, 0) after the sweep: ${o.aliveAfterSweep ? "STILL ALIVE" : "gone"}; ` +
      `heartbeat ${o.heartbeatAfterSweep} -> ${o.heartbeatSettled} bytes four tick intervals later`,
  );
  checks.expect(
    "the orchestrator SURVIVED the first interrupt to drain (ruling 63)",
    o.survivedFirstInterrupt,
    o.survivedFirstInterrupt
      ? "still running a beat after the first SIGINT, so there was a drain for a second signal to arrive during"
      : "died on the first signal — which is indistinguishable from having no handler at all, and a binary with none satisfies the re-raise check for free",
  );
  checks.expect(
    "no clone WITHOUT committed work survives",
    o.survivingClones.filter((c) => !c.hadCommits).length === 0,
    o.survivingClones.map((c) => `${c.path} commits=${c.hadCommits} bytes=${c.bytes}`).join("; ") || "no clones remain",
  );
  // Ruling 63, pointing the other way: a retained directory is inert and holds
  // someone's only copy, so destroying it is the failure here.
  const retained = o.survivingClones.filter((c) => c.hadCommits);
  checks.expect(
    "a clone WITH committed work is retained, reported with path and bytes (ruling 63)",
    retained.length > 0 && retained.every((c) => o.reportAfterSweep.includes(c.path) && c.bytes > 0),
    `retained: ${retained.map((c) => `${c.path} (${c.bytes} bytes)`).join(", ") || "NONE — the only copy of that work was destroyed"}; ` +
      `named in the report: ${retained.every((c) => o.reportAfterSweep.includes(c.path))}`,
  );
  checks.expect(
    "a second interrupt re-raises the signal rather than inventing an exit code",
    o.secondInterrupt.signal !== null && o.secondInterrupt.code === null,
    `wait status: code ${o.secondInterrupt.code}, signal ${o.secondInterrupt.signal}`,
  );
  return checks;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function clonesUnder(runsRoot: string): Array<{ path: string; hadCommits: boolean; bytes: number }> {
  const found: Array<{ path: string; hadCommits: boolean; bytes: number }> = [];
  if (!existsSync(runsRoot)) return found;
  for (const runDir of readdirSync(runsRoot)) {
    const full = join(runsRoot, runDir, "clones");
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    for (const child of readdirSync(full)) {
      const clone = join(full, child);
      if (!existsSync(join(clone, ".git"))) continue;
      const bytes = listTree(clone).reduce((sum, rel) => sum + fileSize(join(clone, rel)), 0);
      // "Had commits" is decided by reading the object store, not by a marker.
      const head = Bun.spawnSync(["git", `--git-dir=${join(clone, ".git")}`, "rev-parse", "HEAD"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const base = Bun.spawnSync(["git", `--git-dir=${join(clone, ".git")}`, "rev-parse", "bar-base"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const headSha = new TextDecoder().decode(head.stdout).trim();
      const baseSha = new TextDecoder().decode(base.stdout).trim();
      found.push({ path: clone, hadCommits: headSha.length === 40 && headSha !== baseSha, bytes });
    }
  }
  return found;
}

const item: BarItem = {
  id: 7,
  title: "An interruption leaves nothing behind — including what escaped",
  rulings: [15, 38, 5, 63],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "codex", version: "1.4.0" },
      { id: "qwen", version: "0.21.13" },
    ]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });
    const runs = ensureDir(join(ctx.workdir, "runs"));

    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n" });
    const committerSeed = nonce("committer-seed");
    await plantSeeds(repo, [{ path: "seeds/committer.seed", value: committerSeed, placement: "committed" }]);
    const observe = ensureDir(join(ctx.workdir, "observe"));
    const heartbeat = join(observe, "heartbeat.log");
    const pidFile = join(observe, "escapee.pid");
    const keptValue = derive(committerSeed, "committer");

    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: [
        {
          id: "escaper",
          kind: "write",
          paths: ["escaper.txt"],
          prompt: "detach a long-lived descendant",
          directive: { do: "escape-process", heartbeat, pidFile },
        },
        {
          id: "committer",
          kind: "write",
          paths: ["kept.txt"],
          prompt: "do real work and then hang",
          directive: { do: "commit-then-hang", read: "seeds/committer.seed", path: "kept.txt", salt: "committer" },
        },
      ],
    });
    did.push(
      `wrote a plan at ${planPath}: one item detaches a descendant (${process.platform === "win32" ? "cmd /c start — #43 measured BREAKAWAY_OK and SILENT_BREAKAWAY_OK on Bun's job object" : "setsid()"}) ` +
        `writing a heartbeat to ${heartbeat}; the other commits real work and hangs`,
    );

    // Probe first: an artifact with no `run` cannot be interrupted.
    const probe = await probeFeature(ctx, ["run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--dry-run"], {
      env,
      timeoutMs: 60_000,
    });
    did.push(probe.transcript);

    let live: LiveHalf;
    if (!probe.present) {
      live = {
        kind: "missing",
        probe,
        promise: "there is no run to interrupt: no clone is created, no descendant escapes, and no sweep exists to reclaim one",
      };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "the descendant that must escape containment is a real agent's tool process" };
    } else {
      // 1-3. Start for real, let it get going, then SIGKILL the orchestrator.
      const victim = Bun.spawn([ctx.binary, "run", "--plan", planPath, "--repo", repo, "--run-root", runs], {
        cwd: ctx.workdir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const clones = clonesUnder(runs);
        if (fileSize(heartbeat) > 0 && clones.some((c) => c.hadCommits)) break;
        // A binary that has already exited will never create either, and waiting
        // out the full deadline for it would make this item look like a hang
        // rather than the failure it is.
        if (victim.exitCode !== null || victim.signalCode !== null) break;
        await Bun.sleep(200);
      }
      const readyClones = clonesUnder(runs);
      const wasReady = fileSize(heartbeat) > 0 && readyClones.some((c) => c.hadCommits);
      victim.kill("SIGKILL");
      await victim.exited;
      did.push(
        `SIGKILLed the orchestrator (pid ${victim.pid}) after waiting ${wasReady ? "until" : "WITHOUT reaching"} the state this item needs: ` +
          `heartbeat ${fileSize(heartbeat)} bytes, clones ${readyClones.map((c) => `${c.path.split("/").pop()}=${c.hadCommits}`).join(",") || "none"}. ` +
          (wasReady ? "" : "The kill landed too early, so the checks below are measuring a run that had not got going — a scheduling failure of this item, not of the product"),
      );

      const heartbeatAtKill = fileSize(heartbeat);
      await Bun.sleep(800); // an unreclaimed descendant keeps writing through this
      const heartbeatBeforeSweep = fileSize(heartbeat);
      const escapeePid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
      const aliveBeforeSweep = escapeePid > 0 && isAlive(escapeePid);

      // 4. The next start sweeps.
      const secondRepo = join(ctx.workdir, "repo-2");
      await makeRepo(secondRepo, { "README.md": "base\n" });
      await plantSeeds(secondRepo, [{ path: "seeds/after.seed", value: nonce("after-seed"), placement: "committed" }]);
      const secondPlanPath = writePlan(
        ctx.workdir,
        { version: 1, items: [{ id: "after", kind: "write", paths: ["after.txt"], prompt: "x", directive: { do: "derive-write", read: "seeds/after.seed", path: "after.txt", salt: "after" } }] },
        "after.json",
      );
      const sweep = await ctx.run(["run", "--plan", secondPlanPath, "--repo", secondRepo, "--run-root", runs], {
        env,
        timeoutMs: 180_000,
      });
      // Two readings, four tick intervals apart, so a live descendant cannot
      // hide in the gap between the sweep's `kill` and the measurement.
      await Bun.sleep(400);
      const heartbeatAfterSweep = fileSize(heartbeat);
      await Bun.sleep(900);
      const heartbeatSettled = fileSize(heartbeat);
      const aliveAfterSweep = escapeePid > 0 && isAlive(escapeePid);
      did.push(
        `started again; the sweep ran at start. Heartbeat: ${heartbeatAtKill} bytes at the kill, ${heartbeatBeforeSweep} before the sweep, ` +
          `${heartbeatAfterSweep} just after, ${heartbeatSettled} four tick intervals later`,
      );

      // 6. Two interrupts, and the WAIT STATUS is what is read.
      const interruptRepo = join(ctx.workdir, "repo-3");
      await makeRepo(interruptRepo, { "README.md": "base\n" });
      await plantSeeds(interruptRepo, [{ path: "seeds/hang.seed", value: nonce("hang-seed"), placement: "committed" }]);
      const interruptPlan = writePlan(
        ctx.workdir,
        {
          version: 1,
          items: [{ id: "hang", kind: "write", paths: ["hang.txt"], prompt: "x", directive: { do: "commit-then-hang", read: "seeds/hang.seed", path: "hang.txt", salt: "hang" } }],
        },
        "interrupt.json",
      );
      const interruptee = Bun.spawn([ctx.binary, "run", "--plan", interruptPlan, "--repo", interruptRepo, "--run-root", join(ctx.workdir, "runs-3")], {
        cwd: ctx.workdir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const interruptDeadline = Date.now() + 20_000;
      while (Date.now() < interruptDeadline && interruptee.exitCode === null && interruptee.signalCode === null) {
        if (clonesUnder(join(ctx.workdir, "runs-3")).some((c) => c.hadCommits)) break;
        await Bun.sleep(200);
      }
      interruptee.kill("SIGINT");
      // A binary with no handler dies here. Surviving the window is what makes
      // the re-raise below a statement about a drain rather than about nothing.
      await Bun.sleep(700);
      const survivedFirstInterrupt = interruptee.exitCode === null && interruptee.signalCode === null;
      interruptee.kill("SIGINT");
      await interruptee.exited;
      const secondInterrupt = { code: interruptee.exitCode, signal: interruptee.signalCode };
      did.push(`sent two SIGINTs to a run in flight and read the wait status: code ${secondInterrupt.code}, signal ${secondInterrupt.signal}`);

      const checks = judgeInterrupt({
        escapeePid,
        aliveBeforeSweep,
        aliveAfterSweep,
        survivedFirstInterrupt,
        heartbeatAtKill,
        heartbeatBeforeSweep,
        heartbeatAfterSweep,
        heartbeatSettled,
        survivingClones: clonesUnder(runs),
        reportAfterSweep: `${sweep.stdout}${sweep.stderr}`,
        secondInterrupt,
      });
      checks.note(
        "what was observed",
        `sweep report: ${excerpt(`${sweep.stdout}${sweep.stderr}`, 300)}; ` +
          `the retained clone's committed derivation should be ${keptValue}: ` +
          `${clonesUnder(runs).map((c) => `${c.path}=${existsSync(join(c.path, "kept.txt")) ? excerpt(readFileSync(join(c.path, "kept.txt"), "utf8"), 40) : "no kept.txt"}`).join("; ") || "no clones"}`,
      );
      live = { kind: "ran", checks };
    }

    return combine(did, noCredentialFreeChecks(), live);
  },
};

export default item;
