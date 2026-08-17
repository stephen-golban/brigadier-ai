// SPDX-License-Identifier: Apache-2.0
/**
 * Item 11 — The run report fits in a host model's window, and never hides a
 * failure to do it.
 *
 * Rulings 58, 52, 21, 25, 39.
 *
 * The first draft **could never pass**: it called its own judgement with
 * `failingItems: []`, `blockingChecks: []` and `fullRecordPath: ""` while three
 * of the five checks required those to be non-empty. False by construction, and
 * indistinguishable from a product that could not satisfy it.
 *
 * It now drives a **fifty-item** run whose items 4, 18 and 43 are made to fail a
 * verify command that RESOLVES on `PATH` — ruling 52 draws the line between a
 * check that failed and a checker that was missing, and this item needs the
 * former. The harness knows which three must fail because it wrote the plan, so
 * "every failing item still appears" is checked against a list it owns rather
 * than against a list the report supplied.
 *
 * The blocking checks are read out of the run RECORD and each one's name must
 * appear in the report. Ruling 52's rule, stated so a check can hold it: a
 * capped report prints fewer ITEMS and never fewer CHECKS — the cap can hide a
 * success and can never hide a failure.
 *
 * And the full record is verified as a FILE. A report that names a path is
 * making a claim about the disk; the item resolves it, requires it to exist, and
 * requires the transcript on disk to be substantially larger than the report —
 * because "only summaries and the path to the full record" is meaningless if the
 * full record is not there.
 *
 * The measured reason this item exists: #14 recorded ~46 KB of agent→client
 * traffic for a ONE-LINE change, so ten turns is ~115,000 tokens at `chars/4` —
 * a floor, since #23 measured that formula underestimating by 22% — against
 * Copilot's measured 128,000-token window (#46). The correction is therefore
 * applied rather than the naive formula: a budget checked against a number known
 * to be too small is a budget that passes runs it should not.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { gatherRunEvidence } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantVendors } from "../lib/fixtures.ts";
import { ensureDir } from "../lib/fs.ts";
import { makeRepo } from "../lib/git.ts";
import { combine, noCredentialFreeChecks, type LiveHalf } from "../lib/halves.ts";
import { disjointPlan, estimateTokens, writePlan } from "../lib/plan.ts";
import { baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/** Ruling 58, which is ruling 39's repo-map budget reused as a precedent. */
export const HOST_REPORT_TOKEN_CEILING = 2_000;

export interface ReportObservations {
  hostReport: string;
  /** Item ids the HARNESS made fail. Not a list the report supplied. */
  failingItems: string[];
  /** Blocking check names read out of the run record for those items. */
  blockingChecks: string[];
  fullRecordPath: string;
  fullRecordExists: boolean;
  transcriptBytes: number;
}

/** A worker transcript looks like protocol frames or an agent's own prose block. */
const TRANSCRIPT_SHAPE = /"jsonrpc"|session\/update|agent_message_chunk|tool_call_update/;

export function judgeReport(o: ReportObservations): Checks {
  const checks = new Checks();
  const tokens = estimateTokens(o.hostReport);

  checks.expect(
    `a fifty-item run reports under ${HOST_REPORT_TOKEN_CEILING} tokens`,
    tokens <= HOST_REPORT_TOKEN_CEILING,
    `${o.hostReport.length} chars ≈ ${tokens} tokens (chars/4 with #23's measured +22% correction applied)`,
  );
  checks.expect(
    "no worker transcript appears in the host report",
    !TRANSCRIPT_SHAPE.test(o.hostReport),
    TRANSCRIPT_SHAPE.test(o.hostReport)
      ? excerpt(o.hostReport.slice(o.hostReport.search(TRANSCRIPT_SHAPE)), 160)
      : "no protocol frames or transcript markers",
  );
  checks.expect(
    "the report names the full record, and the file is really there",
    o.fullRecordPath.length > 0 && o.fullRecordExists && o.hostReport.includes(o.fullRecordPath),
    `run-record: ${o.fullRecordPath || "NOT NAMED"}; exists on disk: ${o.fullRecordExists}`,
  );
  checks.expect(
    "the full record on disk is substantially larger than the report",
    o.transcriptBytes > o.hostReport.length * 2,
    `transcript ${o.transcriptBytes} bytes vs report ${o.hostReport.length} chars — "summaries and the path to the full record" means nothing if the full record is not bigger`,
  );
  checks.expect(
    "every failing item still appears under the cap (ruling 52)",
    o.failingItems.length > 0 && o.failingItems.every((id) => o.hostReport.includes(id)),
    `the harness made ${o.failingItems.join(", ") || "no"} item(s) fail; missing from the report: ${o.failingItems.filter((id) => !o.hostReport.includes(id)).join(", ") || "none"}`,
  );
  checks.expect(
    "every blocking check of a failing item appears",
    o.blockingChecks.length > 0 && o.blockingChecks.every((c) => o.hostReport.includes(c)),
    `blocking checks from the record: ${o.blockingChecks.join(", ") || "none"}; missing: ${o.blockingChecks.filter((c) => !o.hostReport.includes(c)).join(", ") || "none"}`,
  );
  checks.expect(
    "passing items collapsed to a count rather than being printed",
    /collapsed/i.test(o.hostReport),
    `looked for a collapse line; report: ${excerpt(o.hostReport, 200)}`,
  );
  return checks;
}

const item: BarItem = {
  id: 11,
  title: "The run report fits in a host model's window, and never hides a failure to do it",
  rulings: [58, 52, 21, 25, 39],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n" });

    // Fifty items, three of which must fail — with a verify command that
    // RESOLVES, so this is a failing CHECK and not a missing checker.
    const fifty = disjointPlan(50, "fifty");
    const failing = ["fifty-4", "fifty-18", "fifty-43"];
    const failer = process.platform === "win32" ? "cmd /c exit 1" : "false";
    for (const id of failing) {
      const target = fifty.plan.items.find((i) => i.id === id);
      if (target) target.verify = failer;
    }
    const planPath = writePlan(ctx.workdir, fifty.plan);
    did.push(`wrote a fifty-item plan at ${planPath}; items ${failing.join(", ")} verify with \`${failer}\`, which resolves on PATH and exits non-zero`);

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantVendors(binDir, [{ id: "codex", version: "1.4.0" }, { id: "qwen", version: "0.21.13" }]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });

    const probe = await probeFeature(
      ctx,
      ["run", "--plan", planPath, "--repo", repo, "--run-root", join(ctx.workdir, "runs"), "--audience", "host-session"],
      { env, timeoutMs: 600_000 },
    );
    did.push(probe.transcript);

    let live: LiveHalf;
    if (!probe.present) {
      live = {
        kind: "missing",
        probe,
        promise: `no run can be driven, so there is no host-session report to measure against the ${HOST_REPORT_TOKEN_CEILING}-token ceiling`,
      };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "fifty real items must actually run for the report to have fifty items to collapse" };
    } else {
      const report = probe.result.stdout;
      const evidence = await gatherRunEvidence(repo, `${report}${probe.result.stderr}`);
      const blocking = (evidence.record?.items ?? [])
        .filter((i) => failing.includes(i.id))
        .flatMap((i) => (i.checks ?? []).filter((c) => c.blocking && c.outcome !== "pass").map((c) => c.name));
      const transcripts = evidence.record?.transcriptsPath;
      const transcriptFile = transcripts === undefined ? "" : join(transcripts, "full.log");

      live = {
        kind: "ran",
        checks: judgeReport({
          hostReport: report,
          failingItems: failing,
          blockingChecks: [...new Set(blocking)],
          fullRecordPath: evidence.recordPath ?? "",
          fullRecordExists: evidence.recordExists,
          transcriptBytes: transcriptFile.length > 0 && existsSync(transcriptFile) ? statSync(transcriptFile).size : 0,
        }),
      };
    }

    return combine(did, noCredentialFreeChecks(), live);
  },
};

export default item;
