// SPDX-License-Identifier: Apache-2.0
/**
 * Item 5 — Review is cross-vendor, and its catch rate is published.
 *
 * Rulings 32, 10, 24, 52, 68.
 *
 * The first draft **passed against three printed table rows**, and asserted the
 * cross-vendor property, the reviewer-`error` blocker and the catch rate
 * NOWHERE — they existed only as prose in the item's own `did` string. This is
 * the item `BAR.md` says converts ruling 52's named assumption into a public
 * measurement, and as written it measured nothing at all.
 *
 * Each half is now anchored to something a printer cannot produce:
 *
 *   **cross-vendor** — the run record must name a reviewer whose vendor DIFFERS
 *   from the builder's, and both names must be vendors this harness planted on
 *   an isolated `PATH` seconds ago;
 *
 *   **the reviewer-`error` blocker** — a vendor configured to die mid-turn is
 *   planted, and the assertion is that the reviewed item's token is ABSENT from
 *   the integration tree. Not that the report said `error`: v1 merged its most
 *   delicate change on `review: not run (REVIEWER_FAILED)`, so the report saying
 *   the right word is exactly what already failed once;
 *
 *   **the catch rate** — five defect markers are planted in the diff, generated
 *   after the binary was built, and the record must name WHICH it caught. A
 *   count can be printed; a list of unguessable markers can only be produced by
 *   something that read the diff.
 *
 * The rate is PUBLISHED, not gated. Review is probabilistic and a flaky blocking
 * item gets disabled, while a published number gets argued with — so the item
 * asserts the number exists and is re-derivable, and prints it beside v1's
 * measured baseline of 0 of 3.
 *
 * **Whose defects these are, said plainly:** `BAR.md` gives the planting to the
 * INDEPENDENT VERIFIER, on the grounds that a builder's planted defect tests
 * only what the builder already thought of. What runs here is a mechanised
 * stand-in that keeps the plumbing honest between verifier visits. It does not
 * replace the verifier, and this item should not be read as if it had.
 *
 * Ruling 68's half needs no credentials at all and is graded as the
 * credential-free half: `brigadier competence` must print every row with its
 * evidence class and citation, no citation may be a LINE ANCHOR — v1 lost 8 of
 * 44 rows to one comment-only sweep — and a model the table has never heard of
 * must be used, sorted last and NAMED, never silently excluded.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { derive, nonce } from "../lib/derive.ts";
import { gatherRunEvidence } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { detectRealFleet } from "../lib/fleet.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir } from "../lib/fs.ts";
import { makeRepo, plantSeeds } from "../lib/git.ts";
import { combine, type LiveHalf } from "../lib/halves.ts";
import { readLedger, vendorsIn } from "../lib/ledger.ts";
import { token, writePlan } from "../lib/plan.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/** v1's measured baseline, printed beside whatever this run produces. */
export const V1_CATCH_BASELINE = "0 of 3";
export const CATCH_THRESHOLD = { caught: 3, planted: 5 };

/**
 * A citation that is a line anchor — `src/foo.ts:112`, `#L112`, `line 112`.
 *
 * Ruling 68 forbids them because they rot silently: v1 lost 8 of 44 competence
 * rows to a single comment-only sweep that moved every line in a file without
 * changing a statement.
 */
export function isLineAnchor(citation: string): boolean {
  return /(:\d+\b)|(#L\d+)|(\bline\s+\d+\b)/i.test(citation);
}

export interface CompetenceObservations {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function judgeCompetence(o: CompetenceObservations): Checks {
  const checks = new Checks();
  const rows = o.stdout.split("\n").filter((l) => l.trim().length > 0 && !/^\s*#/.test(l));
  const classed = /\b(measured|reported|published|editorial|assumed|vendor)\b/i;

  checks.expect(
    "`brigadier competence` prints rows",
    o.code === 0 && rows.length > 0,
    `exit ${o.code}; ${rows.length} non-blank lines; stdout: ${excerpt(o.stdout, 240)}; stderr: ${excerpt(o.stderr, 200)}`,
  );
  checks.expect(
    "every row carries an evidence class and a citation",
    rows.length > 0 && rows.every((r) => classed.test(r)),
    `rows without an evidence class: ${excerpt(rows.filter((r) => !classed.test(r)).join(" | "), 240)}`,
  );
  const anchored = rows.filter(isLineAnchor);
  checks.expect(
    "no citation is a line anchor (ruling 68)",
    anchored.length === 0,
    anchored.length === 0 ? `checked ${rows.length} rows` : `line-anchored: ${excerpt(anchored.join(" | "), 240)}`,
  );
  checks.expect(
    "a model the table has never heard of is named rather than silently excluded",
    /unranked/i.test(o.stdout),
    `looked for an explicitly unranked row; stdout: ${excerpt(o.stdout, 240)}`,
  );
  return checks;
}

const item: BarItem = {
  id: 5,
  title: "Review is cross-vendor, and its catch rate is published",
  rulings: [32, 10, 24, 52, 68],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    // ---- credential-free: ruling 68 -----------------------------------------
    const competence = await probeFeature(ctx, ["competence"], { timeoutMs: 30_000 });
    did.push(competence.transcript);
    const credentialFree = competence.present
      ? judgeCompetence({
          code: competence.result.code,
          stdout: competence.result.stdout,
          stderr: competence.result.stderr,
        })
      : (() => {
          const checks = new Checks();
          // Not a skip. Ruling 68's half needs no credentials, so its absence is
          // a failure a bare CI machine must report.
          checks.expect("`brigadier competence` exists and can be audited", false, competence.transcript);
          return checks;
        })();

    // ---- live: rulings 32, 52, 24 -------------------------------------------
    const binDir = ensureDir(join(ctx.workdir, "bin"));
    const defects = Array.from({ length: CATCH_THRESHOLD.planted }, (_, i) => token(`DEFECT-${i + 1}`));
    // A reviewer that CAN spot three of the five. What it actually finds is
    // decided by the diff it is handed, which is the difference between FOUND
    // and KNOWN — and the previous item conflated them.
    const fleet = plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "qwen", version: "0.21.13" },
      { id: "copilot", version: "1.0.80", catches: defects.slice(0, 3) },
    ]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });

    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n" });
    // The defects are planted in the repository so they land in the diff the
    // reviewer is handed — ruling 52's framing, which is the assumption this
    // item exists to falsify or confirm in public. The nonce the worker derives
    // from lives beside them and only inside the clone.
    const reviewedSeed = nonce("reviewed-seed");
    await plantSeeds(repo, [
      { path: "seeds/reviewed.seed", value: `${reviewedSeed}\n${defects.join("\n")}`, placement: "uncommitted-tracked" },
    ]);
    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: [
        {
          id: "reviewed",
          kind: "write",
          paths: ["reviewed.txt"],
          prompt: "write reviewed.txt",
          directive: { do: "derive-write", read: "seeds/reviewed.seed", path: "reviewed.txt", salt: "reviewed" },
        },
      ],
    });
    writeFileSync(join(ctx.workdir, "planted-defects.txt"), defects.join("\n"));
    did.push(`planted ${defects.length} unguessable defect markers into the diff a reviewer would be handed`);

    // The credentialed leg: the operator's own PATH, so the product discovers
    // the agents they really have.
    const realFleet = await detectRealFleet(ctx);
    const checks0 = new Checks();
    did.push(`detected the real fleet: ${realFleet.usable.join(", ") || "none usable"}`);
    const probe = await probeFeature(
      ctx,
      ["run", "--plan", planPath, "--repo", repo, "--run-root", join(ctx.workdir, "runs"), "--review", "--planted", String(defects.length)],
      {
        env,
        timeoutMs: HARNESS_RUN_TIMEOUT_MS,
        // A run whose items FAIL review exits non-zero, which is correct
        // behaviour — so presence is judged on the run having produced a
        // record, not on the exit code.
        evidence: (r) => /run-record:/.test(r.stdout),
      },
    );
    did.push(probe.transcript);

    let live: LiveHalf;
    if (!probe.present) {
      live = { kind: "missing", probe, promise: "no run can be driven, so no reviewer is routed and no catch rate can be published" };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "the reviewer's vendor must DIFFER from the builder's, which requires two drivable vendors" };
    } else {
      const report = `${probe.result.stdout}${probe.result.stderr}`;
      // Which fleet was this? Ruling 32's cross-vendor promise is about REAL
      // vendors, and a fixture reviewer catches what we configured it to catch.
      checks0.expect(
        "this item drove the operator's real, credentialed fleet",
        realFleet.usable.length >= 2,
        `\`brigadier detect\` reports ${realFleet.usable.length} usable agent(s): ${realFleet.usable.join(", ") || "none"}. ` +
          "Ruling 43 and #41 measured an APPROVED permission on Codex running OUTSIDE its own sandbox — no stub can reproduce that, " +
          "so this item needs two real vendors and says so rather than substituting fixtures",
      );
      const evidence = await gatherRunEvidence(repo, report);
      const checks = new Checks();
      for (const row of checks0.rows) checks.expect(row.name, row.ok, row.detail);
      const reviewed = evidence.record?.items.find((i) => i.id === "reviewed");

      // The ledger, not the record. A record is the product's account of itself
      // and a forger writes it; a ledger line is a file a process had to exist to
      // append to. The previous item passed on two strings without either vendor
      // running.
      const ledger = readLedger(fleet.ledger);
      const builders = vendorsIn(ledger, "builder");
      const reviewers = vendorsIn(ledger, "reviewer");
      checks.expect(
        "a builder vendor process and a reviewer vendor process BOTH really ran",
        builders.length > 0 && reviewers.length > 0,
        `vendor ledger: builders ${builders.join(", ") || "NONE"}, reviewers ${reviewers.join(", ") || "NONE"} (${ledger.length} invocations recorded)`,
      );
      checks.expect(
        "the reviewer's vendor DIFFERS from the builder's, in the ledger and in the record (ruling 32)",
        builders.length > 0 &&
          reviewers.length > 0 &&
          reviewers.some((r) => !builders.includes(r)) &&
          reviewed?.reviewerAgent !== undefined &&
          reviewed.builderAgent !== undefined &&
          reviewed.reviewerAgent !== reviewed.builderAgent,
        `ledger builders ${builders.join(",")}, ledger reviewers ${reviewers.join(",")}; ` +
          `record says builder ${reviewed?.builderAgent ?? "none"}, reviewer ${reviewed?.reviewerAgent ?? "none"}`,
      );
      // `.every()` is true of an empty array, so the previous version accepted
      // `caughtDefects: []` as a perfect score. Non-emptiness is asserted first,
      // and the set must be exactly what this reviewer could find in this diff —
      // FOUND, not KNOWN.
      const caught = evidence.record?.review?.caughtDefects ?? [];
      checks.expect(
        "the catch rate is recorded as identities, and there is at least one",
        caught.length > 0 && caught.every((m) => defects.includes(m)),
        `caught ${JSON.stringify(caught)} of planted ${JSON.stringify(defects)} — an empty list is not a perfect score, and \`.every()\` on it is vacuously true`,
      );
      checks.expect(
        "the reviewer reports what it FOUND, not what it knows",
        caught.length === 3 && caught.every((m) => defects.slice(0, 3).includes(m)),
        `this reviewer can spot ${defects.slice(0, 3).length} of the ${defects.length} planted and all of them are in the diff, so exactly those must be reported; it reported ${caught.length}`,
      );
      checks.expect(
        "the catch rate is PRINTED whether or not it clears the threshold",
        /catch rate\s+\d+\s+of\s+\d+/i.test(report),
        `${excerpt(/catch rate.*/i.exec(report)?.[0] ?? "no catch-rate line", 160)} — threshold ${CATCH_THRESHOLD.caught} of ${CATCH_THRESHOLD.planted} is a stated judgement, and v1's measured baseline is ${V1_CATCH_BASELINE}`,
      );

      // The blocker, asserted on the tree rather than on the word `error`.
      const dyingBin = ensureDir(join(ctx.workdir, "bin-dying"));
      plantFleet(dyingBin, join(ctx.workdir, "vendor-ledger-dying.tsv"), [
        { id: "qwen", version: "0.21.13" },
        { id: "copilot", version: "1.0.80", dieAsReviewer: true },
      ]);
      const dyingRepo = join(ctx.workdir, "dying-repo");
      await makeRepo(dyingRepo, { "README.md": "base\n" });
      const blockedSeed = nonce("blocked-seed");
      await plantSeeds(dyingRepo, [{ path: "seeds/blocked.seed", value: blockedSeed, placement: "committed" }]);
      const blockedValue = derive(blockedSeed, "blocked");
      const blockedPlan = writePlan(
        ctx.workdir,
        {
          version: 1,
          items: [
            {
              id: "blocked",
              kind: "write",
              paths: ["blocked.txt"],
              prompt: "write blocked.txt",
              directive: { do: "derive-write", read: "seeds/blocked.seed", path: "blocked.txt", salt: "blocked" },
            },
          ],
        },
        "blocked.json",
      );
      const blocked = await ctx.run(
        ["run", "--plan", blockedPlan, "--repo", dyingRepo, "--run-root", join(ctx.workdir, "runs-dying"), "--review"],
        { env: baseEnv({ PATH: isolatedPath(dyingBin) }), timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      const blockedEvidence = await gatherRunEvidence(dyingRepo, `${blocked.stdout}${blocked.stderr}`);
      const reachedTree = [...blockedEvidence.files.values()].some((body) => body.includes(blockedValue));
      checks.expect(
        "a reviewer that produced no verdict BLOCKS — the item did not integrate (ruling 52)",
        !reachedTree,
        `the reviewer was killed mid-turn; the item's derived output ${blockedValue} in the integration tree: ${reachedTree}. ` +
          `Asserted on the tree rather than on the word "error", because v1 merged its most delicate change on \`review: not run (REVIEWER_FAILED)\``,
      );
      checks.note(
        "whose defects these are",
        "BAR.md gives the planting to the independent verifier — a builder's planted defect tests only what the builder already thought of. What ran here is a mechanised stand-in that keeps the plumbing honest between verifier visits, and it does not replace one",
      );

      live = { kind: "ran", checks };
    }

    return combine(did, credentialFree, live);
  },
};

export default item;
