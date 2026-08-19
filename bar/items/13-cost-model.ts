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
 * Underneath it sat a genuine product gap — `cost.actual`, `softCeilingHit` and
 * `hardCeilingHit` declared in the record's type and assigned by nothing — and
 * that half has since been closed: `src/queue/execute.ts` writes `actual` from
 * bytes counted on the wire, and writes both hits unconditionally so that an
 * absent boolean cannot read as "not measured". READ AGAIN ON 2026-08-19 rather
 * than believed: this item is no longer waiting on the product for those three
 * fields, it was waiting on ceilings expressed in the unit the product counts in.
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
 *
 * WHAT THE 2026-08-19 AUDIT FOUND IN THIS ITEM. Four of its checks were looking
 * at the wrong thing, and one of them could never have failed:
 *
 *   THE CEILINGS WERE IN DOLLARS AND THE PRODUCT COUNTS TOKENS. This item drove
 *   `--soft-ceiling 0.06 --hard-ceiling 0.14` against a unit that
 *   `src/queue/estimate.ts` refuses to convert to money for want of a measured
 *   rate. Both ceilings are crossed by the first frame that crosses the wire, so
 *   nothing is dispatched, nothing records a triple, no vendor reaches the quota
 *   block — and every check fails for a reason unrelated to the property it
 *   names. The ceilings are now CALIBRATED from a run that already happened, and
 *   the soft and the hard one are driven as two separate runs, because they are
 *   two events and a single run cannot show one and not the other.
 *
 *   THE OPENCODE CHECK WAS A TAUTOLOGY. `!used.includes("opencode") || …` was
 *   evaluated against a fleet of `qwen` and `copilot`. It has passed on every
 *   run this item has ever driven, and it would pass on a binary with no quota
 *   block at all. opencode is now PLANTED, so #42's branch is exercised.
 *
 *   `levers.length > 0` IS A COUNT, and ruling 70 is about names. `["x"]`
 *   satisfied it. Every lever is now required to reach the report by name.
 *
 *   `/actual/i.test(report)` IS A WORD. "actual: not measured" contains it. The
 *   numbers are now required.
 *
 *   AND THE EFFORT HALF WAS NOT CHECKED AT ALL beyond `effort !== undefined` —
 *   which amendment §19 warns is exactly the shape that misses the regression,
 *   because a record that stringifies an absent value writes the word
 *   `undefined` and passes. `../lib/item13-cost.ts` holds the repair, and it
 *   demonstrates its own instrument on that shape every run.
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
import {
  effortInstrumentControls,
  itemLine,
  judgeCeilings,
  judgeDeepCost,
  judgeEffort,
  type EffortItem,
  type OneRun,
} from "../lib/item13-cost.ts";
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

  // Ruling 29's triple, ruling 40's lever and #45's `effortConfirmed` are NOT
  // here. They were one check — `agent !== undefined && model !== undefined &&
  // effort !== undefined` — which is the shape amendment §19 says cannot see
  // the regression it is about: a record that stringifies an absent value
  // writes the word `undefined` and satisfies it. They live in
  // `../lib/item13-cost.ts`, where the grade is required to be a member of
  // ruling 30's vocabulary and is recomputed from (kind, difficulty).
  //
  // `dispatched` survives because the quota check below is about the vendors
  // that really ran.
  const dispatched = (o.record?.items ?? []).filter((i) => i.status === "integrated" || i.status === "failed");

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
  // ON THE ITEM'S OWN LINE. `report.includes("difficulty: easy")` is satisfied
  // for every item that declared `easy` by whichever one the report happened to
  // print — the same containment defect the 2026-08-19 audit removed from item
  // 11, and one that a plan with two items of one difficulty would walk into.
  const unprinted = clamped.filter((i) => {
    const line = itemLine(o.report, i.id);
    return i.clampedTo === undefined || line === undefined || !line.includes(expectedLine(i));
  });
  checks.expect(
    "the difficulty clamp is recorded per item and printed (ruling 67)",
    clamped.length > 0 && unprinted.length === 0,
    clamped.length === 0
      ? "no item declared a difficulty"
      : `recorded: ${clamped.map((i) => `${i.id}: ${i.difficulty} -> ${i.clampedTo ?? "NOT RECORDED"}`).join("; ")}; ` +
        `absent from their own item's line in the report: ${
          unprinted.map((i) => `${i.id} wanted ${JSON.stringify(expectedLine(i))}, line reads ${JSON.stringify(itemLine(o.report, i.id) ?? "NO LINE FOR THIS ITEM")}`).join("; ") || "none"
        }`,
  );
  // `every` over an empty list is `true`, and `isUpwardClamp` answers `false`
  // for any pair it does not recognise — so the previous form passed on a run
  // that recorded no difficulty at all, and on one that clamped `hard` to
  // `enormous`. Neither is brigadier declining to clamp upward; both are the
  // check having nothing to look at and saying so as a pass.
  const knownDifficulty = (value: string | undefined): boolean =>
    value !== undefined && (DIFFICULTY_ORDER as readonly string[]).includes(value);
  checks.expect(
    "brigadier never clamps UPWARD",
    clamped.length > 0 &&
      clamped.every(
        (i) => knownDifficulty(i.difficulty) && knownDifficulty(i.clampedTo) && !isUpwardClamp(i.difficulty ?? "", i.clampedTo ?? ""),
      ),
    clamped.map((i) => `${i.difficulty} -> ${i.clampedTo}`).join("; ") ||
      "NO CLAMP WAS OBSERVED AT ALL, so this run says nothing about the direction: an empty list satisfies " +
        "`every` and a vocabulary this harness does not recognise satisfies the comparison",
  );

  // Ruling 13's quota half, cross-checked against the vendors that really ran.
  // The stronger form — every vendor the HARNESS planted, and opencode
  // `unpriceable` unconditionally — is in `judgeDeepCost`. This one stays
  // because it asks a different question: not "was every vendor priced" but
  // "was the vendor that took a turn priced", and a router that used something
  // nobody planted would fail here and pass there.
  const used = [...new Set(dispatched.map((i) => i.agent).filter((a): a is string => a !== undefined))];
  const quota = cost?.quota ?? {};
  checks.expect(
    "quota is reported for every vendor that actually ran, as read / unreadable / unpriceable",
    used.length > 0 && used.every((v) => ["read", "unreadable", "unpriceable"].includes(quota[v] ?? "")),
    `vendors that ran: ${used.join(", ") || "none"}; quota block: ${JSON.stringify(quota)}`,
  );

  // Ruling 70.
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
    // Two declared difficulties rather than one, because ruling 67 has two
    // renderings and a fixture that exercises one of them measures half the
    // rule: `hard` must print as clamped (the default ceiling is below it) and
    // `easy` must print unclamped. They also drive two different effort
    // derivations under ruling 31, so an item that recorded one grade for
    // everything would be visible.
    const declared: Record<string, "easy" | "hard"> = { "declared-hard": "hard", third: "easy" };
    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: items.map((id) => ({
        id,
        kind: "write" as const,
        paths: [`${id}.txt`],
        prompt: `create ${id}.txt`,
        directive: { do: "derive-write" as const, read: `seeds/${id}.seed`, path: `${id}.txt`, salt: id },
        // Ruling 67's clamp must PRINT for these, and must only go down.
        ...(declared[id] === undefined ? {} : { difficulty: declared[id] }),
      })),
    });
    did.push(
      `wrote a four-item plan at ${planPath}; \`declared-hard\` declares \`difficulty: hard\` so a clamp has something ` +
        "to print, and `third` declares `easy` so the UNclamped rendering is measured too",
    );

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    // opencode is planted deliberately. #42's clause — a run using opencode says
    // `unpriceable` and its total is a lower bound — was previously judged
    // against a fleet that could not contain it, so the check was true by
    // construction on every run.
    const planted = ["qwen", "copilot", "opencode"] as const;
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "qwen", version: "0.21.13" },
      { id: "copilot", version: "1.0.80" },
      // The version this tree's profile was MEASURED against, so a drift
      // warning is not mistaken for the cost model saying something.
      { id: "opencode", version: "1.18.18" },
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
    // THE INSTRUMENT, DEMONSTRATED RATHER THAN ASSUMED. Amendment §19's field
    // was declared and never assigned for as long as the record existed,
    // because everything that looked at it printed what it found. These rows
    // put this item's own effort reader to that exact shape, every run, in the
    // half that needs no credentials — so a reader of the output can see that
    // the check which passed could also have failed.
    for (const row of effortInstrumentControls().rows) credentialFree.expect(row.name, row.ok, row.detail);
    // And ruling 70's detector, likewise. It once failed the honest fixture on
    // the very sentence ruling 70 asks for.
    credentialFree.expect(
      "the savings-claim detector fires on a claim and not on ruling 70's own required phrasing",
      savingsClaims("this run saved 16.5× on tokens").length === 1 &&
        savingsClaims("the 16.5× cache lever was active — brigadier makes no claim to have saved anything").length === 0,
      "a line claiming a saving is caught; a line naming a lever beside an explicit disclaimer is not — which is " +
        "the phrasing ruling 70 requires, and a check that rejected it would be broken rather than strict",
    );

    // ---- live: enforcement, the clamp, and quota ----------------------------
    // The ceilings are calibrated below, from what the uncapped run actually
    // spent, so that enforcement bites rather than merely printing — and so
    // that it does not fire before the first item is dispatched, which is what
    // a number picked as though tokens were dollars does.
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
      // A: the same plan, same vendors, NO ceilings. This is the baseline the
      // other two are calibrated FROM, and it is also the negative control:
      // neither ceiling line may appear in a run that was given no ceilings.
      const uncappedRepo = join(ctx.workdir, "uncapped-repo");
      await makeRepo(uncappedRepo, { "README.md": "base\n" });
      await plantSeeds(uncappedRepo, seeds);
      const uncapped = await ctx.run(
        ["run", "--plan", planPath, "--repo", uncappedRepo, "--run-root", join(ctx.workdir, "runs-uncapped")],
        { env, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      const uncappedReport = `${uncapped.stdout}${uncapped.stderr}`;
      const uncappedEvidence = await gatherRunEvidence(uncappedRepo, uncappedReport);
      const uncappedIntegrated = verifyIntegration(uncappedEvidence);

      // WHAT FOUR ITEMS ACTUALLY COST, IN THE UNIT THE PRODUCT COUNTS IN.
      //
      // `src/queue/estimate.ts` refuses currency for want of a measured rate,
      // so a ceiling is a number of TOKENS. A pair picked as though it were
      // money — this item drove 0.06 and 0.14 — is crossed by the first frame
      // on the wire, and then nothing is dispatched and every downstream check
      // fails for a reason that has nothing to do with ceilings. So the
      // ceilings come from a run that already happened.
      const spent = uncappedEvidence.record?.cost?.actual;
      did.push(
        `the uncapped run spent ${spent ?? "an unrecorded number of"} ${uncappedEvidence.record?.cost?.currency ?? "units"} ` +
          `across ${items.length} items (${uncappedIntegrated.claimed} claimed integrated, ${uncappedIntegrated.verified} ` +
          "confirmed with git); the two ceilings below are calibrated from that number rather than picked. " +
          "THAT NUMBER IS THE PRODUCT'S OWN: `cost.actual` is measured by the same wire-byte counter the ceiling " +
          "gate compares against, and nothing here corroborates it from outside — #46 measured three of six agents " +
          "emitting no usage at all, so there is no second source. The accounting is taken on trust; what is " +
          "OBSERVED is the behaviour — which items were dispatched, which running work was cancelled, and which of " +
          "the two the report described. And because #44 measured 15× between two identical runs, a ceiling that " +
          "does not fire is reported as either NOT ENFORCED or NEVER REACHED, with the numbers that separate them",
      );

      const checks = new Checks();
      if (spent === undefined || spent < 8) {
        // Said out loud rather than worked around. A ceiling calibrated from a
        // number that is not there is a number this harness made up, and the
        // run it produced would be measuring the harness's guess.
        checks.expect(
          "the uncapped run records what it spent, so a ceiling can be calibrated from it",
          false,
          `cost.actual on the uncapped run: ${spent ?? "ABSENT"}. Ruling 66's ceilings are in tokens, and a ceiling ` +
            "this harness picked out of the air would fire before dispatch or never — neither of which measures enforcement",
        );
        live = { kind: "ran", checks };
        return combine(did, credentialFree, live);
      }

      // B: the SOFT ceiling, set below what the first batch of items costs so
      // that dispatch stops with work left, and paired with a hard ceiling far
      // above anything this plan can reach so that it cannot fire.
      const softCeiling = Math.max(1, Math.floor(spent * 0.4));
      const softRun = await ctx.run(
        [
          "run", "--plan", planPath, "--repo", repo,
          "--run-root", join(ctx.workdir, "runs"),
          "--soft-ceiling", String(softCeiling), "--hard-ceiling", String(spent * 4),
        ],
        { env, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      const report = `${softRun.stdout}${softRun.stderr}`;
      const evidence = await gatherRunEvidence(repo, report);
      const integrated = verifyIntegration(evidence);

      // C: the HARD ceiling, set below what one batch costs so that it fires
      // while items are running. Its own repository, because the two runs are
      // two experiments and a shared deliverable branch would mix them.
      const hardRepo = join(ctx.workdir, "hard-repo");
      await makeRepo(hardRepo, { "README.md": "base\n" });
      await plantSeeds(hardRepo, seeds);
      const hardCeiling = Math.max(2, Math.floor(spent * 0.4));
      const hardRun = await ctx.run(
        [
          "run", "--plan", planPath, "--repo", hardRepo,
          "--run-root", join(ctx.workdir, "runs-hard"),
          "--soft-ceiling", String(Math.max(1, Math.floor(hardCeiling / 2))), "--hard-ceiling", String(hardCeiling),
        ],
        { env, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      const hardReport = `${hardRun.stdout}${hardRun.stderr}`;
      const hardEvidence = await gatherRunEvidence(hardRepo, hardReport);
      did.push(
        `drove the same plan three times: no ceilings; a soft ceiling of ${softCeiling} with the hard one out of reach; ` +
          `and a hard ceiling of ${hardCeiling}. The soft one must stop DISPATCH and the hard one must CANCEL, and ` +
          "one run cannot show both",
      );

      for (const row of judgeCost({
        report,
        record: evidence.record,
        integrated,
        uncappedIntegrated,
        plannedCount: items.length,
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }
      const asRun = (what: string, out: { stdout: string; stderr: string; code: number | null }, ev: { record: RunRecord | undefined }): OneRun => ({
        what,
        report: `${out.stdout}${out.stderr}`,
        record: ev.record,
        exitCode: out.code,
      });
      for (const row of judgeCeilings({
        uncapped: asRun("no ceilings", uncapped, uncappedEvidence),
        soft: asRun("soft ceiling only", softRun, evidence),
        hard: asRun("hard ceiling", hardRun, hardEvidence),
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }
      for (const row of judgeEffort({
        report,
        items: (evidence.record?.items ?? []) as EffortItem[],
        // Ruling 40: none of the three planted vendors has a measured effort
        // lever, and this list is the harness's own — never read back out of
        // the record it is judging.
        leverlessVendors: [...planted],
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }
      for (const row of judgeDeepCost({
        report,
        record: evidence.record,
        plantedVendors: [...planted],
        savingsClaims,
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }
      live = { kind: "ran", checks };
    }

    return combine(did, credentialFree, live);
  },
};

export default item;
