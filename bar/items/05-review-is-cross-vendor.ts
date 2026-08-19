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
 * **THE PLANT FOLLOWS THE ROUTING, and that is now enforced.** MEASURED on this
 * host on 2026-08-19: this item planted defect-catching capability on the vendor
 * `copilot` and configured it to spot three of the five markers. brigadier
 * routes the first resolved agent as the BUILDER and picks a reviewer from the
 * competence table (`chooseReviewer`), and it routed `copilot` to build and
 * `qwen` to review. The capability therefore sat on the builder; the reviewer
 * had none; the run published `catch rate 0 of 5`, and that number was relayed
 * to the owner as a falsification of ruling 52 before it was caught.
 *
 * Every other harness defect found in this project announced itself by breaking
 * something. This one rendered as a clean measurement. So the item now runs in
 * two phases: a ROUTING run that plants nothing and no denominator — so it can
 * publish no rate at all — whose record and ledger say who reviews; and the
 * MEASURED run, whose plant is configured on that vendor. `bar/lib/item5-routing.ts`
 * then asserts the vendor carrying the plant IS the vendor the measured record
 * names as reviewer. When they disagree the item reports an `error` that blocks
 * under ruling 52 and the number is WITHHELD — a misrouted plant must never be
 * able to render as a measurement again.
 *
 * **THE FIXTURE LEG PUBLISHES NO CATCH RATE, and that is a correction.** A blind
 * critic found the passing-side twin of the misroute on 2026-08-19: with the
 * plant on the right vendor, `FIXTURE_CAN_SPOT` and `CATCH_THRESHOLD.caught`
 * were the same number and the plumbing check demanded set equality against
 * those same markers — so the item passed if and only if the rate was exactly
 * `3 of 5`. It could not exceed the threshold and it could not fall below it
 * without failing, and it landed on the digit a reader parses as *cleared*.
 * `BAR.md` says this item is where ruling 52's assumption is falsified or
 * confirmed **in public, by a verifier that did not make it**; a number that
 * cannot move in either direction does neither. A fixture catching markers this
 * harness pre-loaded into it measures the fixture.
 *
 * So the two legs are separated and labelled:
 *
 *   **the fixture leg** — everything below — proves the PLUMBING: cross-vendor
 *   routing, the reviewer-identity control, `error` blocking, and that the
 *   identities a reviewer FOUND survive builder → diff → reviewer → record. It
 *   runs without `--planted`, so the product prints its no-denominator sentence
 *   and no rate exists to be quoted. An assertion below fails if one appears;
 *
 *   **the catch rate belongs to the VERIFIER**, per `BAR.md` item 5 as AMENDED
 *   by the owner on 2026-08-19. It is not an unmet promise, it is reassigned:
 *   the count is of distinct quoted identifiers present in the diff and is never
 *   matched to the planted set, so an automated number would be the harness
 *   grading itself. The verifier plants its own five defects, drives the real
 *   fleet on a real `PATH` with prose-only prompts, and scores what the reviewer
 *   actually said — from the artefact `bar/lib/item5-verifier-transcript.ts`
 *   records. That recorder is behind an explicit spend flag, is never invoked by
 *   this item, and records without scoring.
 *
 * **Whose defects these are, said plainly:** `BAR.md` gives the planting to the
 * INDEPENDENT VERIFIER, on the grounds that a builder's planted defect tests
 * only what the builder already thought of. What runs here is a mechanised
 * stand-in that keeps the PLUMBING honest between verifier visits. It does not
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
import { rehearseBuilderTurn, type Rehearsal } from "../lib/denominator.ts";
import { makeRepo, plantSeeds } from "../lib/git.ts";
import { combine, type LiveHalf } from "../lib/halves.ts";
import { fleetFor, judgePlantRouting, nameDiff, readRouting } from "../lib/item5-routing.ts";
import { VERIFIER_ENTRY, VERIFIER_NEEDS, rateIn } from "../lib/item5-verifier-transcript.ts";
import { readLedger, vendorsIn } from "../lib/ledger.ts";
import { token, writePlan } from "../lib/plan.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/** v1's measured baseline, printed beside whatever this run produces. */
export const V1_CATCH_BASELINE = "0 of 3";
export const CATCH_THRESHOLD = { caught: 3, planted: 5 };

/**
 * How many of the planted markers the FIXTURE reviewer is configured to spot.
 *
 * A property of the instrument and nothing else. It is deliberately FEWER than
 * the number planted, because the plumbing assertion this leg makes is that the
 * record reports what the reviewer FOUND rather than what the harness planted —
 * a fixture that could see all five would make those two indistinguishable.
 *
 * It is not a catch rate and this leg publishes none. It was one, briefly, and
 * that was the defect: it equalled `CATCH_THRESHOLD.caught`, so the item could
 * only pass at exactly `3 of 5` — a constant wearing a measurement's clothes,
 * landing on the digit a reader parses as *cleared*.
 */
export const FIXTURE_CAN_SPOT = 3;

/**
 * The two vendors this item plants, with no role attached to either.
 *
 * Which one builds and which one reviews is the PRODUCT's decision, read back
 * out of the run record. Attaching a role here is the 2026-08-19 defect.
 */
const PLANTED_VENDORS = [
  { id: "qwen", version: "0.21.13" },
  { id: "copilot", version: "1.0.80" },
] as const;

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

/** The evidence class a row must declare. A row without one cites nothing. */
const EVIDENCE_CLASS = /\b(measured|reported|published|editorial|assumed|vendor)\b/i;

/**
 * What a row offers as its CITATION: everything after its evidence class.
 *
 * Ruling 68 is cite-by-identity, so the citation has to be located before it can
 * be judged. The previous version never located it — it tested the whole row for
 * an anchor pattern, which is why "no citation is a line anchor" passed on a
 * table whose citations had vanished entirely. An empty string here is the
 * failure, not a pass.
 */
export function citationOf(row: string): string {
  const match = EVIDENCE_CLASS.exec(row);
  if (match === null) return "";
  return row
    .slice(match.index + match[0].length)
    .replace(/^[\s:\u2014-]+/, "")
    .trim();
}

/** The part of a row that carries its identity and its score. */
function headOf(row: string): string {
  const match = EVIDENCE_CLASS.exec(row);
  return match === null ? row : row.slice(0, match.index);
}

/** The agent identity a row names — the thing ruling 68 says may never go missing. */
export function agentOf(row: string): string {
  return row.trim().split(/\s+/)[0] ?? "";
}

const UNRANKED = /\bunranked\b/i;

/** Which half of the table a row sits in, so "sorts last" is asked per section. */
function roleOf(head: string): string {
  if (/\breviewer\b/i.test(head)) return "reviewer";
  if (/\bbuilder\b/i.test(head)) return "builder";
  return "unsectioned";
}

/**
 * A citation with enough in it to be one.
 *
 * Not a judgement about quality — a presence test that a blank, a dash or a
 * lone punctuation mark fails. `BAR.md`'s rule is that a row carries its class
 * AND its citation together; a row that carries only the word `editorial` is
 * the shape ruling 68 exists to forbid.
 */
function substantive(citation: string): boolean {
  // A bare ticket is a complete citation — `#46` says exactly which measurement
  // — so an identity token counts on its own. Everything else has to be long
  // enough to be a reason rather than a dash.
  if (/#\d+|https?:\/\/|\bruling\s+\d+/i.test(citation)) return true;
  return citation.replace(/[^A-Za-z0-9]/g, "").length >= 8;
}

export function judgeCompetence(o: CompetenceObservations): Checks {
  const checks = new Checks();
  const rows = o.stdout.split("\n").filter((l) => l.trim().length > 0 && !/^\s*#/.test(l));

  checks.expect(
    "`brigadier competence` prints rows",
    o.code === 0 && rows.length > 0,
    `exit ${o.code}; ${rows.length} non-blank lines; stdout: ${excerpt(o.stdout, 240)}; stderr: ${excerpt(o.stderr, 200)}`,
  );

  const uncited = rows.filter((r) => !EVIDENCE_CLASS.test(r) || !substantive(citationOf(r)));
  checks.expect(
    "every row carries an evidence class and a citation",
    rows.length > 0 && uncited.length === 0,
    uncited.length === 0
      ? `${rows.length} row(s), each with an evidence class and a citation of substance; first citation: ${excerpt(citationOf(rows[0] ?? ""), 120)}`
      : `rows with no evidence class or no citation behind it: ${excerpt(uncited.join(" | "), 240)}`,
  );

  // The anchor test now runs over the CITATIONS, and requires there to BE one
  // per row. A table that stopped citing altogether used to pass this check,
  // which is a check reporting success for something it never examined — the
  // defect this whole harness exists to remove.
  // Filtered by `substantive`, not by `length > 0`: a row reduced to
  // `(editorial)` yields the citation `)`, which is non-empty, carries no
  // anchor, and would let this check pass on a table that cites nothing.
  const citations = rows.map(citationOf).filter(substantive);
  const anchored = citations.filter(isLineAnchor);
  checks.expect(
    "no citation is a line anchor (ruling 68)",
    rows.length > 0 && citations.length === rows.length && anchored.length === 0,
    citations.length !== rows.length
      ? `only ${citations.length} of ${rows.length} row(s) carry a citation at all — an absent citation is not an unanchored one`
      : anchored.length === 0
        ? `examined ${citations.length} citation(s), e.g. ${excerpt(citations.slice(0, 2).join(" | "), 160)}`
        : `line-anchored: ${excerpt(anchored.join(" | "), 240)}`,
  );

  // Ruling 68 is cite-by-IDENTITY, and so is this: the unranked row has to NAME
  // the model it could not rank. `/unranked/` appearing anywhere in stdout was
  // satisfied by the table's own prose explaining what unranked means.
  const unranked = rows.filter((r) => UNRANKED.test(headOf(r)));
  const namedUnranked = unranked.filter((r) => {
    const name = agentOf(r);
    return name.length > 0 && /[A-Za-z]/.test(name) && !UNRANKED.test(name);
  });
  checks.expect(
    "a model the table has never heard of is named rather than silently excluded",
    unranked.length > 0 && namedUnranked.length === unranked.length,
    unranked.length === 0
      ? `no row carries an \`unranked\` score, so nothing the table has never heard of is present to be named; rows: ${excerpt(rows.join(" | "), 200)}`
      : `unranked row(s) naming ${namedUnranked.map(agentOf).join(", ") || "NOTHING"} of ${unranked.length} unranked row(s): ${excerpt(unranked.join(" | "), 200)}`,
  );

  // "used, sorted LAST, and named" — the ordering half, asked inside each
  // section because the table prints builder rows and reviewer rows separately.
  const misplaced: string[] = [];
  for (const section of new Set(rows.map((r) => roleOf(headOf(r))))) {
    const inSection = rows.filter((r) => roleOf(headOf(r)) === section);
    const firstUnranked = inSection.findIndex((r) => UNRANKED.test(headOf(r)));
    if (firstUnranked === -1) continue;
    for (const later of inSection.slice(firstUnranked)) {
      if (!UNRANKED.test(headOf(later)) && /\d/.test(headOf(later))) misplaced.push(`${section}: ${later}`);
    }
  }
  checks.expect(
    "an unranked model sorts LAST in its section (ruling 68)",
    unranked.length > 0 && misplaced.length === 0,
    unranked.length === 0
      ? "no unranked row to place — see the check above"
      : misplaced.length === 0
        ? `${unranked.length} unranked row(s) — ${unranked.map(agentOf).join(", ")} — and no scored row follows one in its own section`
        : `scored row(s) printed AFTER an unranked one: ${excerpt(misplaced.join(" | "), 240)}`,
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

    // ---- phase A: WHO REVIEWS --------------------------------------------
    // Nothing is planted here and no `--planted` denominator is passed, so this
    // run cannot publish a catch rate however it goes. Its only job is to make
    // the product state, in a record and in a ledger, which vendor it routes as
    // the reviewer. Reading that is the difference between a measurement and the
    // 2026-08-19 number.
    const routingBin = ensureDir(join(ctx.workdir, "bin-routing"));
    const routingLedger = join(ctx.workdir, "vendor-ledger-routing.tsv");
    // `undefined` reviewer: no capability is attached to anybody, stated through
    // the same function the measured fleet uses rather than by omission.
    plantFleet(routingBin, routingLedger, fleetFor(PLANTED_VENDORS, undefined, {}));
    const routingRepo = join(ctx.workdir, "routing-repo");
    await makeRepo(routingRepo, { "README.md": "base\n" });
    const routingSeed = nonce("routing-seed");
    await plantSeeds(routingRepo, [{ path: "seeds/routing.seed", value: routingSeed, placement: "committed" }]);
    const routingPlan = writePlan(
      ctx.workdir,
      {
        version: 1,
        items: [
          {
            id: "routing",
            kind: "write",
            paths: ["routing.txt"],
            prompt: "write routing.txt",
            directive: { do: "derive-write", read: "seeds/routing.seed", path: "routing.txt", salt: "routing" },
          },
        ],
      },
      "routing.json",
    );
    const probe = await probeFeature(
      ctx,
      ["run", "--plan", routingPlan, "--repo", routingRepo, "--run-root", join(ctx.workdir, "runs-routing"), "--review"],
      {
        env: baseEnv({ PATH: isolatedPath(routingBin) }),
        timeoutMs: HARNESS_RUN_TIMEOUT_MS,
        // A run whose items FAIL review exits non-zero, which is correct
        // behaviour — so presence is judged on the run having produced a
        // record, not on the exit code.
        evidence: (r) => /run-record:/.test(r.stdout),
      },
    );
    did.push(probe.transcript);

    const routingEvidence = await gatherRunEvidence(routingRepo, `${probe.result.stdout}${probe.result.stderr}`);
    const routingItem = routingEvidence.record?.items.find((i) => i.id === "routing");
    const routingLines = readLedger(routingLedger);
    const routed = readRouting({
      recordReviewer: routingItem?.reviewerAgent,
      recordBuilder: routingItem?.builderAgent,
      ledgerReviewers: vendorsIn(routingLines, "reviewer"),
      ledgerBuilders: vendorsIn(routingLines, "builder"),
    });
    did.push(`ROUTING, READ AND NEVER ASSUMED: ${routed.detail}`);

    let live: LiveHalf;
    if (!probe.present) {
      live = { kind: "missing", probe, promise: "no run can be driven, so no reviewer is routed and no catch rate can be published" };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "the reviewer's vendor must DIFFER from the builder's, which requires two drivable vendors" };
    } else {
      // ---- phase B: THE MEASURED RUN ---------------------------------------
      const binDir = ensureDir(join(ctx.workdir, "bin"));
      const defects = Array.from({ length: CATCH_THRESHOLD.planted }, (_, i) => token(`DEFECT-${i + 1}`));
      // A reviewer that CAN spot three of the five, planted on WHICHEVER vendor
      // phase A says reviews. What it actually finds is decided by the diff it
      // is handed, which is the difference between FOUND and KNOWN.
      const catchable = defects.slice(0, FIXTURE_CAN_SPOT);
      const fleet = plantFleet(
        binDir,
        join(ctx.workdir, "vendor-ledger.tsv"),
        fleetFor(PLANTED_VENDORS, routed.vendor, { catches: catchable }),
      );
      const env = baseEnv({ PATH: isolatedPath(binDir) });
      did.push(
        routed.vendor === undefined
          ? "NO PLANT WAS PLACED: phase A did not name a reviewer, so there is no vendor to configure and no catch rate to read"
          : `planted defect-catching capability on ${routed.vendor}, the vendor phase A's record and ledger both name as the reviewer`,
      );

      const repo = join(ctx.workdir, "repo");
      await makeRepo(repo, { "README.md": "base\n" });
      // The markers live in a seed inside the clone — never in the plan or the
      // prompt — and the BUILDER carries them into the file it writes.
      //
      // MEASURED on this host on 2026-08-18: this item used to plant the markers
      // in `seeds/reviewed.seed` and stop there. Ruling 33 defines the base commit
      // as HEAD plus uncommitted TRACKED plus UNTRACKED, so the seed and every
      // marker in it were carried into the BASE — and were therefore absent from
      // `git diff <base>..work`, the exact brief ruling 52 hands the reviewer. A
      // live run would have recorded `caughtDefects: []` however well the reviewer
      // performed, and published it beside v1's 0-of-3 baseline as a measured fact
      // about the product. `derive-and-carry` puts the markers in what the builder
      // WRITES, which is the only way they reach the diff.
      const reviewedSeed = nonce("reviewed-seed");
      await plantSeeds(repo, [
        { path: "seeds/reviewed.seed", value: `${reviewedSeed}\n${defects.join("\n")}`, placement: "uncommitted-tracked" },
      ]);
      const reviewedDirective = {
        do: "derive-and-carry",
        read: "seeds/reviewed.seed",
        path: "reviewed.txt",
        salt: "reviewed",
      } as const;
      const planPath = writePlan(ctx.workdir, {
        version: 1,
        items: [
          {
            id: "reviewed",
            kind: "write",
            paths: ["reviewed.txt"],
            prompt: "write reviewed.txt",
            directive: reviewedDirective,
          },
        ],
      });
      writeFileSync(join(ctx.workdir, "planted-defects.txt"), defects.join("\n"));
      did.push(`planted ${defects.length} unguessable defect markers where the BUILDER must carry them into the diff, not where the base already holds them`);

      // THE DENOMINATOR, measured before the numerator is believed. One builder
      // turn is rehearsed against a faithful copy of the repository with the real
      // fixture and real `git`, and the diff is read out. No product code runs.
      // If the markers are missing here, no reviewer could have found them.
      //
      // Driven by the vendor phase A routed as the BUILDER, for the same reason
      // the plant follows the routing: a rehearsal that hard-codes a vendor id is
      // rehearsing a turn the product does not take.
      const routedBuilder = routingItem?.builderAgent ?? vendorsIn(routingLines, "builder")[0];
      const rehearsal: Rehearsal | undefined =
        routedBuilder === undefined
          ? undefined
          : await rehearseBuilderTurn({
              repo,
              scratch: join(ctx.workdir, "denominator", "clone"),
              vendorBin: join(binDir, routedBuilder),
              binDir,
              itemId: "reviewed",
              directive: reviewedDirective,
              markers: defects,
            });
      did.push(`denominator control: ${rehearsal?.transcript ?? "NOT-RUN — phase A named no builder to rehearse"}`);

      // The credentialed leg: the operator's own PATH, so the product discovers
      // the agents they really have.
      const realFleet = await detectRealFleet(ctx);
      did.push(`detected the real fleet: ${realFleet.usable.join(", ") || "none usable"}`);

      // NO `--planted`. A denominator turns the product's report into a `catch
      // rate N of M` line, and a rate produced by a fixture catching markers this
      // harness pre-loaded into it measures the fixture. Without one the product
      // prints its no-denominator sentence instead, which is the honest output
      // for this leg — and an assertion below fails if a rate appears anyway.
      const measured = await ctx.run(
        ["run", "--plan", planPath, "--repo", repo, "--run-root", join(ctx.workdir, "runs"), "--review"],
        { env, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      const report = `${measured.stdout}${measured.stderr}`;
      did.push(
        `ran the MEASURED review: exit ${measured.code}${measured.signal ? ` (signal ${measured.signal})` : ""}; ` +
          `stdout: ${excerpt(measured.stdout, 200)}; stderr: ${excerpt(measured.stderr, 200)}`,
      );

      const evidence = await gatherRunEvidence(repo, report);
      const checks = new Checks();

      // Renamed after a blind critic found it claiming something it never did.
      // It asserts RESOLVABILITY and nothing more: the measured run below is
      // driven on an isolated PATH holding planted fixtures, so the operator's
      // real agents are detected and never driven. The old name said "drove".
      checks.expect(
        "two credentialed agents are RESOLVABLE on the operator's PATH (this item does not drive them)",
        realFleet.usable.length >= 2,
        `\`brigadier detect\` reports ${realFleet.usable.length} usable agent(s): ${realFleet.usable.join(", ") || "none"}. ` +
          "EVERY run below executes on an isolated PATH containing only planted fixtures — nothing here drives a real vendor. " +
          "Ruling 43 and #41 measured an APPROVED permission on Codex running OUTSIDE its own sandbox, which no stub reproduces, " +
          "and that gap is named in the UNPROVEN check below rather than hidden behind this one",
      );

      // Asserted BEFORE anything about the reviewer, because everything below is
      // unreadable without it. A zero here is a harness fault and must never be
      // published as a reviewer's score.
      checks.expect(
        "DENOMINATOR: every planted defect really is in `git diff <base>..work` (ruling 52's brief)",
        rehearsal !== undefined && rehearsal.missing.length === 0 && rehearsal.diff.length > 0,
        rehearsal === undefined
          ? "NOT-RUN — phase A named no builder, so the diff a reviewer would be handed was never rehearsed and no catch rate below is readable"
          : rehearsal.missing.length === 0
            ? `${rehearsal.transcript} — so a reviewer handed this diff had ${defects.length} real defects to find`
            : `MISSING FROM THE DIFF: ${rehearsal.missing.join(", ")}. ${rehearsal.transcript}. ` +
              "The catch rate below would be structurally zero and would say nothing about the reviewer — ruling 33 carries uncommitted tracked and untracked work into the BASE commit, " +
              "so a marker planted only in a seed is invisible to the diff",
      );
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
      checks.expect(
        "the verdict is RECORDED, not merely rendered",
        reviewed?.reviewVerdict !== undefined,
        `record item \`reviewed\` carries reviewVerdict ${reviewed?.reviewVerdict ?? "NONE"}`,
      );

      // THE CONTROL THAT WOULD HAVE CAUGHT 2026-08-19. The vendor carrying the
      // plant must be the vendor this run's own record names as the reviewer.
      // Compared as NAMES: a count comparison is satisfied by `caught 0 of 5`,
      // which is exactly what the misrouted run produced and published.
      const plant = judgePlantRouting({
        configured: routed.vendor,
        recordReviewer: reviewed?.reviewerAgent,
        recordBuilder: reviewed?.builderAgent,
        ledgerReviewers: reviewers,
      });
      checks.expect(
        "ROUTING CONTROL: the vendor configured to catch defects IS the one the record names as reviewer — otherwise this is an `error`, never a low catch rate",
        plant.onTarget,
        plant.detail,
      );

      const caught = evidence.record?.review?.caughtDefects ?? reviewed?.caughtDefects ?? [];
      const rateLine = /^.*catch rate.*$/im.exec(report)?.[0] ?? "";
      if (!plant.onTarget) {
        // A plant on the wrong vendor makes every identity below a fact about a
        // fixture config file, so nothing is read out of them at all.
        checks.expect(
          "ERROR — PLUMBING NOT READ, because the plant did not follow the routing",
          false,
          `${plant.detail}. The record named ${JSON.stringify(caught)}; that list describes where a fixture's capability was ` +
            "configured, not what any reviewer did, and ruling 52 makes this an `error` that blocks",
        );
      } else {
        // What this leg proves, stated as what it is: the identities a reviewer
        // FOUND survive builder → diff → reviewer → record, by name. `.every()`
        // is true of an empty array, so the comparison is set equality with both
        // sides of the difference reported.
        //
        // It is NOT a catch rate and must never be read as one. The fixture was
        // handed the list it can spot; that a fixture finds what it was told to
        // find measures the wiring between four processes and nothing else.
        const found = nameDiff(caught, catchable);
        checks.expect(
          "PLUMBING: the identities the reviewer FOUND survive builder → diff → reviewer → record, by name",
          found.equal,
          `reviewer ${routed.vendor ?? "none"} was configured to spot ${JSON.stringify(catchable)} of the ${defects.length} in the diff; ` +
            `the record names ${JSON.stringify(caught)}` +
            (found.equal ? "" : `; missing ${JSON.stringify(found.missing)}, unexpected ${JSON.stringify(found.unexpected)}`) +
            ". This is a wiring assertion, not a catch rate: the fixture was handed this list",
        );
        // And the partiality is the point. The fixture can see three of five, so
        // a record echoing the PLANT and a record reporting what was FOUND are
        // distinguishable — which they would not be if it could see all five.
        checks.expect(
          "PLUMBING: the record reports what was FOUND, not what was PLANTED",
          caught.length > 0 && defects.some((m) => !caught.includes(m)),
          `${defects.length} markers reached the diff and the record names ${caught.length} of them. ` +
            "A record naming all five would be indistinguishable from one echoing the plant",
        );
      }

      // The leg publishes NO rate, and that is asserted rather than assumed. If
      // anyone restores `--planted` here, the product starts printing
      // `catch rate N of M` — a quotable string that travels without its
      // caveat — and this check fails immediately.
      checks.expect(
        "this leg publishes NO catch rate — a fixture catching markers it was handed is not a measurement",
        !rateIn(report) && /no rate/i.test(report),
        `no denominator was supplied, so the product printed: \`${excerpt(rateLine, 200)}\`. ` +
          `A rate here would land on ${FIXTURE_CAN_SPOT} of ${defects.length} by construction, which is the digit ` +
          `BAR.md's threshold of ${CATCH_THRESHOLD.caught} of ${CATCH_THRESHOLD.planted} makes a reader parse as cleared`,
      );

      // WHO MEASURES, per BAR.md item 5 as AMENDED by the owner on 2026-08-19.
      //
      // This is not an unmet promise and must not be reported as one. The rate
      // was REASSIGNED: an automated number here would have been the harness
      // grading itself, because the count is of distinct quoted identifiers
      // present in the diff and is never matched to the planted set. So the
      // automated item proves the plumbing and blocks on it — every check above
      // — and the verifier produces the rate from a recorded transcript.
      //
      // It passes when the plumbing passes. What it asserts is the one thing
      // this item still owes the verifier: that the artefact they score from can
      // be produced, and that nothing here published a number in the meantime.
      checks.expect(
        "the catch rate is the VERIFIER's to produce, and this item leaves them what they need",
        !rateIn(report),
        `BAR.md item 5, amended 2026-08-19: the automated item proves the plumbing and publishes no rate; the verifier plants its own ` +
          `five defects, drives the real fleet on a real PATH with prose-only prompts, and scores what the reviewer actually said. ` +
          `The recorder that hands them that artefact is \`${VERIFIER_ENTRY}\` — it is NOT run by this item, it spends real vendor money, ` +
          `and it records without scoring. What it gives the verifier: ${VERIFIER_NEEDS.join("; ")}. ` +
          `The threshold of ${CATCH_THRESHOLD.caught} of ${CATCH_THRESHOLD.planted} and v1's baseline of ${V1_CATCH_BASELINE} are unchanged; ` +
          "what changed is who measures",
      );

      // The blocker, asserted on the tree rather than on the word `error` — and
      // on the vendor the routing named, for the same reason as the plant. A
      // `dieAsReviewer` flag on the builder never fires.
      const dyingBin = ensureDir(join(ctx.workdir, "bin-dying"));
      const dyingLedgerPath = join(ctx.workdir, "vendor-ledger-dying.tsv");
      plantFleet(dyingBin, dyingLedgerPath, fleetFor(PLANTED_VENDORS, routed.vendor, { dieAsReviewer: true }));
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
      const dyingLedger = readLedger(dyingLedgerPath);
      const dyingBuilders = vendorsIn(dyingLedger, "builder");
      const dyingReviewers = vendorsIn(dyingLedger, "reviewer");
      // POSITIVE CONTROL for the check below. "The value is absent from the tree"
      // is also true of a run where nothing ever ran, so the absence only means
      // something once both roles are known to have been played and the vendor
      // that died is known to have died AS THE REVIEWER.
      checks.expect(
        "the killed-reviewer run really played both roles, and the kill landed on the REVIEWER",
        dyingBuilders.length > 0 && routed.vendor !== undefined && dyingReviewers.includes(routed.vendor),
        `dying-run ledger: builders ${dyingBuilders.join(", ") || "NONE"}, reviewers ${dyingReviewers.join(", ") || "NONE"}; ` +
          `\`dieAsReviewer\` was configured on ${routed.vendor ?? "NO VENDOR"}. Without this, "the item did not integrate" is also ` +
          "what a run that never started looks like",
      );
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
