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
 * The blocking checks are read out of the run RECORD and each one must appear
 * inside its own item's block in the report, with its outcome. Ruling 52's
 * rule, stated so a check can hold it: a capped report prints fewer ITEMS and
 * never fewer CHECKS — the cap can hide a success and can never hide a failure.
 *
 * And a SECOND, SMALLER RUN drives the one path the fifty-item run cannot
 * reach: every item failing, with a chatty verify command, so that the blocking
 * set alone exceeds the ceiling and the product has to choose between ruling 58
 * and ruling 52. It goes over and says so. That run deliberately does not
 * assert the ceiling, and the reason is written on the check.
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
 *
 * WHAT THE 2026-08-19 AUDIT FOUND IN THIS ITEM, because the fixes below are
 * worth nothing if the reason for them is not written where the next reader is:
 *
 *   `hostReport.includes(id)` CANNOT SEE THE CAP HIDE `fifty-4`, because the
 *   fixture also fails `fifty-43` and `"fifty-43".includes("fifty-4")` is true.
 *   The one item most likely to be dropped first was the one the check could not
 *   miss. Every containment test now runs against the BLOCK the report devotes
 *   to one item — see `../lib/item11-structure.ts`.
 *
 *   `hostReport.includes(checkName)` IS VACUOUS FOR THE ONLY CHECK THIS ITEM
 *   MAKES FAIL. The product's per-item verify check is named `verify`, and the
 *   report's own tail carries *"the merged result was verified"*. The check
 *   passed on reports that printed no per-item check at all.
 *
 *   `/collapsed/i` IS A WORD, NOT A PROPERTY. It passes on any report that
 *   happens to use it. What is asserted now is the arithmetic: how many passing
 *   items the report did not print, and that the number it names is that one.
 *
 *   "NO WORKER TRANSCRIPT APPEARS" HAD NO POSITIVE CONTROL. An absence measured
 *   with a pattern nothing matches is the instrument reporting on itself, so the
 *   same pattern is now required to fire on the transcript the run wrote to disk.
 *
 *   THE ITEM GRADED NOTHING WITHOUT CREDENTIALS. It called `noCredentialFreeChecks()`
 *   while two of ruling 58's clauses — there is no `--verbose` in host mode, and
 *   the ceiling is on the CHANNEL rather than on the report alone — are decidable
 *   from a `--dry-run` that starts nothing. `bar/lib/halves.ts` exists because
 *   five items did exactly this; this was the sixth.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import type { RecordItem } from "../lib/contract.ts";
import { gatherRunEvidence, proofOfWork } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir, listTree, writeScript } from "../lib/fs.ts";
import { makeRepo, plantSeeds } from "../lib/git.ts";
import { combine, type LiveHalf } from "../lib/halves.ts";
import { runSampled } from "../lib/inflight.ts";
import { judgeOverride, judgeReportStructure, readSlotEvents, type RecordedItem } from "../lib/item11-structure.ts";
import { disjointPlan, estimateTokens, writePlan } from "../lib/plan.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/** Ruling 58, which is ruling 39's repo-map budget reused as a precedent. */
export const HOST_REPORT_TOKEN_CEILING = 2_000;

/**
 * What this judgement still owns after the 2026-08-19 audit: the ceiling, the
 * absence of a transcript, and the full record as a FILE.
 *
 * `failingItems` and `blockingChecks` are gone from here rather than kept
 * beside their replacements. They fed three substring tests that could not fail
 * — `includes("fifty-4")` is satisfied by `fifty-43`, `includes("verify")` by
 * the tail sentence *"the merged result was verified"*, and `/collapsed/i` by
 * the word itself. A vacuous check sitting beside a real one is worse than one
 * sitting alone: it passes, it reads as coverage, and the next reader cannot
 * tell which of the two is load-bearing. The properties they claimed are in
 * `../lib/item11-structure.ts`, asserted against the block the report devotes
 * to each item.
 */
export interface ReportObservations {
  hostReport: string;
  fullRecordPath: string;
  fullRecordExists: boolean;
  transcriptBytes: number;
  /** How many of the failing items the on-disk record actually mentions. */
  transcriptMentions: number;
  failingCount: number;
}

/**
 * A worker transcript looks like protocol frames or an agent's own prose block.
 *
 * EXPORTED so the item can put it to the transcript on disk. A pattern that
 * matches nothing passes "no transcript appears" against every report ever
 * written, and there is no way to tell that apart from a product that keeps
 * transcripts out of the host session — except by showing the pattern firing on
 * a transcript that really exists.
 */
/**
 * One line of a deliberately talkative verify command.
 *
 * ASCII only and no shell metacharacters: this string is embedded in a `sh`
 * script and in a `.cmd` one, and a parenthesis inside `echo` is a syntax error
 * in the second.
 */
function verboseVerifyLine(n: number): string {
  // DELIBERATELY SAYS NOTHING THE JUDGEMENT LOOKS FOR. MEASURED on 2026-08-19:
  // an earlier version of this line used the words *over* and *ceiling*, and
  // `src/gate/run.ts` carries the checker's own last lines into the failing
  // check's detail — so the harness printed the sentence it was about to go
  // looking for, and the negative control that deleted the PRODUCT's statement
  // still passed. A fixture that supplies the detector's needle is the
  // instrument measuring itself.
  return (
    `filler line ${n} of 12 from a deliberately talkative checker, long enough that a handful of failing ` +
    "items cost more to print than a run of fifty passing ones, and carrying no word this item searches for."
  );
}

export const TRANSCRIPT_SHAPE = /"jsonrpc"|session\/update|agent_message_chunk|tool_call_update/;

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
  // Size is not content. A forger's "full record" was 60 KB of repeated filler,
  // which is larger than the report and says nothing about the run.
  checks.expect(
    "the full record on disk is about THIS run, not filler",
    o.transcriptMentions === o.failingCount,
    `the on-disk record mentions ${o.transcriptMentions} of the ${o.failingCount} failing items by id — a large file that names none of them is padding`,
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
    await plantSeeds(repo, fifty.seeds);
    const failing = ["fifty-4", "fifty-18", "fifty-43"];
    // A verify command that leaves a WITNESS when it runs. "Items that carry a
    // verify field" is not the same as "items whose verify was executed", and
    // the previous version could not tell them apart.
    const witnessDir = ensureDir(join(ctx.workdir, "verify-witness"));
    const failer = writeScript(
      join(ctx.workdir, "failing-verify"),
      `#!/bin/sh\ntouch ${JSON.stringify(join(witnessDir, "ran"))}.$$\nexit 1\n`,
      `@echo off\r\ntype nul > ${join(witnessDir, "ran")}.%RANDOM%\r\nexit /b 1\r\n`,
    );
    for (const id of failing) {
      const target = fifty.plan.items.find((i) => i.id === id);
      if (target) target.verify = failer;
    }
    const planPath = writePlan(ctx.workdir, fifty.plan);
    did.push(`wrote a fifty-item plan at ${planPath}; items ${failing.join(", ")} verify with ${failer}, which resolves on PATH, writes a witness and exits non-zero`);

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "qwen", version: "0.21.13" },
      { id: "copilot", version: "1.0.80" },
    ]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });
    const runs = ensureDir(join(ctx.workdir, "runs"));

    const dryArgs = ["run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--dry-run"];
    const probe = await probeFeature(ctx, dryArgs, { env, timeoutMs: 60_000 });
    did.push(`admission probe: ${probe.transcript}`);

    // ---- credential-free: two of ruling 58's clauses cost nothing to decide --
    //
    // A `--dry-run` starts no process and creates no directory, so both of these
    // are answerable on the CI leg BAR.md calls authoritative — which has no
    // vendor credentials by construction and used to grade this item at zero.
    const credentialFree = new Checks();
    const usage = await ctx.run(["run"], { env, timeoutMs: 60_000 });
    const usageText = `${usage.stdout}${usage.stderr}`;
    credentialFree.expect(
      "the binary offers no `--verbose` at all (ruling 58: there is none in host mode to reach for)",
      usageText.length > 0 && !/--verbose/.test(usageText),
      usageText.length === 0
        ? "`brigadier run` with no plan printed NOTHING, so there is no usage text to read this out of"
        : `usage text is ${usageText.length} chars and does not offer --verbose: ${!/--verbose/.test(usageText)}`,
    );
    const hostDry = await ctx.run(dryArgs, { env, timeoutMs: 60_000 });
    const verboseDry = await ctx.run([...dryArgs, "--verbose"], { env, timeoutMs: 60_000 });
    const terminalDry = await ctx.run([...dryArgs, "--audience", "terminal"], { env, timeoutMs: 60_000 });
    // THE POSITIVE CONTROL FOR THE COMPARISON ITSELF, and it is asked FIRST.
    // "adding --verbose changed nothing" is worth nothing from an instrument
    // that cannot see a change: if these two runs are byte-identical too, the
    // comparison below is measuring a binary that ignores its whole command
    // line, and the item must say so rather than record a pass.
    credentialFree.expect(
      "the audience really does change what a host session is charged for (the POSITIVE CONTROL for the test below)",
      hostDry.code === 0 && terminalDry.code === 0 && terminalDry.stdout !== hostDry.stdout,
      `host-session ${hostDry.stdout.length} chars (exit ${hostDry.code}) vs terminal ${terminalDry.stdout.length} chars ` +
        `(exit ${terminalDry.code}); different: ${terminalDry.stdout !== hostDry.stdout}`,
    );
    credentialFree.expect(
      "`--verbose` buys a host session nothing — the same bytes, to the character (ruling 58)",
      hostDry.code === 0 && verboseDry.code === 0 && verboseDry.stdout === hostDry.stdout,
      `without --verbose: ${hostDry.stdout.length} chars (exit ${hostDry.code}); with it: ${verboseDry.stdout.length} ` +
        `chars (exit ${verboseDry.code}); identical: ${verboseDry.stdout === hostDry.stdout}`,
    );
    // Ruling 58's ceiling is on the CHANNEL, not on the report alone: every byte
    // this process writes lands in the same window and is charged once. A
    // fifty-item admission block that spent the budget before the report existed
    // is the measured shape — 3,682 tokens against 2,000, of which 1,648 were
    // this block — so it is checked here, where it costs nothing to check.
    const prologueTokens = estimateTokens(hostDry.stdout);
    credentialFree.expect(
      `a fifty-item admission block into a host session is itself under ${HOST_REPORT_TOKEN_CEILING} tokens`,
      hostDry.code === 0 && prologueTokens <= HOST_REPORT_TOKEN_CEILING,
      `${hostDry.stdout.length} chars ≈ ${prologueTokens} tokens on stdout before any run started — the ceiling is on ` +
        "everything this process writes to the window, and a prologue that spends it leaves the report nothing",
    );

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
      const sampled = await runSampled(
        [ctx.binary, "run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--audience", "host-session"],
        { cwd: ctx.workdir, env, runRoot: runs, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      const report = sampled.stdout;
      const evidence = await gatherRunEvidence(repo, `${report}${sampled.stderr}`);
      const recorded = evidence.record?.items ?? [];
      // THE TRANSCRIPT IS NAMED, NOT SEARCHED FOR.
      //
      // An earlier version of this audit widened it to "the largest file in the
      // directory the record named", so that a renamed file would not read as a
      // missing one. That is acceptance broadening on the detector whose whole
      // job is to prove no transcript reached the report, and a detector that
      // accepts more is a detector that proves less: the largest file in that
      // directory might be anything. `src/queue/execute.ts` writes
      // `<transcriptsPath>/full.log`, so that is the name, and a product that
      // renames it fails here — loudly, with the directory listed, which is
      // exactly the diagnosable failure the widening was trying to avoid.
      const transcripts = evidence.record?.transcriptsPath;
      const transcriptFile = transcripts === undefined ? "" : join(transcripts, "full.log");
      const transcriptText =
        transcriptFile.length > 0 && existsSync(transcriptFile) ? readFileSync(transcriptFile, "utf8") : "";
      if (transcriptText.length === 0) {
        did.push(
          `no transcript at ${transcriptFile || "a path the record never named"}; that directory holds: ` +
            `${(transcripts === undefined || !existsSync(transcripts) ? [] : listTree(transcripts)).join(", ") || "nothing"}`,
        );
      }

      const checks = new Checks();
      // Fifty items really ran. Without this the cap is being measured on a
      // report of nothing.
      checks.absorb(proofOfWork(evidence, {
        // The three items whose verify must fail are deliberately excluded: a
        // failing item must NOT reach the branch, so expecting its output would
        // be asserting the opposite of what this run is testing.
        expected: new Map([...fifty.expected].filter(([p]) => !failing.some((id) => p.startsWith(`${id}.`))).slice(0, 5)),
        itemIds: fifty.itemIds.filter((id) => !failing.includes(id)).slice(0, 5),
        flight: sampled.flight,
        expectedWorkers: 50,
      }));
      const witnesses = listTree(witnessDir).length;
      checks.expect(
        "the verify command was really EXECUTED, not merely declared",
        witnesses >= failing.length,
        `${witnesses} witness file(s) written by the verify command against ${failing.length} items that carry one — ` +
          "carrying a `verify` field is not the same as having run it",
      );
      checks.absorb(judgeReport({
          hostReport: report,
          fullRecordPath: evidence.recordPath ?? "",
          fullRecordExists: evidence.recordExists,
          transcriptBytes: transcriptFile.length > 0 && existsSync(transcriptFile) ? statSync(transcriptFile).size : 0,
          transcriptMentions: failing.filter((id) => transcriptText.includes(id)).length,
          failingCount: failing.length,
        }));

      // The half the judgement above cannot reach: WHERE each failure is
      // printed, whether the cap actually bit, whether the slot was opened
      // before the check ran, and whether the run reported success anyway.
      //
      // The appended NDJSON lives beside the JSON record the report points at.
      // Located from that pointer rather than from a guess about the run root's
      // layout: the pointer is the one path the product promises.
      const ndjsonPath = evidence.recordPath === undefined ? "" : join(dirname(evidence.recordPath), "record.ndjson");
      const slots = ndjsonPath.length > 0 && existsSync(ndjsonPath) ? readSlotEvents(readFileSync(ndjsonPath, "utf8")) : [];
      did.push(
        `read the appended record at ${ndjsonPath || "NO POINTER"} (${slots.length} check-slot/check-settled event(s)) ` +
          `and the transcript at ${transcriptFile || "NOT NAMED"}`,
      );
      const failingRows = recordedRows(recorded, failing);
      checks.absorb(judgeReportStructure({
        report,
        exitCode: sampled.code,
        failing: failingRows,
        passingIds: fifty.itemIds.filter((id) => !failing.includes(id)),
        allIds: recorded.map((i) => i.id),
        slots,
        transcriptHasFrames: TRANSCRIPT_SHAPE.test(transcriptText),
      }));

      // ---- the override, which the fifty-item run cannot reach -------------
      //
      // `capItems` drops passing items until the report fits and STOPS at the
      // blocking set. When the blocking items alone exceed the budget the
      // product must choose between ruling 58's ceiling and ruling 52's "no
      // exception for space", and it goes over and says so. Three failures out
      // of fifty fit comfortably, so that run never asks the question.
      //
      // Six items, all failing, with a verify command that TALKS: `src/gate/run.ts`
      // carries the checker's last lines into the failing check's detail, so the
      // blocking set is put over the ceiling by six workers rather than fifty.
      const pressureRepo = join(ctx.workdir, "pressure-repo");
      await makeRepo(pressureRepo, { "README.md": "base\n" });
      const pressure = disjointPlan(6, "pressure");
      await plantSeeds(pressureRepo, pressure.seeds);
      const chatty = writeScript(
        join(ctx.workdir, "chatty-verify"),
        `#!/bin/sh\n${Array.from({ length: 12 }, (_, i) => `echo "${verboseVerifyLine(i + 1)}"`).join("\n")}\nexit 1\n`,
        `@echo off\r\n${Array.from({ length: 12 }, (_, i) => `echo ${verboseVerifyLine(i + 1)}`).join("\r\n")}\r\nexit /b 1\r\n`,
      );
      for (const target of pressure.plan.items) target.verify = chatty;
      const pressurePlan = writePlan(ctx.workdir, pressure.plan, "pressure-plan.json");
      const pressureRuns = ensureDir(join(ctx.workdir, "runs-pressure"));
      const pressureRun = await ctx.run(
        ["run", "--plan", pressurePlan, "--repo", pressureRepo, "--run-root", pressureRuns, "--audience", "host-session"],
        { cwd: ctx.workdir, env, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      const pressureReport = pressureRun.stdout;
      const pressureEvidence = await gatherRunEvidence(pressureRepo, `${pressureReport}${pressureRun.stderr}`);
      const pressureRecorded = pressureEvidence.record?.items ?? [];
      did.push(
        `drove a second run of ${pressure.itemIds.length} items, every one of them failing a verify command that ` +
          `prints 12 lines, so the blocking set alone had to exceed the ${HOST_REPORT_TOKEN_CEILING}-token ceiling: ` +
          `${pressureReport.length} chars ≈ ${estimateTokens(pressureReport)} tokens, exit ${pressureRun.code}`,
      );
      checks.absorb(judgeOverride({
        report: pressureReport,
        exitCode: pressureRun.code,
        failing: recordedRows(pressureRecorded, pressure.itemIds),
        allIds: pressureRecorded.map((i) => i.id),
        ceiling: HOST_REPORT_TOKEN_CEILING,
        tokens: estimateTokens(pressureReport),
      }));
      live = { kind: "ran", checks };
    }

    return combine(did, credentialFree, live);
  },
};

/**
 * The record's own rows for a set of item ids, in the shape the structural
 * judgement reads.
 *
 * `qualifier` is read straight off `RecordCheck` since the reconciliation pass
 * put it there; it used to be cast in, because the shared contract had never
 * transcribed the field and ruling 52 puts the qualifier INSIDE the result
 * string, so an item that could not see it could not hold the rule.
 */
function recordedRows(recorded: readonly RecordItem[], ids: readonly string[]): RecordedItem[] {
  return recorded
    .filter((i) => ids.includes(i.id))
    .map((i) => ({
      id: i.id,
      ...(i.number === undefined ? {} : { number: i.number }),
      ...(i.status === undefined ? {} : { status: i.status }),
      checks: (i.checks ?? []).map((c) => ({
        name: c.name,
        outcome: c.outcome,
        blocking: c.blocking,
        ...(c.qualifier === undefined ? {} : { qualifier: c.qualifier }),
      })),
    }));
}

export default item;
