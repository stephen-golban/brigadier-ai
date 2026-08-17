// SPDX-License-Identifier: Apache-2.0
/**
 * Splitting an item into the half a bare CI machine can grade and the half that
 * needs a credentialed one, and never letting the second hide the first.
 *
 * The reproduced defect: against a binary whose `competence` subcommand printed
 * NOTHING AT ALL, item 5 reported `SKIPPED — requires real vendor agents`. It
 * had already computed the credential-free judgement and thrown it away. Four
 * other items did the same — item 9 with ruling 57's refusal, item 6 with the
 * ladder at admission, item 13 with the estimate range, item 12 with ruling
 * 50's clone scan — so `BAR.md`'s authoritative CI leg, which has no vendor
 * credentials by construction, could grade at most 3 of 13 items forever.
 *
 * The rule below is one line and it is the fix: **the credential-free half is
 * consulted first, and if it failed the item fails.** An unbuilt feature can
 * never wear "uncredentialed" as a disguise, because being uncredentialed is
 * only ever an answer to the second question.
 */

import type { BarResult, Halves, Outcome } from "../types.ts";
import { Checks } from "./checks.ts";
import type { FeatureProbe } from "./feature.ts";

export type LiveHalf =
  /** The live half ran. Its checks decide. */
  | { kind: "ran"; checks: Checks }
  /** Legal skip: real vendor agents are required and `--live` was not passed. */
  | { kind: "skipped"; why: string }
  /** The artifact does not implement the feature. Always a FAIL, never a skip. */
  | { kind: "missing"; probe: FeatureProbe; promise: string }
  /** This item has no live half at all — everything it proves is credential-free. */
  | { kind: "none" };

function liveOutcome(live: LiveHalf): Outcome {
  switch (live.kind) {
    case "ran":
      return live.checks.passed ? "PASS" : "FAIL";
    case "skipped":
      return "SKIPPED";
    case "missing":
      return "FAIL";
    case "none":
      return "PASS";
  }
}

function renderLive(live: LiveHalf): string {
  switch (live.kind) {
    case "ran":
      return live.checks.render();
    case "skipped":
      return `SKIPPED — ${live.why}. This BLOCKS exactly as a FAIL does (ruling 48)`;
    case "missing":
      return `FAIL — the artifact does not implement this yet: ${live.promise}\n${live.probe.transcript}`;
    case "none":
      return "this item has no live half — everything it proves is checkable without vendor credentials";
  }
}

export function combine(did: string[], credentialFree: Checks, live: LiveHalf): BarResult {
  const halves: Halves = {
    credentialFree: credentialFree.passed ? "PASS" : "FAIL",
    live: liveOutcome(live),
  };

  const observed = [
    "── credential-free half ──",
    credentialFree.rows.length > 0 ? credentialFree.render() : "no credential-free assertions in this item",
    "── live half ──",
    renderLive(live),
  ].join("\n");

  // The whole point of this file: the credential-free half is asked first.
  if (!credentialFree.passed) {
    const extra =
      live.kind === "missing"
        ? `; and the live half cannot run at all — ${live.promise}`
        : live.kind === "skipped"
          ? "; the live half was skipped, which does not excuse the above"
          : "";
    return {
      outcome: "FAIL",
      did: did.join("\n"),
      observed,
      reason: `${credentialFree.reason() ?? "a credential-free assertion failed"}${extra}`,
      halves,
    };
  }

  if (live.kind === "missing") {
    return {
      outcome: "FAIL",
      did: did.join("\n"),
      observed,
      reason:
        `the artifact does not implement this yet — ${live.promise}. Reported FAIL rather than SKIPPED: ` +
        `ruling 48 makes an unrun check block, and "the feature is missing" is not a legal cause of a skip`,
      halves,
    };
  }

  if (live.kind === "skipped") {
    return {
      outcome: "SKIPPED",
      did: did.join("\n"),
      observed,
      reason: `${live.why}. This BLOCKS exactly as a FAIL does — ruling 48`,
      halves,
    };
  }

  const failed = live.kind === "ran" && !live.checks.passed;
  return {
    outcome: failed ? "FAIL" : "PASS",
    did: did.join("\n"),
    observed,
    ...(failed && live.kind === "ran" && live.checks.reason() !== undefined
      ? { reason: live.checks.reason() as string }
      : {}),
    halves,
  };
}

/** An empty credential-free half, for items where everything needs credentials. */
export function noCredentialFreeChecks(): Checks {
  return new Checks();
}
