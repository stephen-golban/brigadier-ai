// SPDX-License-Identifier: Apache-2.0
/**
 * The `research` work kind: what brigadier asks a workhorse when the goal turns
 * on a fact the fleet's training does not contain.
 *
 * Ruling 78 and decision D22. The staleness this exists for is real and had no
 * ruling anywhere in the record until 2026-08-21: across 345,173 bytes of issue
 * #1 there are **zero** mentions of research, web search or date-freshness. Not
 * refused, not deferred, not out of scope — absent. Meanwhile a model asked
 * about a library reaches for 2024 and 2025 when it is 2026, and a plan built on
 * that is wrong before the first worker spawns.
 *
 * WHERE IT RUNS, and this is ruling 84 rather than an implementation choice.
 * Research is a phase BEFORE the planner, commissioned by brigadier from the
 * operator's own sentence, and its finding goes into the planner's brief. It is
 * NOT a kind a plan may declare. Ruling 78 describes a research item's text as
 * *"a finding carried into a later item's brief"*, and `PLANNER_RULES` rule 6
 * denies exactly that channel — *"`dependsOn` is a wave boundary, not a
 * channel"*, so one item cannot see another's output. The pre-plan phase needs
 * no such channel: `PRODUCT.md` section 1 orders it *research, then plan*, and
 * that is the order that costs nothing to build.
 *
 * WHAT MAKES A FINDING ACCEPTABLE — D22, and it is a SHAPE check, not a truth
 * check. The brief names today's date, requires each source to carry its own
 * date, and requires the finding to end by saying when it was taken. That is
 * `AGENTS.md`'s own standing discipline — *"Record results as MEASURED against
 * `<tool> <version>` on `<date>`, never in the present tense"* — pointed at a
 * worker instead of at ourselves. A finding with no date is REJECTED, exactly as
 * a reviewer with no verdict is `error` and blocks under ruling 52.
 *
 * **THE ACCEPTED COST, which ruling 78 already recorded: a worker that fabricates
 * a date passes.** This verifies that a claim *carries* a date, not that the date
 * is true — the same limit ruling 30 accepts about effort, ruling 67 about
 * difficulty and ruling 74 about the plan itself. Fourth instance of one shape,
 * which makes it a property of driving somebody else's model rather than an
 * oversight.
 */

import type { AgentId } from "../agent/profiles.ts";

/** The trailer every finding must end with. Mechanical, so it needs no judgement. */
export const AS_OF = "AS OF:";

/** The heading its sources sit under. */
export const SOURCES = "SOURCES:";

/**
 * An ISO date, and only an ISO date.
 *
 * A model asked for "a date" writes `March 2026`, `2026-03`, `03/14/26` and
 * `last Tuesday`, and a checker that accepted all of those would be a checker
 * that accepts anything. The brief asks for one format; this is that format.
 */
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

/**
 * Everything the brief says that does not depend on the question.
 *
 * BEFORE the varying part at every call site: ruling 21 measured a **16.5×**
 * cache lever on a byte-stable prefix, and ruling 16 makes the worker brief
 * byte-identical across agents on purpose.
 */
export const RESEARCH_RULES = `You are brigadier's researcher. You find out what is true TODAY and you do not do the work.

You have a web tool. Use it. Do not answer from memory: your training has a cutoff and this
task exists because that cutoff is the problem. If a thing you are asked about has a version,
a release, a deprecation or a price, look it up.

Return your answer in EXACTLY this shape, and nothing else:

  FINDING:
  <what is true, in plain sentences. State the thing itself, not how you looked for it.>

  ${SOURCES}
  - <url or the name of the thing you read> — <the date THAT SOURCE carries, as YYYY-MM-DD>
  - <one line per source, at least one>

  ${AS_OF} <today's date, as YYYY-MM-DD>

The rules, each of which is checked and will refuse your answer:

  1. Every source line carries a date IN YYYY-MM-DD, and it is the date that source itself
     carries — a changelog entry's date, a release date, a page's last-updated date. Not the
     date you read it. If a source shows no date, say \`undated\` and say so in the finding too.
  2. The ${AS_OF} line is the date given to you below, in YYYY-MM-DD. It is when this was taken.
  3. If the web tool fails or returns nothing, say so in FINDING and write \`${AS_OF} <the date
     given below>\` anyway. A failed search reported plainly is a useful answer. A guess dressed
     as a finding is not, and it is the thing this whole kind exists to prevent.
  4. No preamble, no offer to continue, nothing after the ${AS_OF} line.

Be short. What you return is carried into another model's brief, and every byte of it is paid
for twice.`;

export interface ResearchRequest {
  /** What brigadier wants to know, derived from the operator's goal. */
  readonly question: string;
  /** Today, as `YYYY-MM-DD`. Brigadier supplies it; a worker cannot be asked to know it. */
  readonly today: string;
  /** For orientation only — a finding is about the world, not about this tree. */
  readonly repoName: string;
}

/** The full brief: stable rules first, then the varying part. See `RESEARCH_RULES`. */
export function researchBrief(request: ResearchRequest): string {
  return [
    RESEARCH_RULES,
    "",
    `Today's date is ${request.today}. Use exactly that on the ${AS_OF} line.`,
    `The repository this is for is ${request.repoName}, for context only.`,
    "",
    "WHAT TO FIND OUT:",
    "",
    request.question,
    "",
    "Return your answer now.",
  ].join("\n");
}

/**
 * A finding that cannot be used, with what was actually received.
 *
 * Separate from a vendor refusal for ruling 52's reason: a `fail` sends somebody
 * to fix the work and an `error` sends them to fix the checker, and telling an
 * operator their researcher was undated when the truth is that it was never
 * allowed to answer sends them to the wrong place.
 */
export class FindingUnusable extends Error {
  constructor(
    readonly agent: AgentId | string,
    why: string,
    /** The raw text, so a person can see what the model actually said. */
    readonly received: string,
  ) {
    super(`the researcher (${agent}) did not return a usable finding: ${why}`);
    this.name = "FindingUnusable";
  }
}

export interface Finding {
  /** The finding as it will be carried into the planner's brief. */
  readonly text: string;
  /** The date the finding says it was taken. */
  readonly asOf: string;
  /** One line per source, each with the date that source carries. */
  readonly sources: readonly string[];
}

/**
 * D22's rule, enforced.
 *
 * **It refuses rather than repairing.** A finding missing its date could be
 * stamped with today's date here and nobody would see the difference — which is
 * the point: the stamp would be brigadier's, the claim would be the worker's,
 * and the record would show a dated finding that nobody dated. Ruling 52's
 * shape: a missing result must never render as a satisfied requirement.
 *
 * The `AS OF` date must be the date brigadier NAMED in the brief. That is a
 * weaker check than it looks and is meant to be — see the module comment's
 * accepted cost — but it is strictly stronger than accepting any date, because a
 * model answering from memory reaches for the year it was trained in, and that
 * is the failure this kind exists for.
 */
export function requireDatedFinding(text: string, today: string, agent: AgentId | string): Finding {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new FindingUnusable(agent, "it returned nothing at all", text);
  }

  const asOfLine = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(AS_OF))
    .at(-1);
  if (asOfLine === undefined) {
    throw new FindingUnusable(
      agent,
      `there is no \`${AS_OF} <date>\` line, so the finding does not say when it was taken (D22)`,
      text,
    );
  }
  const stamped = ISO_DATE.exec(asOfLine)?.[0];
  if (stamped === undefined) {
    throw new FindingUnusable(agent, `the \`${AS_OF}\` line carries no YYYY-MM-DD date`, text);
  }
  if (stamped !== today) {
    throw new FindingUnusable(
      agent,
      `it is dated ${stamped} and this run is ${today}. A finding dated from the model's training is exactly ` +
        "what this kind exists to refuse (D22)",
      text,
    );
  }

  const sources = sourceLines(trimmed);
  if (sources.length === 0) {
    throw new FindingUnusable(
      agent,
      `there are no \`${SOURCES}\` lines, so nothing in the finding can be checked by anyone else`,
      text,
    );
  }
  const undated = sources.filter((line) => !ISO_DATE.test(line) && !/\bundated\b/i.test(line));
  if (undated.length > 0) {
    throw new FindingUnusable(
      agent,
      `${undated.length} source line(s) carry no date and do not say \`undated\` — the first is ${JSON.stringify(undated[0])}`,
      text,
    );
  }

  return { text: trimmed, asOf: stamped, sources };
}

/** The `-` lines under the `SOURCES:` heading, and nothing after `AS OF:`. */
function sourceLines(text: string): string[] {
  const lines = text.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith(SOURCES));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith(AS_OF)) break;
    if (line.startsWith("-")) out.push(line);
  }
  return out;
}

/**
 * Today, as the brief and the checker both mean it.
 *
 * Local rather than UTC, because the operator's *today* is the one they will
 * compare a finding against, and a run at 23:00 in one zone dated tomorrow reads
 * as a fabrication to the only person who can check it.
 */
export function todayStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Does this goal turn on something a model's training cannot be trusted for?
 *
 * D3: *"Planning and research are not forced. Work that needs neither gets
 * neither."* A typo fix does not get a research phase, and a research phase is a
 * whole metered turn before the planning turn that is itself before any work.
 *
 * **This is a heuristic and it is named as one everywhere it is used**, exactly
 * like `looksTrivial`. There is no measurement behind it and there cannot easily
 * be one: whether a sentence turns on a fact the fleet has wrong is a judgement
 * about a world nobody has looked at yet. It only ever suggests — D3 says
 * brigadier **asks the user anyway**, so the answer to this question is a default
 * in a question, never a decision taken silently.
 */
export function looksLikeItNeedsResearch(goal: string): boolean {
  return /\b(latest|current|newest|up[- ]to[- ]date|today|this year|deprecat\w*|migrat\w*|upgrade|bump|version|release|changelog|api|sdk|pricing|breaking change)\b/i.test(
    goal,
  );
}

/** What the planner is told, when a finding exists. One block, clearly bounded. */
export function findingForPlanner(finding: Finding): string {
  return [
    "A RESEARCH FINDING was taken for this goal before you were asked to plan.",
    `It was taken on ${finding.asOf} and it is more current than your training. Where it and`,
    "your instincts disagree, it wins — that is the whole reason it was paid for.",
    "",
    finding.text,
  ].join("\n");
}
