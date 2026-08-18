// SPDX-License-Identifier: Apache-2.0
/**
 * Item 6 — A single-vendor machine degrades visibly.
 *
 * Rulings 32, 55, 53. This is the common case for a first-time user, which is
 * why "it works, weakened, and says so" is the promise rather than "it refuses".
 *
 * The first draft **passed against four `console.log` lines** containing
 * "same-vendor" and "attempts 1 of 1 — no second rung". Both halves are now
 * anchored: the run must COMPLETE, proved by a `git fsck`-clean integration ref
 * whose tree carries this run's token, and the ladder facts are read out of the
 * run record on disk and cross-checked against the vendor set this harness
 * planted — not out of a sentence.
 *
 * The single-vendor machine is manufactured rather than waited for: `PATH` holds
 * exactly one vendor. A bar that could only run on a machine that happened to
 * have one vendor would be a bar nobody ran.
 *
 * Ruling 55's sharp half is that a MISSING rung must not render as an EXHAUSTED
 * one — `attempts 1 of 1 — no second rung`, never the bare `attempts 2 of 2` a
 * two-vendor machine produces. They are different facts and only one of them is
 * the user's fault. And a short ladder is stated at plan ADMISSION, before
 * anything is spent, which is finding 87: v1 discovered it after an attempt was
 * already gone. Admission needs no credentials, so that half is graded on a bare
 * machine.
 */

import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { gatherRunEvidence, proofOfWork } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir } from "../lib/fs.ts";
import { makeRepo, plantSeeds } from "../lib/git.ts";
import { combine, type LiveHalf } from "../lib/halves.ts";
import { disjointPlan, writePlan } from "../lib/plan.ts";
import { baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/** The bare form a two-vendor machine produces. On a one-vendor machine it is a lie. */
const BARE_RUNG = /attempts?\s+\d+\s+of\s+\d+\s*$/im;

const item: BarItem = {
  id: 6,
  title: "A single-vendor machine degrades visibly",
  rulings: [32, 55, 53],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    // Exactly one vendor on PATH. This is the machine under test.
    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [{ id: "codex", version: "1.4.0" }]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });
    did.push(`planted exactly ONE fixture vendor at ${binDir} and gave the binary a PATH containing only it`);

    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n" });
    const plan = disjointPlan(1, "solo");
    await plantSeeds(repo, plan.seeds);
    const planPath = writePlan(ctx.workdir, plan.plan);

    // ---- credential-free: the ladder is stated at ADMISSION -----------------
    const admission = await probeFeature(
      ctx,
      ["run", "--plan", planPath, "--repo", repo, "--run-root", join(ctx.workdir, "runs"), "--dry-run"],
      { env, timeoutMs: 120_000, evidence: (r) => r.code === 0 && /ladder|admitted/i.test(r.stdout) },
    );
    did.push(`admission pass on a one-vendor PATH: ${admission.transcript}`);
    const credentialFree = new Checks();
    const admissionText = `${admission.result.stdout}${admission.result.stderr}`;
    if (!admission.present) {
      credentialFree.expect("a plan can be admitted at all", false, admission.transcript);
    } else {
      credentialFree.expect(
        "a short ladder is stated at plan admission, before anything is spent (ruling 55, finding 87)",
        /ladder/i.test(admissionText) && /no second rung|1 rung/i.test(admissionText),
        `admission output: ${excerpt(admissionText, 240)}`,
      );
      credentialFree.expect(
        "the admission does not claim a rung the machine does not have",
        !/2 rungs/i.test(admissionText),
        `one vendor is on PATH; admission said: ${excerpt(admissionText, 240)}`,
      );
    }

    // ---- live: the run completes, weakened, and says so ---------------------
    const probe = await probeFeature(
      ctx,
      ["run", "--plan", planPath, "--repo", repo, "--run-root", join(ctx.workdir, "runs"), "--review"],
      { env, timeoutMs: 300_000 },
    );
    did.push(probe.transcript);

    let live: LiveHalf;
    if (!probe.present) {
      live = { kind: "missing", probe, promise: "there is no run to degrade, so neither the same-vendor statement nor the ladder's rung can be observed" };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "the run must COMPLETE on one drivable vendor, which needs that vendor's credentials" };
    } else {
      const report = `${probe.result.stdout}${probe.result.stderr}`;
      const evidence = await gatherRunEvidence(repo, report);
      const checks = new Checks();

      // It COMPLETED. Ruling 32: it does not refuse to start.
      for (const row of proofOfWork(evidence, { expected: plan.expected, itemIds: plan.itemIds }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }

      const review = evidence.record?.review;
      checks.expect(
        "the record states review ran same-vendor, and why (ruling 32)",
        review !== undefined && review.crossVendor === false && (review.sameVendorReason ?? "").length > 0,
        `record.review = ${JSON.stringify(review ?? null)} — with one vendor on PATH, crossVendor must be false and the reason stated`,
      );
      checks.expect(
        "the weakened check is not rendered as a pass",
        /same[- ]vendor/i.test(report),
        `report: ${excerpt(report, 240)}`,
      );

      const solo = evidence.record?.items[0];
      checks.expect(
        "the record says which rung it got, and that there was no second (ruling 55)",
        solo?.attemptsAvailable === 1,
        `attempts ${solo?.attempts ?? "?"} of ${solo?.attemptsAvailable ?? "?"} — on a one-vendor machine there is no second rung, and recording 2 would be recording one that does not exist`,
      );
      checks.expect(
        "a missing rung does not render as an exhausted one",
        !BARE_RUNG.test(report),
        `bare \`attempts N of M\` lines in the report: ${excerpt((report.match(BARE_RUNG) ?? []).join(" | "), 200) || "none"}`,
      );

      live = { kind: "ran", checks };
    }

    return combine(did, credentialFree, live);
  },
};

export default item;
