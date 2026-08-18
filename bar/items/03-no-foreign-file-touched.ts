// SPDX-License-Identifier: Apache-2.0
/**
 * Item 3 — No file another product owns is touched.
 *
 * Rulings 8, 27, 28. Hash every foreign config file before a full run and after
 * it, and assert byte-identical. #27 already drove this shape and found
 * `~/.claude/settings.json` unchanged throughout; this item makes it permanent
 * rather than a one-off observation.
 *
 * The first draft passed against `process.exit(0)`, and the reason is worth
 * stating plainly rather than fixing quietly: it hashed six locations either
 * side of a run that never happened. Nothing had changed because nothing had
 * occurred. **A conservation law is only evidence when something moved**, so the
 * unchanged digests are now paired with `proofOfWork` — a `git fsck`-clean
 * integration ref whose tree carries a token this harness generated after the
 * binary was built.
 *
 * An absent file hashes as `absent`, which is a different observation from a
 * digest and is compared as one. A file that APPEARS where there was none is a
 * change, and a check that treated missing as "nothing to compare" would miss
 * exactly the case where brigadier creates a config another product owns —
 * which is what ruling 28's `PreCompact` gives it a reason to want.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Checks } from "../lib/checks.ts";
import { gatherRunEvidence, proofOfWork } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir, hashFile, hashTree } from "../lib/fs.ts";
import { makeRepo, plantSeeds } from "../lib/git.ts";
import { combine, noCredentialFreeChecks, type LiveHalf } from "../lib/halves.ts";
import { runSampled } from "../lib/inflight.ts";
import { disjointPlan, writePlan } from "../lib/plan.ts";
import { baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/** Every location another product owns, from `BAR.md`'s own list. */
export function foreignPaths(home = homedir()): string[] {
  return [
    join(home, ".claude", "settings.json"),
    join(home, ".codex", "config.toml"),
    join(home, ".cursor", "hooks.json"),
    join(home, ".gemini", "hooks.json"),
    join(home, ".kiro", "hooks.json"),
  ];
}

export function foreignTrees(home = homedir()): string[] {
  return [join(home, ".config", "opencode")];
}

export interface ForeignSnapshot {
  files: Record<string, string>;
  trees: Record<string, string>;
}

export function snapshotForeign(home = homedir()): ForeignSnapshot {
  const files: Record<string, string> = {};
  for (const path of foreignPaths(home)) files[path] = hashFile(path);
  const trees: Record<string, string> = {};
  for (const path of foreignTrees(home)) trees[path] = hashTree(path);
  return { files, trees };
}

export function diffForeign(before: ForeignSnapshot, after: ForeignSnapshot): string[] {
  const changed: string[] = [];
  for (const [path, hash] of Object.entries(before.files)) {
    if (after.files[path] !== hash) changed.push(`${path}: ${hash} -> ${after.files[path]}`);
  }
  for (const [path, hash] of Object.entries(before.trees)) {
    if (after.trees[path] !== hash) changed.push(`${path}/ (tree): ${hash} -> ${after.trees[path]}`);
  }
  return changed;
}

const item: BarItem = {
  id: 3,
  title: "No file another product owns is touched",
  rulings: [8, 27, 28],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    const before = snapshotForeign();
    const counted = Object.keys(before.files).length + Object.keys(before.trees).length;
    did.push(`hashed ${counted} foreign config locations under ${homedir()} before the run`);

    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n" });
    const plan = disjointPlan(2, "foreign");
    await plantSeeds(repo, plan.seeds);
    const planPath = writePlan(ctx.workdir, plan.plan);

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "qwen", version: "0.21.13" },
      { id: "copilot", version: "1.0.80" },
    ]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });
    const runs = ensureDir(join(ctx.workdir, "runs"));
    did.push(`wrote a two-item plan at ${planPath}; each item must DERIVE its output from a nonce that exists only inside the clone`);

    const probe = await probeFeature(ctx, ["run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--dry-run"], {
      env,
      timeoutMs: 60_000,
    });
    did.push(`admission probe: ${probe.transcript}`);

    let live: LiveHalf;
    if (!probe.present) {
      live = {
        kind: "missing",
        probe,
        promise:
          "no full run can be driven, so the digests either side of it are of a run that did not happen — and an unchanged hash across nothing is not evidence",
      };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "a full run with real workers is what would touch another product's directory" };
    } else {
      const sampled = await runSampled([ctx.binary, "run", "--plan", planPath, "--repo", repo, "--run-root", runs], {
        cwd: ctx.workdir,
        env,
        runRoot: runs,
        timeoutMs: 300_000,
      });
      did.push(`ran the plan while sampling the run root ${sampled.flight.samples} times`);
      const after = snapshotForeign();
      const changed = diffForeign(before, after);

      const evidence = await gatherRunEvidence(repo, `${sampled.stdout}${sampled.stderr}`);
      const checks = new Checks();
      // Something moved. Only then does nothing having moved elsewhere mean
      // anything.
      for (const row of proofOfWork(evidence, {
        expected: plan.expected,
        itemIds: plan.itemIds,
        flight: sampled.flight,
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }
      checks.expect(
        "every foreign config location is byte-identical across the run",
        changed.length === 0,
        changed.length === 0
          ? `${counted} locations unchanged: ${Object.entries(before.files).map(([p, h]) => `${p}=${h.slice(0, 12)}`).join(", ")}`
          : changed.join("; "),
      );
      live = { kind: "ran", checks };
    }

    return combine(did, noCredentialFreeChecks(), live);
  },
};

export default item;
