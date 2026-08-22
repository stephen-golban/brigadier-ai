// SPDX-License-Identifier: Apache-2.0
/**
 * A vendor that just failed, and what brigadier does about it.
 *
 * D8, D9 and D18, which amend rulings 24 and 32. The thing being replaced is
 * described honestly in ruling 81's own comment and in `src/queue/execute.ts`:
 * *"brigadier has never measured a way to read remaining quota on any vendor"*,
 * so `quota[agent.id]` is `"unreadable"` for five of six and `"unpriceable"` for
 * opencode. **What ships is ruling 24's reactive ladder, and it should stop
 * being described as graceful failover** — it costs a burnt attempt every time.
 *
 * **D8 — any failure routes to another vendor, and quota is never read.** A
 * failure is signal enough. There is nothing to read, no vendor exposes it
 * except Codex out of band (`profiles.ts:308`, unused), and a design waiting for
 * a signal that does not exist is a design that never fires.
 *
 * **D9 — a failure matching NO KNOWN CLASS defaults to *the work failed*, not
 * *the vendor failed*.** Ruling 24's rung 1 first, rung 2 after. This is the
 * rule that keeps the mechanism from being worse than nothing: routing away on
 * every unclassified failure walks broken work down the whole fleet, one burnt
 * attempt per vendor, and ends with a report blaming six vendors for one bad
 * plan.
 *
 * **D18 — a cold vendor stays eligible as a REVIEWER and is removed from
 * BUILD.** A reviewer failure costs one turn and blocks nothing; a builder
 * failure costs an attempt. And cold expires on elapsed time with a re-probe,
 * **never on a vendor's stated reset** — `resetsAt` is already recorded as
 * drifting with wall clock, so trusting it means trusting a clock that was
 * measured wrong.
 */

/**
 * Why a vendor stopped taking work.
 *
 * A CLOSED SET, and the closure is the mechanism rather than tidiness: D9 turns
 * on the difference between a failure this list recognises and one it does not,
 * so a catch-all member would delete the distinction the rule is made of.
 */
export type FailureClass =
  /** The vendor refused the credential. Measured on four of six under a redirect. */
  | "credential"
  /** The vendor said no more, in whatever words. Rate limit, quota, billing. */
  | "exhausted"
  /** The process never spoke ACP: bad argv, missing binary, a handshake that hung. */
  | "unstartable";

/**
 * Does this failure say something about the VENDOR?
 *
 * The patterns are deliberately narrow and each is anchored on a phrase measured
 * in this repository or published by the vendor. **A message this does not
 * recognise returns `undefined`, which is D9's default and means *the work
 * failed*** — the item retries on ruling 24's rung 1 and the vendor keeps its
 * place in the fleet.
 */
export function classify(message: string): FailureClass | undefined {
  const text = message.toLowerCase();
  // MEASURED on this fleet: `-32000 Authentication required` (codex, qwen, and
  // the Claude bridge under a redirected config root), `Not logged in` (the
  // claude CLI), `Gemini API key is missing or not configured`.
  if (/authentication required|unauthorized|not (?:logged in|authenticated)|api key is missing/.test(text)) {
    return "credential";
  }
  if (/rate limit|quota|too many requests|429|usage limit|insufficient (?:credit|balance)|billing/.test(text)) {
    return "exhausted";
  }
  // MEASURED 2026-08-20: an argv the vendor rejects exits 1 before any protocol
  // — `unknown option`, `Unknown arguments`, `unknown argument`.
  if (/unknown (?:option|argument)|command not found|enoent|did not answer within|handshake/.test(text)) {
    return "unstartable";
  }
  return undefined;
}

/**
 * How long a vendor stays cold, per class.
 *
 * **JUDGEMENTS, NOT MEASUREMENTS**, and they are printed beside every exclusion
 * they cause. The shape is measured: a credential failure will not fix itself in
 * five minutes and needs a person, while an exhausted vendor recovers on
 * somebody else's clock — so the two cannot share a number.
 *
 * D18's rule about which clock: **elapsed time and a re-probe, never the
 * vendor's stated reset.** `resetsAt` is recorded in this repository as drifting
 * with wall clock, so a design that waited for it would be waiting on a number
 * measured to be wrong.
 */
export const COLD_MS: Record<FailureClass, number> = {
  // Long, because nothing brigadier does can fix it and re-probing every minute
  // spends a handshake to be told the same thing.
  credential: 30 * 60_000,
  // The one that really does recover on its own.
  exhausted: 15 * 60_000,
  // Usually a stale coordinate or a vendor upgrade — ruling 69's territory, and
  // a re-probe is exactly what resolves it.
  unstartable: 10 * 60_000,
};

export interface ColdEntry {
  readonly agent: string;
  readonly why: FailureClass;
  /** When it went cold. Compared against elapsed time, never against `resetsAt`. */
  readonly since: number;
  /** The vendor's own words, so the report never paraphrases a refusal. */
  readonly said: string;
}

/**
 * D8: mark a vendor cold, where the failure said something about the vendor.
 *
 * Returns the state unchanged for an unclassified failure — D9 — and that is the
 * whole of the rule rather than an optimisation.
 */
export function markCold(
  cold: readonly ColdEntry[],
  agent: string,
  message: string,
  now: number,
): { cold: ColdEntry[]; classified: FailureClass | undefined } {
  const why = classify(message);
  if (why === undefined) return { cold: [...cold], classified: undefined };
  return {
    cold: [...cold.filter((entry) => entry.agent !== agent), { agent, why, since: now, said: message }],
    classified: why,
  };
}

/** Entries whose window has elapsed. D18: elapsed time, then a re-probe. */
export function thawed(cold: readonly ColdEntry[], now: number): ColdEntry[] {
  return cold.filter((entry) => now - entry.since >= COLD_MS[entry.why]);
}

export function stillCold(cold: readonly ColdEntry[], now: number): ColdEntry[] {
  return cold.filter((entry) => now - entry.since < COLD_MS[entry.why]);
}

/**
 * D18: who may still BUILD, and who may still REVIEW.
 *
 * The asymmetry is the decision. A cold vendor is removed from build because a
 * builder failure costs an attempt; it stays eligible as a reviewer because a
 * reviewer failure costs one turn and blocks nothing — and ruling 32 already
 * prefers a cross-vendor reviewer over a same-vendor one, so excluding a cold
 * vendor from review would trade a real property for a hypothetical failure.
 *
 * **THE EXCEPTION, and it is not a softening: a fleet with no warm builder left
 * builds anyway.** Refusing would turn a rate limit into a failed run on a
 * single-vendor machine, which is the configuration ruling 32 made supported and
 * common. The report says the vendor was cold and was used regardless.
 */
export function eligibility(
  agents: readonly string[],
  cold: readonly ColdEntry[],
  now: number,
): { builders: string[]; reviewers: string[]; forced: boolean; lines: string[] } {
  const frozen = new Map(stillCold(cold, now).map((entry) => [entry.agent, entry]));
  const warm = agents.filter((agent) => !frozen.has(agent));
  const lines = [...frozen.values()].map(
    (entry) =>
      `${entry.agent} is cold for ${Math.round(COLD_MS[entry.why] / 60_000)} min (${entry.why}) and is out of BUILD ` +
      `but still eligible to REVIEW (D18) — it said: ${entry.said}. That window is a judgement, not a measurement, ` +
      "and it expires on elapsed time with a re-probe rather than on the vendor's stated reset, which was recorded " +
      "drifting with wall clock.",
  );
  if (warm.length === 0 && agents.length > 0) {
    lines.push(
      "every vendor on this machine is cold, so the run BUILDS ON A COLD VENDOR anyway: refusing here would turn a " +
        "rate limit into a failed run on a single-vendor machine, which ruling 32 makes a supported configuration.",
    );
    return { builders: [...agents], reviewers: [...agents], forced: true, lines };
  }
  // Reviewers: everybody, cold included. See the doc comment.
  return { builders: warm, reviewers: [...agents], forced: false, lines };
}
