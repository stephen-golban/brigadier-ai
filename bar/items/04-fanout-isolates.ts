// SPDX-License-Identifier: Apache-2.0
/**
 * Item 4 — Fan-out isolates, and integration merges.
 *
 * Rulings 19, 14, 7, 13, 33, 16, 9, 2, 39, 49, 50 — and it carries rulings 51,
 * 54 and 61's halves too, which is why it is the longest item in `BAR.md`.
 *
 * The first draft of this item **passed against a fake that hand-wrote
 * `.git/refs/heads/brigadier/run-0001` — forty hex characters and a newline,
 * pointing at an object that was never created — and printed the word "capped"**.
 * Nothing here reads a ref file any more. The ref is put through `git rev-parse`,
 * `git cat-file -t` and `git fsck --connectivity-only --strict`, and the last of
 * those is the one a hand-written ref cannot survive: it walks from every ref to
 * every object it names, and a broken link is a broken link however confidently
 * it was printed.
 *
 * Then the tree. Each plan item carries a token generated after the binary under
 * test was built, and the item reads those tokens back out of the merged tree
 * with `git cat-file blob`. A liar that produces them has cloned, run a worker,
 * committed and merged — which is the work.
 *
 * The halves this item keeps, each because something would otherwise be quietly
 * false:
 *
 *   ruling 33 repairing ruling 7 — the workers see the owner's uncommitted
 *   TRACKED and UNTRACKED work, so both are in the repository and both must be
 *   in the merged tree;
 *
 *   ruling 49 — a `read-only` item that writes into its own checkout anyway
 *   contributes NOTHING, because the directory is never read back. Not "the
 *   agent could not write": three of five measured vendors give no lane at all,
 *   so an item asserting that would be proving a promise the product does not
 *   make;
 *
 *   ruling 54 — a `dependsOn` wave must SEE its prerequisite's output, which is
 *   checked by the prerequisite's token appearing inside the dependent's file;
 *
 *   ruling 51 — every ref that appeared is one brigadier created FOR THIS RUN,
 *   because a worker can push into the operator's repository through the
 *   clone's own `origin` and removing the remote is a speed bump rather than a
 *   boundary. An earlier draft accepted `refs/heads/brigadier/` and nothing
 *   else, which is half the design: ruling 51 splits the namespace, machinery
 *   into the invisible `refs/brigadier/<run-id>/…` and the DELIVERABLE into the
 *   one visible branch `refs/heads/brigadier/<run-id>`. Accepting only the
 *   visible half marked the product's own machinery as an intruder, so the
 *   check now reads the run id out of the record and asserts BOTH halves —
 *   including the property the split exists for, that `git branch` gains
 *   exactly one entry;
 *
 *   ruling 61 — the run directory is outside every temp root, by `realpath`
 *   rather than lexically, because macOS's `/var` → `/private/var` symlink makes
 *   the lexical check wrong.
 *
 * **RULING 54'S THIRD FILTER IS DRIVEN HERE, NOT EXCUSED.** Until 2026-08-20
 * this item drove two of the three fan-out filters and left a `Checks.note()`
 * saying the RAM-bound sentence *"cannot be manufactured without constraining
 * the machine"*. The premise was wrong, and a note stamps `ok: true`, so a
 * reader saw two green rows and a third that gated nothing.
 *
 * RAM binds whenever it is the strict minimum of ruling 14's four filters, and
 * three of those four are inputs the OPERATOR controls: legality is unbounded
 * once ruling 13 has already refused every colliding plan, the item count is the
 * plan's own length, and desirability is `--workers`. So the machine is left
 * alone and the PLAN is sized above it — more items than this machine's
 * `totalmem()` leaves room for, with `--workers` far above that — and the
 * product's sentence is then TRUE as printed, derived from the real machine.
 * No override, no injected memory figure, no product seam whose only caller is
 * a harness: a seam that let brigadier believe it had 1 GB would make the very
 * sentence under test false, which is the opposite of proving it.
 *
 * How many items that takes is a property of the machine, so it is DISCOVERED —
 * `RAM_LADDER` is climbed until the printed sentence names RAM — rather than
 * computed by copying the product's 3 GiB per-worker constant into this
 * directory, where a second copy would go stale in silence. On a machine so
 * large that the top of the ladder still does not bind, the ladder it climbed is
 * the failure detail: a loud negative, not a note.
 *
 * AND THE SIZING IS RELATIVE TO THE MACHINE, NOT ASSUMED. The first version of
 * this repair drove a ONE-item plan for *the plan had one item* and
 * `--workers 2` for *desirability capped it*, and both of those are only under
 * the RAM cap on a host that can hold three workers — 16 GiB. Below that the
 * non-RAM drives bind on RAM too, and the item went red for a reason that had
 * nothing to do with the product. GitHub's runner table, read on 2026-08-20,
 * gives `macos-latest` 7 GB and a private repository's `ubuntu-latest` 8 GB, so
 * that band is ordinary hardware rather than a corner. The RAM drive therefore
 * runs FIRST, the binary's own reported cap is read out of its own sentence,
 * and `planTheOtherTwoDrives` sizes the other two from it. A host that cannot
 * separate the causes at all gets a row that BLOCKS and says why — see
 * `MIN_CAP_TO_DISTINGUISH`.
 *
 * AND CI DOES NOT COVER ANY OF THIS. `.github/workflows/gates.yml` grades the
 * bar with `bun bar/run.ts --binary "$BIN"` and never passes `--live`, so on all
 * three runners item 4's live half reports SKIPPED and every drive below is
 * unexecuted. A SKIPPED half blocks exactly as a FAIL does (ruling 48), so this
 * is not a hole in the verdict — but do not read a green `gates` run as evidence
 * that ruling 54's three sentences were driven. They are driven by a verifier
 * running the bar with `--live`, on a host with room for at least
 * `MIN_CAP_TO_DISTINGUISH` workers. What CI DOES cover is `test/fanout.test.ts`,
 * through `bun run test-gate`, which is why every assertion in that file is
 * written to hold on a 7 GB `macos-latest` runner as well as on a 24 GiB
 * workstation.
 *
 * AND THE CHECK THAT NOTE SAT BESIDE WAS NOT CHECKING WHAT IT SAID. It read the
 * sentence with `/—\s*(.+?)\s*$/m`, and the first em dash in an admission block
 * is on `admitted — <plan path>: N item(s) in M wave(s)` — so the two "different
 * sentences" it compared were two plan paths, and it would have passed against a
 * binary that printed ONE fan-out sentence for all four filters. Wave one's
 * sentence is now found by its own shape (`bindingLines`) and CLASSIFIED
 * (`classifyBindingSentence`); a sentence naming two filters, or none, is a
 * failure rather than a match. The honest fixture had bent itself around that
 * broken regex too — printing its fan-out line FIRST so the regex would find
 * it — so the harness was reading a DIFFERENT LINE from the control than from
 * the product, and nothing could see it from either side. The same drive also passed `--max-workers`, which
 * `src/cli.ts` does not read — the flag is `--workers` — so the run that claimed
 * to be "capped at 2" was capped at ruling 54's default of 3.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { derive, nonce } from "../lib/derive.ts";
import { gatherRunEvidence, insideTempRoot, isAncestor, objectType, proofOfWork } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir } from "../lib/fs.ts";
import { captureRepo, diffRepo, makeRepo, newRefs, plantSeeds } from "../lib/git.ts";
import { combine, noCredentialFreeChecks, type LiveHalf } from "../lib/halves.ts";
import { runSampled } from "../lib/inflight.ts";
import { disjointPlan, token, writePlan } from "../lib/plan.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/** Ruling 14's four filters, named as the product's own sentences name them. */
export type BindingFilterName = "legality" | "feasibility" | "desirability" | "item-count";

/**
 * The LABEL each filter's sentence must carry — not the sentence itself.
 *
 * This was `/RAM capped it/`, `/desirability capped it/` and
 * `/no filter reduced it/`: the product's own clauses, word for word. Round 16
 * recorded that exact mistake and its remedy — *a check matched the product's
 * sentence word for word and so failed any from-scratch reimplementation; it
 * was re-anchored on the label instead.* MEASURED on 2026-08-20: the honest
 * fixture names all three filters correctly in its own words — *"the plan had 5
 * item(s), which was the binding filter"* — and the clause-matching classifier
 * returned `null` for it. The fixture was right and this was wrong.
 *
 * `BAR.md` asks that the report NAME which filter bound the count. So what is
 * required here is the filter's name, and everything around it is the
 * implementation's own prose. Two labels in one sentence still resolves to
 * `null`, so widening these has not weakened the collapse check that ruling 54
 * needs — see `classifyBindingSentence`.
 *
 * `item-count` has no single word of its own (`item` appears in all four
 * sentences), so it is matched on either implementation's way of saying the
 * plan's own length was the limit.
 *
 * `bar/lib/item4-fanout.test.ts` drives BOTH vocabularies — the product's
 * transcribed sentences and the fixture's differently-worded ones — through
 * this table and requires the same four answers. A classifier that only one of
 * them satisfies is the defect above, returning.
 */
export const FILTER_PHRASES: ReadonlyArray<readonly [BindingFilterName, RegExp]> = [
  ["feasibility", /\bRAM\b|\bmemory\b/i],
  ["desirability", /\bdesirability\b/i],
  ["legality", /\blegality\b/i],
  ["item-count", /the plan had \d+ item|no filter reduced it/i],
];

/**
 * Which filter a sentence names — or `null`, which is a finding.
 *
 * Two phrases in one sentence is not a classification, it is the collapse
 * ruling 54 exists to forbid, so it is refused rather than resolved by
 * precedence. A caller that treated "I could not tell" as a pass would be the
 * defect this item was rebuilt to remove.
 */
export function classifyBindingSentence(text: string): BindingFilterName | null {
  const hits = FILTER_PHRASES.filter(([, phrase]) => phrase.test(text)).map(([name]) => name);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

export interface BindingLine {
  /** The wave it names, or `null` when the implementation numbers no waves. */
  wave: number | null;
  workers: number;
  /** Everything after the em dash: the sentence itself. */
  text: string;
  filter: BindingFilterName | null;
}

/**
 * Fan-out sentences, found by their OWN shape: a worker count, an em dash, and
 * a reason.
 *
 * Reading "the first line with an em dash" instead returned
 * `admitted — <plan path>: …` on every product run, and that is what made this
 * item's ruling-54 check vacuous for as long as it existed. The honest fixture
 * had even bent itself around it, printing its fan-out line FIRST so that the
 * broken regex would find it — so the harness was reading a different line from
 * the fixture than from the product, and neither party could see it.
 *
 * `in wave M` is OPTIONAL for the same reason the labels above were widened: it
 * is the product's rendering, not the promise. An implementation that reports
 * one fan-out sentence for the run rather than one per wave is not
 * non-conforming, and the item grades wave one either way — the first sentence
 * that names wave 1 or names no wave at all.
 */
export function bindingLines(stdout: string): BindingLine[] {
  const lines: BindingLine[] = [];
  for (const match of stdout.matchAll(/^.*?(\d+) worker\(s\)(?: in wave (\d+))? — (.+?)\s*$/gm)) {
    const text = match[3] ?? "";
    lines.push({
      workers: Number(match[1]),
      wave: match[2] === undefined ? null : Number(match[2]),
      text,
      filter: classifyBindingSentence(text),
    });
  }
  return lines;
}

/** Wave one's sentence, however the implementation chose to number its waves. */
export function waveOne(stdout: string): BindingLine | undefined {
  return bindingLines(stdout).find((line) => line.wave === null || line.wave === 1);
}

export interface FanOutObservation {
  /** What the harness did to make this filter bind, in the report's own words. */
  cause: string;
  /** The filter that cause must produce, and no other. */
  wants: BindingFilterName;
  /** Wave one's sentence exactly as the binary printed it; `""` when it printed none. */
  sentence: string;
}

/**
 * Ruling 54's promise, judged as three causes rather than as three strings.
 *
 * Three rows, and the third is the negative control: the RAM sentence must be
 * absent from every drive where RAM did not bind. Without it a product that
 * printed the RAM sentence unconditionally would satisfy "each cause named its
 * filter" for the RAM cause and be caught only by the distinctness row, which a
 * single differing number would defeat.
 */
export function judgeFanOutFilters(observed: readonly FanOutObservation[]): Checks {
  const checks = new Checks();
  for (const o of observed) {
    const got = classifyBindingSentence(o.sentence);
    checks.expect(
      `${o.cause} — the report names the ${o.wants} filter (ruling 54)`,
      got === o.wants,
      o.sentence.length === 0
        ? "the binary printed no wave-one fan-out sentence at all"
        : `classified ${got ?? "NO SINGLE FILTER"} from ${JSON.stringify(excerpt(o.sentence, 220))}`,
    );
  }
  const sentences = observed.map((o) => o.sentence);
  checks.expect(
    // The COUNT is in the name, because this row is satisfied vacuously by one
    // observation and a reader must be able to see how many were judged. On a
    // host too small to drive all three, only the RAM cause is here — and the
    // row that blocks for the missing two is the item's own, not this one.
    `each of the ${observed.length} cause(s) driven produced a DIFFERENT sentence (ruling 54)`,
    sentences.every((s) => s.length > 0) && new Set(sentences).size === sentences.length,
    sentences.map((s, i) => `${observed[i]?.wants ?? "?"}: ${JSON.stringify(excerpt(s, 120))}`).join(" | "),
  );
  const ramElsewhere = observed.filter(
    (o) => o.wants !== "feasibility" && classifyBindingSentence(o.sentence) === "feasibility",
  );
  checks.expect(
    "the RAM-bound sentence appears ONLY where RAM actually bound",
    ramElsewhere.length === 0,
    ramElsewhere.length === 0
      ? "neither the one-item drive nor the --workers drive claimed a RAM bound"
      : `claimed a RAM bound without one: ${ramElsewhere.map((o) => o.cause).join(", ")}`,
  );
  return checks;
}

/**
 * Plan sizes the RAM drive climbs until this machine's own `totalmem()` is the
 * smallest of ruling 14's four filters.
 *
 * Doubling rather than computed, because computing it means writing the
 * product's 3 GiB per-worker budget down a second time in a directory that may
 * not import it. Eight covers every machine whose feasibility cap is 8 or
 * lower — the owner's 24 GB host is 5 — and the top of the ladder covers a
 * 1.5 TB one.
 */
export const RAM_LADDER: readonly number[] = [8, 16, 32, 64, 128, 256, 512];

/**
 * The smallest feasibility cap on which ruling 54's three causes can be told
 * apart AT ALL, and the reason the other two drives are sized from a measured
 * number rather than assumed.
 *
 * MEASURED with `feasibilityCap` on 2026-08-20: a host reports a cap of
 * `floor((totalmem - 4 GiB OS reserve - 3 GiB host agent) / 3 GiB)`, so 7 and
 * 8 GiB give 0, 10 and 12 GiB give 1, 13 and 14 give 2, 16 gives 3 and this
 * host's 24 gives 5. The first draft of this item drove a ONE-item plan and
 * `--workers 2` and assumed neither would collide with RAM — which is only
 * true from a cap of 3 upward, i.e. 16 GiB. GitHub's own runner table, read on
 * 2026-08-20, gives `ubuntu-latest` and `windows-latest` 16 GB on a public
 * repository and 8 GB on a private one, and `macos-latest` 7 GB either way. So
 * the assumption put the two smaller runners, and every ordinary 8 GiB laptop,
 * in a band where the NON-RAM drives also bind on RAM and the item goes red for
 * a reason that has nothing to do with the product.
 *
 * Below a cap of two there is no item count and no `--workers` budget strictly
 * under it — a plan cannot have zero items and a budget of zero is not a run —
 * so those two causes genuinely cannot be separated from RAM on such a host.
 * That is a fact about the machine, and this item SAYS SO in a row that blocks.
 * It does not pass: an undrivable branch reported as proved is the defect this
 * item was rebuilt to remove.
 */
export const MIN_CAP_TO_DISTINGUISH = 2;

export interface OtherTwoDrives {
  /** Items in the plan whose own length must be the binding filter. */
  itemCountItems: number;
  /** Items in the plan the operator's budget must cut below. */
  desirabilityItems: number;
  /** The `--workers` value that must be the binding filter. */
  desirabilityWorkers: number;
}

/**
 * How to size the two non-RAM drives once the binary has measured its own cap.
 *
 * Every number here is RELATIVE to the cap the product just reported, so the
 * item works on any host that can hold two workers instead of silently
 * requiring 16 GiB. `null` is the honest answer on a host that cannot.
 *
 * The same three numbers are verified against the real filter in
 * `test/fanout.test.ts` — `bar/` imports nothing from `src/`, so the rule is
 * pinned on both sides of that wall rather than trusted on either.
 */
export function planTheOtherTwoDrives(measuredCap: number): OtherTwoDrives | null {
  if (!Number.isInteger(measuredCap) || measuredCap < MIN_CAP_TO_DISTINGUISH) return null;
  return {
    // One item is below every cap of two or more, and below ruling 54's
    // default budget of three.
    itemCountItems: 1,
    // More items than the machine can hold, so the plan's length cannot win.
    desirabilityItems: measuredCap + 2,
    // Strictly under the cap, so RAM cannot win either.
    desirabilityWorkers: measuredCap - 1,
  };
}

/**
 * Whether this host can separate ruling 54's three causes AT ALL — as a judge,
 * deliberately, rather than as a boolean at the call site.
 *
 * This row is the only thing standing between a too-small host and an item that
 * quietly proves one third of what it claims: on such a host
 * `judgeFanOutFilters` is content, because the one cause that WAS driven was
 * driven honestly. A blind critic replaced its predicate with `true` and 173 of
 * 173 tests stayed green — only the row's INPUTS were pinned
 * (`MIN_CAP_TO_DISTINGUISH`, the sizing arithmetic), never the row. *A guard
 * that always passes looks identical to a working one*, which is the sentence
 * this whole harness is built around.
 *
 * So the predicate lives HERE, where `bar/lib/item4-fanout.test.ts` drives it
 * directly in both directions and neutering it turns tests red. There is no
 * boolean left in the item body to neuter instead: the call site is an
 * `absorb`, and the only input is the cap the binary itself reported.
 *
 * Nothing here computes a cap. The number arrives from `bindingLines` parsing
 * the product's own sentence — `bar/` holds no copy of ruling 54's arithmetic,
 * and adding one would bring back the staleness hazard `RAM_LADDER` exists to
 * avoid.
 */
export function judgeHostCanDistinguish(measuredCap: number | undefined): Checks {
  const checks = new Checks();
  const sizing = measuredCap === undefined ? null : planTheOtherTwoDrives(measuredCap);
  checks.expect(
    "this host can tell ruling 54's three causes apart at all",
    sizing !== null,
    sizing !== null
      ? `the binary measured its own feasibility cap at ${measuredCap} worker(s), which leaves an item count and a --workers budget strictly under it`
      : `NOT DRIVEN — the binary measured this host's feasibility cap at ${
          measuredCap === undefined ? "no value at all, because no rung of the RAM ladder bound on RAM" : `${measuredCap} worker(s)`
        }. Below ${MIN_CAP_TO_DISTINGUISH} there is no item count and no --workers budget strictly under the cap, so *the plan had one item* and ` +
        "*desirability capped it* ALSO bind on RAM here and ruling 54's three sentences cannot be told apart on this machine. Two of the three are " +
        "therefore UNPROVEN, and this row blocks rather than passing: an undrivable branch reported as proved is the defect this item was rebuilt to " +
        `remove. Remedy: grade item 4 on a host with room for at least ${MIN_CAP_TO_DISTINGUISH} workers — about 13 GiB once ruling 54's OS reserve ` +
        "and decision 25's host-agent budget are taken out.",
  );
  return checks;
}

/**
 * A `--workers` value above any machine's feasibility cap, so the RAM drive's
 * desirability filter can never be the one that binds. At 3 GiB per worker this
 * is a 192 TB machine.
 */
export const WORKERS_ABOVE_ANY_MACHINE = 65_536;

const item: BarItem = {
  id: 4,
  title: "Fan-out isolates, and integration merges",
  rulings: [19, 14, 7, 13, 33, 16, 9, 2, 39, 49, 50],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];
    const credentialFree = new Checks();

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "qwen", version: "0.21.13" },
      { id: "copilot", version: "1.0.80" },
    ]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });
    const runs = ensureDir(join(ctx.workdir, "runs"));

    // ---- credential-free: a plan whose items collide is REJECTED -----------
    // Ruling 13 is decided at admission and needs no agent, so it is graded on
    // a machine with no credentials rather than deferred into the live half.
    const clashRepo = join(ctx.workdir, "clash-repo");
    await makeRepo(clashRepo, { "README.md": "base\n" });
    const clashPlan = writePlan(
      ctx.workdir,
      {
        version: 1,
        items: [
          { id: "one", kind: "write", paths: ["shared.txt"], prompt: "write shared.txt" },
          { id: "two", kind: "write", paths: ["shared.txt"], prompt: "also write shared.txt" },
        ],
      },
      "clash.json",
    );
    const clashBefore = await captureRepo(clashRepo);
    const clash = await probeFeature(
      ctx,
      ["run", "--plan", clashPlan, "--repo", clashRepo, "--run-root", join(ctx.workdir, "clash-runs")],
      // A REFUSAL is the positive evidence here: a non-zero exit that said
      // something. Judging presence on "exited 0" would mark a correct refusal
      // as a missing feature.
      { env, timeoutMs: 120_000, evidence: (r) => r.code !== 0 && `${r.stdout}${r.stderr}`.trim().length > 0 },
    );
    const clashAfter = await captureRepo(clashRepo);
    did.push(`drove a two-items-one-path plan at ${clashPlan}: ${clash.transcript}`);
    if (clash.present) {
      const clashOutput = `${clash.result.stdout}${clash.result.stderr}`;
      credentialFree.expect(
        "a plan with two items claiming one path is rejected (ruling 13)",
        clash.result.code !== 0 && /shared\.txt/.test(clashOutput),
        `exit ${clash.result.code}; output: ${excerpt(clashOutput, 240)}`,
      );
      credentialFree.expect(
        "the rejected plan created no ref and left the repository alone",
        newRefs(clashBefore, clashAfter).length === 0 && diffRepo(clashBefore, clashAfter).length === 0,
        `refs that appeared: ${newRefs(clashBefore, clashAfter).join(", ") || "none"}; repository drift: ${diffRepo(clashBefore, clashAfter).map((d) => d.field).join(", ") || "none"}`,
      );
    } else {
      credentialFree.expect(
        "a plan with two items claiming one path is rejected (ruling 13)",
        false,
        clash.transcript,
      );
    }

    // ---- the real fan-out --------------------------------------------------
    //
    // Every nonce below lives ONLY in the repository's content, in a different
    // placement each time. Ruling 33 carries the owner's uncommitted TRACKED and
    // UNTRACKED work into each clone; ruling 50 keeps gitignored content out of
    // the base commit entirely. A product that dropped any one of the three
    // yields a wrong derivation, and a forger that reads the working tree gets
    // the gitignored one WRONG in the opposite direction — it must be absent.
    const repo = join(ctx.workdir, "operator-repo");
    await makeRepo(repo, { "README.md": "base\n" });
    const alphaSeed = nonce("alpha-seed");
    const betaSeed = nonce("beta-seed");
    const ignoredSeed = nonce("ignored-seed");
    await plantSeeds(repo, [
      { path: "seeds/alpha.seed", value: alphaSeed, placement: "uncommitted-tracked" },
      { path: "seeds/beta.seed", value: betaSeed, placement: "untracked" },
      { path: "seeds/secret.seed", value: ignoredSeed, placement: "gitignored" },
    ]);
    did.push(
      `built ${repo} with three nonces: one uncommitted-TRACKED, one UNTRACKED (ruling 33) and one GITIGNORED (ruling 50, which must NOT reach a clone)`,
    );

    const readOnlyToken = token("read-only-leak");
    const alphaOut = derive(alphaSeed, "alpha");
    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: [
        {
          id: "alpha",
          kind: "write",
          paths: ["alpha.txt"],
          prompt: "derive alpha.txt from seeds/alpha.seed",
          directive: { do: "derive-write", read: "seeds/alpha.seed", path: "alpha.txt", salt: "alpha" },
        },
        {
          id: "beta",
          kind: "write",
          paths: ["beta.txt"],
          prompt: "derive beta.txt from seeds/beta.seed",
          directive: { do: "derive-write", read: "seeds/beta.seed", path: "beta.txt", salt: "beta" },
        },
        {
          id: "reader",
          kind: "read-only",
          paths: ["README.md"],
          prompt: "summarise README.md",
          directive: { do: "write-anyway", path: "leaked.txt", token: readOnlyToken },
        },
        {
          // Ruling 54: the value wave 2 needs existed ONLY in wave 1's
          // integration commit. It is nowhere in the plan and nowhere in the
          // repository, so a forger must chain the derivation in the right
          // order from the right source.
          id: "wave2",
          kind: "write",
          paths: ["wave2.txt"],
          dependsOn: ["alpha"],
          prompt: "read alpha.txt — wave one's output — and derive wave2.txt from it",
          directive: { do: "read-then-write", read: "alpha.txt", path: "wave2.txt", salt: "wave2" },
        },
        {
          // The gitignored nonce. Ruling 50 keeps it out of the base commit, so
          // this derivation must NOT be producible — and its absence is checked.
          id: "ignored",
          kind: "write",
          paths: ["ignored.txt"],
          prompt: "derive ignored.txt from seeds/secret.seed if you can reach it",
          directive: { do: "derive-write", read: "seeds/secret.seed", path: "ignored.txt", salt: "ignored" },
        },
      ],
    });
    did.push(`wrote a five-item plan at ${planPath}: two derivations, one read-only that writes anyway, one dependsOn wave, one reaching for gitignored content`);

    const before = await captureRepo(repo);
    did.push(
      `captured the operator repository five ways: HEAD=${before.head.slice(0, 12)}, status=${JSON.stringify(before.status.trim())}, ` +
        `refs=${JSON.stringify(before.refs.trim())}, .git/index=${before.indexHash.slice(0, 12)}, tree=${before.treeHash.slice(0, 12)}`,
    );

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
        promise: "there is no fan-out to isolate and no integration branch to merge into",
      };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "N clones and N workers require N drivable vendor agents" };
    } else {
      const sampled = await runSampled([ctx.binary, "run", "--plan", planPath, "--repo", repo, "--run-root", runs], {
        cwd: ctx.workdir,
        env,
        runRoot: runs,
        operatorHead: before?.head ?? undefined,
        timeoutMs: HARNESS_RUN_TIMEOUT_MS,
      });
      did.push(
        `ran the plan while sampling: ${sampled.flight.samples} samples, peak ${sampled.flight.peakConcurrentClones} concurrent clones, peak ${sampled.flight.peakMarkedProcesses} marked processes`,
      );
      const report = `${sampled.stdout}${sampled.stderr}`;
      const after = await captureRepo(repo);
      const evidence = await gatherRunEvidence(repo, report);
      const checks = new Checks();

      const expected = new Map([
        ["alpha.txt", alphaOut],
        ["beta.txt", derive(betaSeed, "beta")],
        ["wave2.txt", derive(alphaOut, "wave2")],
      ]);
      checks.absorb(proofOfWork(evidence, {
        expected,
        itemIds: ["alpha", "beta", "wave2"],
        flight: sampled.flight,
        expectedWorkers: 4,
      }));

      // Ruling 50: the gitignored nonce never reached a clone, so its derivation
      // cannot exist. A forger reading the working tree produces it and fails
      // here; a product that put gitignored content in the base commit does too.
      const forbidden = derive(ignoredSeed, "ignored");
      const leakedIgnored = [...evidence.files.entries()].filter(([, body]) => body.includes(forbidden));
      checks.expect(
        "gitignored content never reached a clone, so its derivation cannot exist (ruling 50)",
        leakedIgnored.length === 0,
        leakedIgnored.length === 0
          ? "no path in the merged tree carries a derivation of the gitignored nonce"
          : `${leakedIgnored.map(([p]) => p).join(", ")} carries it — either the base commit included gitignored content, or the value was computed from the working tree rather than from a clone`,
      );

      // Ruling 49: the read-only item's directory is never read back.
      const leaked = [...evidence.files.entries()].filter(([, body]) => body.includes(readOnlyToken));
      checks.expect(
        "a read-only worker's writes reach neither the branch nor any report (ruling 49)",
        leaked.length === 0 && !report.includes(readOnlyToken),
        `paths in the merged tree carrying the read-only token: ${leaked.map(([p]) => p).join(", ") || "none"}; token in the report: ${report.includes(readOnlyToken)}`,
      );

      // Ruling 51 and ruling 50, and this is where the item used to misread the
      // design. It accepted `refs/heads/brigadier/` and NOTHING else, so every
      // machinery ref the product legitimately writes read as an intruder. The
      // owned namespace is BOTH halves of ruling 51's split: the invisible
      // `refs/brigadier/<run-id>/…` for machinery, and the one visible branch
      // `refs/heads/brigadier/<run-id>` that is the deliverable. The run id
      // comes out of the record, so "brigadier's namespace" is now this run's
      // namespace rather than any ref that starts with the right eight letters.
      const appeared = newRefs(before, after);
      const runId = evidence.record?.runId;
      const refNameOf = (line: string): string => line.split(/\s+/)[0] ?? "";
      const shaOf = (line: string): string => line.split(/\s+/)[1] ?? "";
      const owned = (line: string): boolean => {
        const ref = refNameOf(line);
        if (runId === undefined) return false;
        return ref === `refs/heads/brigadier/${runId}` || ref.startsWith(`refs/brigadier/${runId}/`);
      };
      const unexpected = appeared.filter((line) => !owned(line));
      checks.expect(
        "every ref that appeared belongs to THIS run, in one of ruling 51's two namespaces",
        runId !== undefined && unexpected.length === 0,
        `run id from the record: ${runId ?? "NONE"}; appeared: ${appeared.map(refNameOf).join(", ") || "none"}; ` +
          `outside refs/brigadier/${runId ?? "<run>"}/ and refs/heads/brigadier/${runId ?? "<run>"}: ${
            unexpected.map(refNameOf).join(", ") || "none"
          }`,
      );
      // Ruling 51's split, asserted as the property that makes it worth having:
      // the machinery must NOT be visible to `git branch`, and the deliverable
      // must be. `refs/heads/` is exactly what `git branch` lists.
      const visible = appeared.map(refNameOf).filter((r) => r.startsWith("refs/heads/"));
      checks.expect(
        "the machinery is invisible to `git branch` and only the deliverable is not (ruling 51)",
        runId !== undefined && visible.length === 1 && visible[0] === `refs/heads/brigadier/${runId}`,
        `refs under refs/heads/ that appeared: ${visible.join(", ") || "NONE"} — the operator's branch list must gain exactly the deliverable`,
      );
      // Ruling 50's scratch base. The previous check looked for the substring
      // `refs/brigadier/base/`, which is not a shape this product ever writes —
      // it was vacuously true and asserted nothing. The base is now read out of
      // the record and confirmed to be a real commit the deliverable descends
      // from, which is what makes `git diff <base>..<itemRef>` re-derivable.
      const base = evidence.record?.base;
      const baseType = base === undefined ? undefined : await objectType(repo, base.sha);
      const baseReached =
        base !== undefined && evidence.refSha !== undefined && (await isAncestor(repo, base.sha, evidence.refSha));
      checks.expect(
        "the scratch base is a real commit the deliverable descends from (ruling 50)",
        base !== undefined && baseType === "commit" && baseReached,
        base === undefined
          ? "the record names no base, so no item's diff can be re-derived from the evidence"
          : `base ${base.ref} -> ${base.sha.slice(0, 12)} (git cat-file -t: ${baseType ?? "no object"}, ancestor of the deliverable: ${baseReached})`,
      );
      const baseLine = appeared.find((line) => refNameOf(line) === base?.ref);
      checks.expect(
        "if the base ref survived the run it is in the invisible namespace, pinned where the record says",
        base === undefined || baseLine === undefined || (owned(baseLine) && shaOf(baseLine) === base.sha),
        baseLine === undefined
          ? `${base?.ref ?? "the base ref"} is not in the operator's ref list — cleaned up, and the commit itself is still reachable`
          : `${baseLine} against the record's ${base?.sha ?? "<none>"}`,
      );
      const drift = diffRepo(before, after).filter((d) => d.field !== "refs");
      checks.expect(
        "the operator's repository is byte-identical afterwards, including after cleanup",
        drift.length === 0,
        drift.length === 0
          ? `HEAD, status, .git/index and the working tree all unchanged (index ${before.indexHash.slice(0, 12)}, tree ${before.treeHash.slice(0, 12)})`
          : drift.map((d) => `${d.field}: ${excerpt(d.before, 60)} -> ${excerpt(d.after, 60)}`).join("; "),
      );
      checks.expect(
        "the integration branch the record NAMES is the one that survived cleanup",
        runId !== undefined &&
          evidence.record?.integrationRef === `refs/heads/brigadier/${runId}` &&
          appeared.some((line) => refNameOf(line) === evidence.record?.integrationRef),
        `record.integrationRef: ${evidence.record?.integrationRef ?? "NONE"}; refs that appeared under refs/heads/: ${
          visible.join(", ") || "NONE"
        }`,
      );

      // Ruling 61, by realpath.
      const runRoot = evidence.record?.runRoot;
      checks.expect(
        "the run directory really existed, outside every temp root (ruling 61)",
        runRoot !== undefined && insideTempRoot(runRoot) === undefined,
        runRoot === undefined ? "no run root in the record" : (insideTempRoot(runRoot) ?? `${runRoot} — resolved with realpath`),
      );

      // ---- ruling 54's three filters, each driven by its OWN cause ---------
      //
      // Three drives of the real binary, one per filter, and the machine is
      // never lied to: `--dry-run` admits the plan and stops, so the memory
      // figure in the RAM sentence is this host's `totalmem()` and nothing
      // else. See the header for why the plan is sized above the machine rather
      // than the machine constrained below the plan.
      //
      // The RAM drive goes FIRST because its answer is what sizes the other
      // two. A one-item plan and `--workers 2` are only below the RAM cap on a
      // host that can hold three workers — 16 GiB — and assuming that silently
      // put every smaller machine in a band where all three drives bind on RAM.
      const fanOutRepo = join(ctx.workdir, "fanout-repo");
      await makeRepo(fanOutRepo, { "README.md": "base\n" });
      // `--dry-run` never reads a worker's checkout, so no seed is planted for
      // these: the filters are decided at admission, from the plan's shape, the
      // operator's flag and the machine.
      const driveFanOut = async (name: string, items: number, extra: string[] = []): Promise<BindingLine | undefined> => {
        const planFile = writePlan(ctx.workdir, disjointPlan(items, name).plan, `${name}.json`);
        const result = await ctx.run(
          ["run", "--plan", planFile, "--repo", fanOutRepo, "--run-root", runs, "--dry-run", ...extra],
          { env, timeoutMs: 120_000 },
        );
        return waveOne(result.stdout);
      };

      // How many items it takes for RAM to bind is a property of THIS machine,
      // so it is discovered by climbing rather than computed from a copy of the
      // product's per-worker budget.
      const climbed: string[] = [];
      let ram: BindingLine | undefined;
      for (const size of RAM_LADDER) {
        const line = await driveFanOut(`ram-${size}`, size, ["--workers", String(WORKERS_ABOVE_ANY_MACHINE)]);
        climbed.push(`${size} item(s) -> ${line?.filter ?? "no wave-one sentence"}`);
        if (line?.filter === "feasibility") {
          ram = line;
          break;
        }
      }
      // The product's own measurement of this machine, taken out of the
      // sentence it just printed rather than recomputed here.
      const measuredCap = ram?.workers;
      const sizing = measuredCap === undefined ? null : planTheOtherTwoDrives(measuredCap);

      const observed: FanOutObservation[] = [];
      if (sizing !== null) {
        const solo = await driveFanOut("solo", sizing.itemCountItems);
        const capped = await driveFanOut("capped", sizing.desirabilityItems, [
          "--workers",
          String(sizing.desirabilityWorkers),
        ]);
        observed.push(
          { cause: `a ${sizing.itemCountItems}-item plan`, wants: "item-count", sentence: solo?.text ?? "" },
          {
            cause: `${sizing.desirabilityItems} items with --workers ${sizing.desirabilityWorkers}`,
            wants: "desirability",
            sentence: capped?.text ?? "",
          },
        );
      }
      observed.push({
        cause: `more items than this machine's RAM allows, with --workers ${WORKERS_ABOVE_ANY_MACHINE}`,
        wants: "feasibility",
        sentence: ram?.text ?? "",
      });

      did.push(
        `drove ruling 54's filters through the real binary with --dry-run — RAM ladder: ${climbed.join("; ")}; ` +
          `the binary measured its own feasibility cap at ${measuredCap ?? "no value"} worker(s), and the other two drives were sized from it: ` +
          (sizing === null
            ? `NOT SIZEABLE — below ${MIN_CAP_TO_DISTINGUISH} there is nothing strictly under the cap to drive them with`
            : `${sizing.itemCountItems} item(s) for item-count, ${sizing.desirabilityItems} items with --workers ${sizing.desirabilityWorkers} for desirability`),
      );

      checks.absorb(judgeFanOutFilters(observed));
      // The row that stops a host too small to separate the causes from
      // silently proving less than this item claims. It is a judge rather than
      // an inline predicate for the reason written above it: an inline boolean
      // here had no test of its own and could be replaced with `true` without
      // one of 173 tests noticing.
      checks.absorb(judgeHostCanDistinguish(measuredCap));

      live = { kind: "ran", checks };
    }

    return combine(did, credentialFree, live);
  },
};

export default item;
