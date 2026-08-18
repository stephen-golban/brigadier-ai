// SPDX-License-Identifier: Apache-2.0
/**
 * Item 13 — The cost model predicts, enforces, and says what it could not see.
 *
 * Rulings 66, 67, 70, 35, 23, 21, 29, 30, 31, 40.
 *
 * The first draft **passed against twelve printed lines**. Enforcement is now
 * asserted on the EFFECT rather than on the word: a run given a hard ceiling
 * below what its plan costs must leave items un-integrated, and the item checks
 * the integration history is SHORTER than the plan and that the record marks the
 * rest `unrun` or `cancelled`. A ceiling that only prints is not a ceiling.
 *
 * That repair was itself misread for a while, and the misreading hid a real
 * defect. "Un-integrated" was counted by matching `/: integrated$/` against
 * `git log --format=%s` — a subject the product does not write and a forgery
 * does — so both sides of the comparison read zero against the real binary and
 * the enforcement check failed for a reason with nothing to do with ceilings.
 * Underneath it sits a genuine product gap: `cost.actual`, `softCeilingHit` and
 * `hardCeilingHit` are declared in the record's type and never assigned by
 * `src/queue/execute.ts`, so "actual is reported against the estimate" fails
 * because the number does not exist. Counting integrations properly separates
 * the two, and the second is the product's to close.
 *
 * Properly does NOT mean believing `record.items[].status`. The record is where
 * this item learns WHICH shas to ask about; `git cat-file -t` and `git
 * merge-base --is-ancestor` are what answer. Counting the claim alone let
 * `bar/fakes/forger.ts` — real objects, no work, and a record that says whatever
 * suits it — pass this item outright, measured on 2026-08-18. `verifyIntegration`
 * below reports the claim and the confirmation as two numbers, and every check
 * that matters uses the second.
 *
 * The clamp is read out of the run record per item, and `never clamps upward` is
 * checked against the declared difficulty rather than against a printed
 * sentence — because an upgrade spends money the operator did not ask for and
 * v1's recurring shape is the silent change nobody sees.
 *
 * The quota half is the one that is easiest to fake, so it is cross-checked: the
 * vendors named in the quota block must be exactly the vendors the record says
 * items actually ran on, which are the vendors this harness planted on an
 * isolated `PATH` seconds ago. A run using opencode says `unpriceable` — #42
 * measured it reaching a model with NO credential at all through its own
 * gateway, so a successful turn proves nothing about which account was billed —
 * and its total is a LOWER BOUND.
 *
 * Estimates are ranges because #44 measured two identical Codex runs at 427,723
 * and 28,245 bytes — 15× — and published tooling puts real cost at 3–5× naive
 * estimates. A single number here would be a lie with a decimal point on it.
 * Predicting costs nothing, so the estimate half is graded credential-free.
 *
 * **WHAT THIS ITEM CANNOT PROVE:** #45 measured that neither vendor's effort
 * setting is confirmable over the protocol, so "the effort we asked for is the
 * effort that ran" is asserted from vendor-private records or not at all.
 */

import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { nonce } from "../lib/derive.ts";
import { gatherRunEvidence } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir } from "../lib/fs.ts";
import { makeRepo, plantSeeds } from "../lib/git.ts";
import { combine, type LiveHalf } from "../lib/halves.ts";
import { writePlan } from "../lib/plan.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv } from "../lib/proc.ts";
import type { RunRecord } from "../lib/contract.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

const RANGE = /\d[\d.,]*\s*(–|—|-|to)\s*\d[\d.,]*/;

/**
 * Ruling 70's rule is about PHRASING, and there is no artefact to assert on
 * instead — so this is the one check in the repaired harness that is unavoidably
 * textual, and it is said out loud rather than dressed up.
 *
 * The first version failed the honest fixture on the sentence *"this run makes
 * no claim to have saved anything"*, which is the exact phrasing ruling 70 asks
 * for. A check that fails the wording it exists to require is not a strict
 * check, it is a broken one. So a line carrying an explicit disclaimer is
 * exempt, and the search is per line rather than over the whole report.
 */
const SAVINGS_CLAIM = /\b(saved|savings|reduced (?:cost|spend|tokens) by)\b/i;
const DISCLAIMER = /\b(no claim|makes no claim|not a claim|claims nothing|cannot be read as|is not a saving)\b/i;

export function savingsClaims(report: string): string[] {
  return report.split("\n").filter((line) => SAVINGS_CLAIM.test(line) && !DISCLAIMER.test(line));
}

export const DIFFICULTY_ORDER = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTY_ORDER)[number];

/** Ruling 67: down is a clamp, up is spending money the operator did not ask for. */
export function isUpwardClamp(from: string, to: string): boolean {
  const a = DIFFICULTY_ORDER.indexOf(from as Difficulty);
  const b = DIFFICULTY_ORDER.indexOf(to as Difficulty);
  return a !== -1 && b !== -1 && b > a;
}

/**
 * What a run CLAIMED to integrate, and how much of that claim `git` confirms.
 *
 * The two numbers are deliberately separate. Reading `status: "integrated"` and
 * stopping there would make this item score whatever the binary wrote in its own
 * JSON — `bar/fakes/forger.ts` writes exactly that record and did pass this item
 * the moment the count came from the record alone. So the record is used to
 * learn WHICH shas to ask about, and every one of them is then put to the object
 * store: it has to be a commit, the deliverable branch has to be able to reach
 * it, and it has to be the item's OWN commit rather than a tip shared with every
 * other item, which is what a chain written at leisure looks like.
 */
export interface IntegrationClaim {
  /** Items whose recorded status is `integrated`. */
  claimed: number;
  /** Of those, the ones git confirms. */
  verified: number;
  detail: string;
}

export function verifyIntegration(e: {
  record: RunRecord | undefined;
  itemCommits: Map<string, { sha: string | undefined; type: string | undefined; reachable: boolean }>;
  refSha: string | undefined;
}): IntegrationClaim {
  const claimedItems = (e.record?.items ?? []).filter((i) => i.status === "integrated");
  const shas = claimedItems.map((i) => e.itemCommits.get(i.id)?.sha).filter((sha): sha is string => sha !== undefined);
  const once = new Map<string, number>();
  for (const sha of shas) once.set(sha, (once.get(sha) ?? 0) + 1);

  const confirmed: string[] = [];
  const rejected: string[] = [];
  for (const item of claimedItems) {
    const seen = e.itemCommits.get(item.id);
    const ordinal = Number.isInteger(item.number) && (item.number ?? 0) >= 1;
    const own = seen?.sha !== undefined && once.get(seen.sha) === 1;
    if (ordinal && own && seen?.type === "commit" && seen.reachable) {
      confirmed.push(`${item.id}#${item.number} -> ${seen.sha?.slice(0, 12)}`);
    } else {
      rejected.push(
        `${item.id}#${item.number ?? "NO ORDINAL"} -> ${seen?.sha?.slice(0, 12) ?? "NO COMMIT"} ` +
          `(git cat-file -t: ${seen?.type ?? "no object"}, reachable from ${e.refSha?.slice(0, 12) ?? "no deliverable"}: ${
            seen?.reachable ?? false
          }, its own commit: ${own})`,
      );
    }
  }
  return {
    claimed: claimedItems.length,
    verified: confirmed.length,
    detail: `confirmed by git: ${confirmed.join("; ") || "none"}; unconfirmed: ${rejected.join("; ") || "none"}`,
  };
}

export interface CostObservations {
  report: string;
  record: RunRecord | undefined;
  /** The ceilinged run: what it claimed, and what git confirmed. */
  integrated: IntegrationClaim;
  /**
   * The same plan, same binary, same vendors, NO ceilings.
   *
   * Without this, "fewer items integrated" is indistinguishable from a binary
   * that simply does less — which is what a forger does for free. The ceiling
   * has to be shown to be the cause.
   */
  uncappedIntegrated: IntegrationClaim;
  plannedCount: number;
}

export function judgeCost(o: CostObservations): Checks {
  const checks = new Checks();
  const cost = o.record?.cost;

  // The record is an index, never a witness. Every `integrated` it claims is
  // resolved through `git cat-file -t` and `git merge-base --is-ancestor` before
  // it is counted, so a binary that writes a satisfying JSON and no objects
  // fails HERE rather than sliding through the comparison below.
  checks.expect(
    "every item the record calls `integrated` has its OWN commit on the deliverable branch",
    o.integrated.verified === o.integrated.claimed && o.uncappedIntegrated.verified === o.uncappedIntegrated.claimed,
    `capped run — claimed ${o.integrated.claimed}, git confirmed ${o.integrated.verified}: ${o.integrated.detail}. ` +
      `uncapped run — claimed ${o.uncappedIntegrated.claimed}, git confirmed ${o.uncappedIntegrated.verified}: ${o.uncappedIntegrated.detail}`,
  );
  // Enforcement, asserted on what did NOT happen rather than on a sentence, and
  // counted from the CONFIRMED integrations rather than from the claim.
  checks.expect(
    "the same plan without ceilings integrates MORE — so the ceiling is the cause (ruling 66)",
    o.uncappedIntegrated.verified > o.integrated.verified &&
      o.uncappedIntegrated.verified === o.plannedCount &&
      (o.record?.items ?? []).some((i) => i.status === "unrun" || i.status === "cancelled"),
    `uncapped: ${o.uncappedIntegrated.verified} of ${o.plannedCount} integrated and confirmed; capped: ${o.integrated.verified}. ` +
      `Statuses under the cap: ${(o.record?.items ?? []).map((i) => `${i.id}=${i.status}`).join(", ") || "no record"}. ` +
      "A binary that simply does less produces the same shortfall with no ceiling involved",
  );
  const cost0 = o.record?.cost;
  checks.expect(
    "actual is reported against the estimate, and falls inside the range",
    cost0?.actual !== undefined &&
      cost0.estimateLow !== undefined &&
      cost0.actual >= 0 &&
      cost0.actual <= cost0.estimateHigh &&
      /actual/i.test(o.report),
    `actual ${cost0?.actual ?? "absent"} against ${cost0?.estimateLow ?? "?"} – ${cost0?.estimateHigh ?? "?"} ${cost0?.currency ?? ""}`,
  );
  checks.expect(
    "the report distinguishes the soft ceiling from the hard one",
    /soft/i.test(o.report) && /hard/i.test(o.report) && cost !== undefined,
    `soft/hard named in the report: ${/soft/i.test(o.report)}/${/hard/i.test(o.report)}; ` +
      `record: softCeilingHit=${cost?.softCeilingHit}, hardCeilingHit=${cost?.hardCeilingHit}`,
  );

  // Ruling 29: the routing unit is a triple, recorded PER ITEM.
  const dispatched = (o.record?.items ?? []).filter((i) => i.status === "integrated" || i.status === "failed");
  checks.expect(
    "every dispatched item records its (agent, model, effort) triple",
    dispatched.length > 0 &&
      dispatched.every((i) => i.agent !== undefined && i.model !== undefined && i.effort !== undefined),
    dispatched.map((i) => `${i.id}=(${i.agent},${i.model},${i.effort})`).join("; ") || "nothing dispatched",
  );

  // Ruling 67: recorded per item, and visible to the operator. The RECORD says
  // what happened; the report is then required to say the same thing. The
  // expected line is DERIVED from the record rather than assumed to contain the
  // word "clamped", because an item whose difficulty was not clamped still has
  // to print its difficulty — an earlier version demanded the clamped wording
  // unconditionally and so failed on a run that correctly clamped nothing,
  // which measures the harness's guess rather than the product.
  const clamped = (o.record?.items ?? []).filter((i) => i.difficulty !== undefined);
  const expectedLine = (i: { difficulty?: string; clampedTo?: string }): string =>
    i.difficulty === i.clampedTo ? `difficulty: ${i.difficulty}` : `difficulty: ${i.difficulty} (clamped to ${i.clampedTo})`;
  const unprinted = clamped.filter((i) => i.clampedTo === undefined || !o.report.includes(expectedLine(i)));
  checks.expect(
    "the difficulty clamp is recorded per item and printed (ruling 67)",
    clamped.length > 0 && unprinted.length === 0,
    clamped.length === 0
      ? "no item declared a difficulty"
      : `recorded: ${clamped.map((i) => `${i.id}: ${i.difficulty} -> ${i.clampedTo ?? "NOT RECORDED"}`).join("; ")}; ` +
        `absent from the report: ${unprinted.map((i) => JSON.stringify(expectedLine(i))).join(", ") || "none"}`,
  );
  checks.expect(
    "brigadier never clamps UPWARD",
    clamped.every((i) => !isUpwardClamp(i.difficulty ?? "", i.clampedTo ?? "")),
    clamped.map((i) => `${i.difficulty} -> ${i.clampedTo}`).join("; ") || "no clamp observed",
  );

  // Ruling 13's quota half, cross-checked against the vendors that really ran.
  const used = [...new Set(dispatched.map((i) => i.agent).filter((a): a is string => a !== undefined))];
  const quota = cost?.quota ?? {};
  checks.expect(
    "quota is reported for every vendor that actually ran, as read / unreadable / unpriceable",
    used.length > 0 && used.every((v) => ["read", "unreadable", "unpriceable"].includes(quota[v] ?? "")),
    `vendors that ran: ${used.join(", ") || "none"}; quota block: ${JSON.stringify(quota)}`,
  );
  checks.expect(
    "a run using opencode says `unpriceable` and its total is a lower bound",
    !used.includes("opencode") || (quota["opencode"] === "unpriceable" && cost?.lowerBound === true),
    `opencode used: ${used.includes("opencode")}; #42 measured it reaching a model with no credential at all through its own gateway`,
  );

  // Ruling 70.
  checks.expect(
    "the levers that were active are listed",
    (cost?.levers ?? []).length > 0,
    JSON.stringify(cost?.levers ?? []),
  );
  const claims = savingsClaims(o.report);
  checks.expect(
    "no token-reduction claim is made (ruling 70)",
    claims.length === 0,
    claims.length === 0
      ? "no line claims a saving; lines that name a lever alongside an explicit disclaimer are exempt, which is the phrasing ruling 70 asks for"
      : `lines claiming a saving: ${excerpt(claims.join(" | "), 200)}`,
  );

  checks.note(
    "cannot be proven here",
    "#45 measured that neither vendor's effort setting is confirmable over the protocol, so 'the effort we asked for is the effort that ran' is asserted from vendor-private records or not at all",
  );
  return checks;
}

const item: BarItem = {
  id: 13,
  title: "The cost model predicts, enforces, and says what it could not see",
  rulings: [66, 67, 70, 35, 23, 21, 29, 30, 31, 40],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n" });
    const items = ["cheap", "declared-hard", "third", "fourth"];
    const seeds = items.map((id) => ({ path: `seeds/${id}.seed`, value: nonce(`${id}-seed`), placement: "committed" as const }));
    await plantSeeds(repo, seeds);
    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: items.map((id, index) => ({
        id,
        kind: "write" as const,
        paths: [`${id}.txt`],
        prompt: `create ${id}.txt`,
        directive: { do: "derive-write" as const, read: `seeds/${id}.seed`, path: `${id}.txt`, salt: id },
        // Ruling 67's clamp must PRINT for this one, and must only go down.
        ...(index === 1 ? { difficulty: "hard" as const } : {}),
      })),
    });
    did.push(`wrote a four-item plan at ${planPath}, one item declaring \`difficulty: hard\` so a clamp has something to print`);

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "qwen", version: "0.21.13" },
      { id: "copilot", version: "1.0.80" },
    ]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });

    // ---- credential-free: predicting costs nothing --------------------------
    const estimate = await probeFeature(
      ctx,
      ["run", "--plan", planPath, "--repo", repo, "--run-root", join(ctx.workdir, "runs-estimate"), "--estimate"],
      { env, timeoutMs: 120_000 },
    );
    did.push(estimate.transcript);
    const credentialFree = new Checks();
    const estimateText = `${estimate.result.stdout}${estimate.result.stderr}`;
    if (!estimate.present) {
      credentialFree.expect("an estimate can be produced before a run", false, estimate.transcript);
    } else {
      credentialFree.expect(
        "the estimate is printed as a RANGE (ruling 66)",
        RANGE.test(estimateText),
        `#44 measured two identical Codex runs at 427,723 and 28,245 bytes — 15×; estimate output: ${excerpt(estimateText, 240)}`,
      );
      credentialFree.expect(
        "the estimate names its provenance",
        /provenance|#44|3–5×|3-5x/i.test(estimateText),
        excerpt(estimateText, 240),
      );
    }

    // ---- live: enforcement, the clamp, and quota ----------------------------
    // Ceilings deliberately below what four items cost, so enforcement has to
    // bite rather than merely print.
    const probe = await probeFeature(
      ctx,
      ["run", "--plan", planPath, "--repo", repo, "--run-root", join(ctx.workdir, "runs"), "--dry-run"],
      { env, timeoutMs: 60_000 },
    );
    did.push(`admission probe: ${probe.transcript}`);

    let live: LiveHalf;
    if (!probe.present) {
      live = { kind: "missing", probe, promise: "no run can be driven, so nothing predicts, nothing enforces a ceiling, and there is no quota line to be absent from" };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "actual-against-predicted requires real spend, and per-vendor quota requires real vendor accounts" };
    } else {
      // A: the same plan, same vendors, NO ceilings.
      const uncappedRepo = join(ctx.workdir, "uncapped-repo");
      await makeRepo(uncappedRepo, { "README.md": "base\n" });
      await plantSeeds(uncappedRepo, seeds);
      const uncapped = await ctx.run(
        ["run", "--plan", planPath, "--repo", uncappedRepo, "--run-root", join(ctx.workdir, "runs-uncapped")],
        { env, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      const uncappedEvidence = await gatherRunEvidence(uncappedRepo, `${uncapped.stdout}${uncapped.stderr}`);
      const uncappedIntegrated = verifyIntegration(uncappedEvidence);

      // B: ceilings deliberately below what four items cost.
      const capped = await ctx.run(
        [
          "run", "--plan", planPath, "--repo", repo,
          "--run-root", join(ctx.workdir, "runs"),
          "--soft-ceiling", "0.06", "--hard-ceiling", "0.14",
        ],
        { env, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      did.push(
        `drove the same plan twice: once with no ceilings (${uncappedIntegrated.claimed} claimed integrated, ` +
          `${uncappedIntegrated.verified} confirmed with git) and once with them`,
      );
      const report = `${capped.stdout}${capped.stderr}`;
      const evidence = await gatherRunEvidence(repo, report);
      const integrated = verifyIntegration(evidence);
      live = {
        kind: "ran",
        checks: judgeCost({
          report,
          record: evidence.record,
          integrated,
          uncappedIntegrated,
          plannedCount: items.length,
        }),
      };
    }

    return combine(did, credentialFree, live);
  },
};

export default item;
