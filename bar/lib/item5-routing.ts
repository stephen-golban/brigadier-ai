// SPDX-License-Identifier: Apache-2.0
/**
 * Where item 5's defect plant is allowed to land, and the control that says so.
 *
 * MEASURED on this host on 2026-08-19. Item 5 planted defect-catching capability
 * on the fixture vendor `copilot` and asked the product to review. brigadier
 * routes the FIRST resolved agent as the builder and picks the reviewer from the
 * competence table's reviewer half (`src/queue/review.ts`, `chooseReviewer`), and
 * on that machine the answer was: `copilot` builds, `qwen` reviews. So the
 * capability sat on the builder, the reviewer had none, and the run published
 *
 *     catch rate 0 of 5
 *
 * — a plausible, quotable number that was relayed to the owner as a FALSIFICATION
 * of ruling 52 before anyone noticed it was a fact about a fixture config file.
 *
 * That is the most dangerous defect class this harness can produce. Every other
 * harness fault found in this project announced itself by breaking something; a
 * misrouted plant renders as a clean measurement and enters the permanent record
 * as evidence. So two rules are mechanised here:
 *
 *   **The plant follows the routing.** Which vendor reviews is READ from the run
 *   record a real run produced, never assumed and never hard-coded to a vendor
 *   id. `readRouting` is that read.
 *
 *   **A misrouted plant is `error`, never a low catch rate.** `judgePlantRouting`
 *   compares the vendor the harness configured against the vendor the record
 *   names as reviewer AND against the vendor that really ran as reviewer in the
 *   harness's own ledger. When they disagree the item blocks (ruling 52) and the
 *   number is withheld, because a number produced by a plant on the wrong vendor
 *   is not a measurement of anything.
 *
 * Both functions are pure and take strings, so the negative control is a test
 * rather than a hope (ruling 62b): `item5-routing.test.ts` replays the exact
 * 2026-08-19 misrouting and asserts this module refuses it.
 */

/** What one run said about who played which role. */
export interface RoutingReading {
  /** `reviewerAgent` for the measured item, as the RECORD names it. */
  recordReviewer: string | undefined;
  /** `builderAgent` for the measured item, as the RECORD names it. */
  recordBuilder: string | undefined;
  /**
   * Distinct vendors that really ran as reviewer, from the harness's ledger.
   *
   * A record is the product's account of itself and a forger writes it; a ledger
   * line is a file a process had to exist to append to. The routing decision is
   * taken only when both agree, because planting on the strength of the record
   * alone would let a record that names the wrong vendor move the plant.
   */
  ledgerReviewers: readonly string[];
  ledgerBuilders: readonly string[];
}

export interface RoutedReviewer {
  /** The vendor to configure defect-catching on. `undefined` means: do not plant. */
  vendor: string | undefined;
  /** What was seen, named, ready to paste into a failure. */
  detail: string;
}

/**
 * Who reviewed, according to a run that already happened.
 *
 * Answers `undefined` — refusing to guess — unless the record names exactly one
 * reviewer, the ledger names exactly one reviewer, and they are the same string.
 * Refusing is the safe direction: a plant that is not placed produces a blocking
 * `error`, while a plant placed on a guess produces a number.
 */
export function readRouting(r: RoutingReading): RoutedReviewer {
  const seen =
    `record names builder ${r.recordBuilder ?? "NONE"} / reviewer ${r.recordReviewer ?? "NONE"}; ` +
    `ledger recorded builders [${r.ledgerBuilders.join(", ") || "none"}] and reviewers [${r.ledgerReviewers.join(", ") || "none"}]`;

  if (r.recordReviewer === undefined || r.recordReviewer.length === 0) {
    return { vendor: undefined, detail: `${seen} — no reviewer to plant on, so nothing is planted and the catch rate is not measured` };
  }
  if (r.ledgerReviewers.length !== 1) {
    return {
      vendor: undefined,
      detail: `${seen} — the ledger must name exactly ONE vendor that ran as reviewer for the plant to have a target`,
    };
  }
  if (r.ledgerReviewers[0] !== r.recordReviewer) {
    return {
      vendor: undefined,
      detail: `${seen} — the record and the ledger DISAGREE about who reviewed, so neither may place the plant`,
    };
  }
  return { vendor: r.recordReviewer, detail: `${seen} — routing run says ${r.recordReviewer} reviews` };
}

/** A fixture vendor as `bar/fakes/vendor.ts` reads it. */
export interface FixtureVendor {
  id: string;
  version: string;
  catches?: string[];
  dieAsReviewer?: boolean;
}

/**
 * The fleet to plant, with the reviewer-only capability attached BY ROUTING.
 *
 * Every reviewer-only fixture capability goes through here — `catches` for the
 * catch rate, `dieAsReviewer` for ruling 52's blocker — because both were
 * hard-coded to `copilot` and both were therefore on the builder. A
 * `dieAsReviewer` on the builder never fires; a `catches` on the builder
 * publishes zero. One of those failures is loud and the other is quotable.
 *
 * An unknown reviewer attaches the capability to NOBODY. That is the safe
 * direction: a fleet with no capability anywhere makes `judgePlantRouting`
 * report `error`, where a guess would make it report a number.
 */
export function fleetFor(
  vendors: readonly { id: string; version: string }[],
  routedReviewer: string | undefined,
  capability: { catches?: readonly string[]; dieAsReviewer?: true },
): FixtureVendor[] {
  return vendors.map((v) =>
    routedReviewer !== undefined && v.id === routedReviewer
      ? {
          ...v,
          ...(capability.catches === undefined ? {} : { catches: [...capability.catches] }),
          ...(capability.dieAsReviewer === true ? { dieAsReviewer: true } : {}),
        }
      : { ...v },
  );
}

export interface PlantRouting {
  /** The vendor this harness configured defect-catching on. */
  configured: string | undefined;
  /** The vendor the MEASURED run's record names as the reviewer of that item. */
  recordReviewer: string | undefined;
  /** The vendor that record names as the builder. */
  recordBuilder: string | undefined;
  /** Vendors that really ran as reviewer in the measured run, from the ledger. */
  ledgerReviewers: readonly string[];
}

export interface PlantVerdict {
  /** True only when the plant landed on the vendor that actually reviewed. */
  onTarget: boolean;
  /** Named for the reader: what went wrong, or what lined up. */
  detail: string;
}

/**
 * The control that would have caught 2026-08-19.
 *
 * It asserts an identity between two NAMES, never a count: the vendor the
 * harness configured to catch defects and the vendor the run says reviewed. A
 * count would have been satisfied by `caught 0 of 5`, which is exactly what the
 * misrouted run produced.
 */
export function judgePlantRouting(r: PlantRouting): PlantVerdict {
  const seen =
    `plant configured on ${r.configured ?? "NO VENDOR"}; record names builder ${r.recordBuilder ?? "NONE"} ` +
    `and reviewer ${r.recordReviewer ?? "NONE"}; ledger reviewers [${r.ledgerReviewers.join(", ") || "none"}]`;

  if (r.configured === undefined || r.configured.length === 0) {
    return { onTarget: false, detail: `${seen} — no plant was placed at all, so there is no catch rate to read` };
  }
  if (r.recordReviewer === undefined || r.recordReviewer.length === 0) {
    return { onTarget: false, detail: `${seen} — the measured run names no reviewer, so nothing reviewed the plant` };
  }
  if (r.configured === r.recordBuilder && r.configured !== r.recordReviewer) {
    return {
      onTarget: false,
      detail:
        `${seen} — THE PLANT IS ON THE BUILDER. This is the 2026-08-19 defect exactly: the reviewer has no ` +
        "defect-catching capability at all, so the run publishes a low rate that is a fact about a fixture " +
        "config file and not about any reviewer",
    };
  }
  if (r.configured !== r.recordReviewer) {
    return { onTarget: false, detail: `${seen} — the plant is on a vendor that did not review` };
  }
  if (!r.ledgerReviewers.includes(r.configured)) {
    return {
      onTarget: false,
      detail: `${seen} — the record names ${r.recordReviewer} as reviewer but no such vendor PROCESS ran as one`,
    };
  }
  return { onTarget: true, detail: `${seen} — the plant is on the vendor that reviewed, so the rate below is readable` };
}

/**
 * Set equality on NAMES, with both sides of the difference reported.
 *
 * `.every()` is true of an empty array and `.length` is true of the wrong three,
 * and this harness has shipped both mistakes. The markers are generated after
 * the binary is built, so naming them is the only claim a printer cannot make.
 */
export function nameDiff(
  reported: readonly string[],
  expected: readonly string[],
): { equal: boolean; missing: string[]; unexpected: string[] } {
  const missing = expected.filter((m) => !reported.includes(m));
  const unexpected = reported.filter((m) => !expected.includes(m));
  return { equal: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}
