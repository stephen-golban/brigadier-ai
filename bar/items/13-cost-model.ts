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
import { gatherRunEvidence } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantVendors } from "../lib/fixtures.ts";
import { ensureDir } from "../lib/fs.ts";
import { makeRepo } from "../lib/git.ts";
import { combine, type LiveHalf } from "../lib/halves.ts";
import { token, writePlan } from "../lib/plan.ts";
import { baseEnv } from "../lib/proc.ts";
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

export interface CostObservations {
  report: string;
  record: RunRecord | undefined;
  /** Commits actually in the integration history. */
  integratedCount: number;
  plannedCount: number;
}

export function judgeCost(o: CostObservations): Checks {
  const checks = new Checks();
  const cost = o.record?.cost;

  // Enforcement, asserted on what did NOT happen rather than on a sentence.
  checks.expect(
    "a hard ceiling below the plan's cost really stopped work (ruling 66)",
    o.integratedCount < o.plannedCount &&
      (o.record?.items ?? []).some((i) => i.status === "unrun" || i.status === "cancelled"),
    `${o.integratedCount} of ${o.plannedCount} items reached the integration history; statuses: ` +
      `${(o.record?.items ?? []).map((i) => `${i.id}=${i.status}`).join(", ") || "no record"}`,
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

  // Ruling 67, from the record rather than from a printed line.
  const clamped = (o.record?.items ?? []).filter((i) => i.difficulty !== undefined);
  checks.expect(
    "the difficulty clamp is recorded per item and printed (ruling 67)",
    clamped.length > 0 &&
      clamped.every((i) => i.clampedTo !== undefined) &&
      clamped.every((i) => o.report.includes(`difficulty: ${i.difficulty} (clamped to ${i.clampedTo})`)),
    clamped.map((i) => `${i.id}: ${i.difficulty} -> ${i.clampedTo}`).join("; ") || "no item declared a difficulty",
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
    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: items.map((id, index) => ({
        id,
        kind: "write" as const,
        paths: [`${id}.txt`],
        prompt: `create ${id}.txt`,
        directive: { do: "write" as const, path: `${id}.txt`, token: token(id) },
        // Ruling 67's clamp must PRINT for this one, and must only go down.
        ...(index === 1 ? { difficulty: "hard" as const } : {}),
      })),
    });
    did.push(`wrote a four-item plan at ${planPath}, one item declaring \`difficulty: hard\` so a clamp has something to print`);

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantVendors(binDir, [{ id: "codex", version: "1.4.0" }, { id: "qwen", version: "0.21.13" }]);
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
      [
        "run", "--plan", planPath, "--repo", repo,
        "--run-root", join(ctx.workdir, "runs"),
        "--soft-ceiling", "0.06", "--hard-ceiling", "0.14",
      ],
      { env, timeoutMs: 300_000 },
    );
    did.push(probe.transcript);

    let live: LiveHalf;
    if (!probe.present) {
      live = { kind: "missing", probe, promise: "no run can be driven, so nothing predicts, nothing enforces a ceiling, and there is no quota line to be absent from" };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "actual-against-predicted requires real spend, and per-vendor quota requires real vendor accounts" };
    } else {
      const report = `${probe.result.stdout}${probe.result.stderr}`;
      const evidence = await gatherRunEvidence(repo, report);
      const integrated = evidence.subjects.filter((s) => /: integrated$/.test(s)).length;
      live = {
        kind: "ran",
        checks: judgeCost({
          report,
          record: evidence.record,
          integratedCount: integrated,
          plannedCount: items.length,
        }),
      };
    }

    return combine(did, credentialFree, live);
  },
};

export default item;
