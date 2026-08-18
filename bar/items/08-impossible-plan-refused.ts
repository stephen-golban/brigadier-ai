// SPDX-License-Identifier: Apache-2.0
/**
 * Item 8 — An impossible plan is refused before anything is spawned.
 *
 * Rulings 11, 37, 18, 52, 53.
 *
 * The first draft **passed against `read plan → print it → exit 4`**. Both of
 * its needles were fixed constants taken from the plan, so echoing the input
 * satisfied them. Both are now generated per run, after the binary under test
 * was built, and — more importantly — the item asserts the EFFECT `BAR.md`
 * actually names: zero processes and zero clones created.
 *
 * "Refused" and "refused after cloning" print identically, so the refusal is
 * checked against the filesystem: nothing appeared under the run root, and no
 * `.git` exists anywhere beneath it.
 *
 * A verify command present only in a COMMITTED FILE is not executed. That is
 * ruling 37's security property rather than a nicety — cloning a hostile
 * repository must not run its command with the operator's privileges — so the
 * repository commits one whose only job is to write a canary, and the canary
 * must not exist. And because a canary that never existed proves nothing on its
 * own, the item first proves the hostile script IS executable and WOULD write
 * the canary if anything ran it.
 *
 * Ruling 53: the refusal names a REMEDY rather than arithmetic — which
 * requirement failed on which agent, and whether it failed because the agent
 * cannot or because NOBODY HAS MEASURED IT, which need different fixes. v1 said
 * `ROUTING_FAILED — 11 model(s) were eliminated`, which is arithmetic.
 *
 * Everything here happens at admission, before any agent turn, so the whole item
 * is credential-free and runs on `BAR.md`'s authoritative CI leg.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantVendors } from "../lib/fixtures.ts";
import { canary, ensureDir, listTree, writeScript } from "../lib/fs.ts";
import { makeRepo } from "../lib/git.ts";
import { combine, type LiveHalf } from "../lib/halves.ts";
import { token, writePlan } from "../lib/plan.ts";
import { baseEnv, exec } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

export interface RefusalObservations {
  refusal: string;
  code: number | null;
  missingTool: string;
  misspelledCommand: string;
  /** Paths that appeared under the run root during the refusal. Must be none. */
  appeared: string[];
  /** Any `.git` beneath the run root. A clone is a clone however it is named. */
  clones: string[];
  committedCommandRan: boolean;
  /** Proof the hostile script would have written the canary if anything ran it. */
  hostileScriptWorks: boolean;
}

/** `11 model(s) were eliminated` is arithmetic; a remedy names a term and an agent. */
const ARITHMETIC_ONLY = /\b\d+\s+(model|agent)s?\b[^.]*\beliminated\b/i;
const UNMEASURED_TERM = /unmeasured|not measured|nobody has measured|never measured/i;

export function judgeRefusal(o: RefusalObservations): Checks {
  const checks = new Checks();
  checks.expect(
    "the plan is refused",
    o.code !== 0 && o.code !== null,
    `exit ${o.code}; output: ${excerpt(o.refusal, 240)}`,
  );
  checks.expect(
    "the refusal names the missing tool",
    o.refusal.includes(o.missingTool),
    `looked for ${JSON.stringify(o.missingTool)} — generated for this run, so an echo of a fixed constant cannot match; output: ${excerpt(o.refusal, 240)}`,
  );
  checks.expect(
    "the misspelled verify command is caught at admission (ruling 52)",
    o.refusal.includes(o.misspelledCommand),
    `looked for ${JSON.stringify(o.misspelledCommand)}; output: ${excerpt(o.refusal, 240)}`,
  );
  checks.expect(
    "zero clones and zero processes were created",
    o.appeared.length === 0 && o.clones.length === 0,
    o.appeared.length === 0 && o.clones.length === 0
      ? "no path appeared under the run root, and no .git exists beneath it"
      : `appeared: ${o.appeared.join(", ") || "none"}; git directories: ${o.clones.join(", ") || "none"}`,
  );
  // The control on the check below: an inert script would satisfy it for the
  // wrong reason.
  checks.expect(
    "the hostile committed command WOULD have written its canary if run",
    o.hostileScriptWorks,
    o.hostileScriptWorks
      ? "the harness ran the committed script itself and the canary appeared, then removed it"
      : "the committed script did not work even when run directly — the check below would pass for the wrong reason",
  );
  checks.expect(
    "a verify command from a COMMITTED file was not executed (ruling 37)",
    !o.committedCommandRan,
    o.committedCommandRan ? "the committed command's canary EXISTS — it ran" : "the committed command's canary does not exist",
  );
  checks.expect(
    "the refusal is a remedy, not arithmetic (ruling 53)",
    !ARITHMETIC_ONLY.test(o.refusal) && UNMEASURED_TERM.test(o.refusal),
    `arithmetic shape present: ${ARITHMETIC_ONLY.test(o.refusal)}; distinguishes UNMEASURED from unable: ${UNMEASURED_TERM.test(o.refusal)}; output: ${excerpt(o.refusal, 300)}`,
  );
  return checks;
}

const item: BarItem = {
  id: 8,
  title: "An impossible plan is refused before anything is spawned",
  rulings: [11, 37, 18, 52, 53],
  // Admission happens before any agent turn. A machine with no credentials can
  // still refuse a plan, and an item that waited for vendors here would be
  // hiding a check that does not need them.
  requiresLive: false,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n" });

    // Ruling 37: a command the REPOSITORY supplies, committed, with a canary.
    const outside = ensureDir(join(ctx.workdir, "outside"));
    const canaryPath = join(outside, "committed-command-ran.txt");
    const hostile = writeScript(
      join(repo, "verify.sh"),
      `#!/bin/sh\necho ran > ${JSON.stringify(canaryPath)}\n`,
      `@echo off\r\necho ran > ${canaryPath}\r\n`,
    );
    writeFileSync(join(repo, "brigadier.json"), JSON.stringify({ verify: "./verify.sh" }, null, 2));

    // Prove the trap is armed before asserting it did not spring.
    await exec([hostile], { cwd: repo, timeoutMs: 30_000 });
    const hostileScriptWorks = existsSync(canaryPath);
    if (hostileScriptWorks) Bun.spawnSync(["rm", "-f", canaryPath]);
    did.push(
      `committed a hostile verify command at ${hostile}; ran it once directly to prove it writes ${canaryPath} (it ${hostileScriptWorks ? "does" : "does NOT"}), then removed the canary`,
    );

    // Generated now, so echoing the plan back cannot satisfy either needle.
    const missingTool = token("no-such-tool");
    const misspelled = `${token("bnu")} tset`;
    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: [
        { id: "needs-a-missing-tool", kind: "write", paths: ["a.txt"], prompt: "do the work", requires: [missingTool] },
        { id: "misspelled-verify", kind: "write", paths: ["b.txt"], prompt: "do the work", verify: misspelled },
      ],
    });
    did.push(`wrote a plan at ${planPath} requiring \`${missingTool}\` and verifying with \`${misspelled}\` — both generated for this run`);

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantVendors(binDir, [{ id: "qwen", version: "0.21.13" }]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });

    const workRoot = ensureDir(join(ctx.workdir, "runs"));
    const before = new Set(listTree(workRoot));
    const probe = await probeFeature(ctx, ["run", "--plan", planPath, "--repo", repo, "--run-root", workRoot], {
      env,
      timeoutMs: 120_000,
      evidence: (r) => r.code !== 0 && `${r.stdout}${r.stderr}`.trim().length > 0,
    });
    did.push(probe.transcript);

    const appeared = listTree(workRoot).filter((p) => !before.has(p));
    const observations: RefusalObservations = {
      refusal: `${probe.result.stdout}${probe.result.stderr}`,
      code: probe.result.code,
      missingTool,
      misspelledCommand: misspelled,
      appeared,
      clones: appeared.filter((p) => p.includes(".git/")),
      committedCommandRan: canary(canaryPath).escaped,
      hostileScriptWorks,
    };

    const credentialFree = probe.present
      ? judgeRefusal(observations)
      : (() => {
          const checks = new Checks();
          checks.expect(
            "a plan-admission surface exists to refuse an impossible plan",
            false,
            `${probe.transcript}\npaths that appeared under ${workRoot}: ${appeared.join(", ") || "none"}; ` +
              `committed-command canary ${canaryPath}: ${canary(canaryPath).detail}`,
          );
          return checks;
        })();

    const live: LiveHalf = { kind: "none" };
    return combine(did, credentialFree, live);
  },
};

export default item;
