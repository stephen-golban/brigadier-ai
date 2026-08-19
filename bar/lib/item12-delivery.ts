// SPDX-License-Identifier: Apache-2.0
/**
 * Item 12's two gates: **did the item integrate at all**, and **did the granted
 * secret actually travel**.
 *
 * Both exist because of measured instrument defects, not because of a promise
 * the product makes. They are here rather than inside the item so that they can
 * be driven directly by a negative control — a guard that has never been seen
 * to fail looks identical to one that cannot.
 *
 * **GATE ONE — the item integrated.** Item 12's plan declared `config.json`
 * while its fixture also writes `delivery-proof.txt`. Ruling 51's ownership
 * check — computed with `--no-renames`, in the parent, after the fetch —
 * therefore rejected the item WHOLE, correctly, and nothing reached the
 * integration branch. The item then scanned an empty integration for a secret,
 * found none, and called that a pass. The declaration is fixed in the item; this
 * gate is here so the failure cannot recur silently in some other path: a
 * rejected item is reported `error`, NAMING the strayed path, and the leak scan
 * is never reached.
 *
 * **GATE TWO — the secret really travelled.** An independent critic deleted the
 * redaction sink entirely and item 12 still passed, because a secret nobody
 * moved cannot appear anywhere. "The secret is in none of brigadier's artifacts"
 * is trivially true of a run that was never granted one, and the two states are
 * indistinguishable from the scan alone. So the worker must first prove receipt
 * by committing a DERIVATION of the value — `sha256(secret + a nonce this
 * harness generates for this run)`, truncated — which is not the value and not
 * one of the four enumerated encodings, so asserting on it cannot weaken the
 * leak scan. If the derivation is absent from the integrated result the secret
 * never travelled, the item has proved nothing, and it must say so.
 *
 * **THE VOCABULARY, AND HOW IT REACHES THE REPORT.** Ruling 52 has one
 * affirmative outcome and three blocking ones. `BarResult.outcome` has three
 * values — `PASS`, `FAIL`, `SKIPPED` — and both blocking values below map onto
 * `FAIL`, which blocks a tag exactly as ruling 48 requires. The distinction is
 * not decoration and is not lost: the verdict word is carried in the check's own
 * NAME, because "this item measured nothing" and "this item measured the promise
 * and it broke" send a reader to two different places, and an outcome line
 * cannot tell them apart on its own.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "./contract.ts";
import { productRunDir } from "./layout.ts";

/**
 * `pass` is the only affirmative value.
 *
 * `fail`    — the PRODUCT did not do what it promised. Blocks. It exists because
 *             this type had only one blocking value and the sink gate needed
 *             two: `judgeSink`'s leak branch reported `error` while naming
 *             itself `FAIL —`, and every other ruling here puts ruling 52's
 *             verdict word at the front of the name precisely so a reader can
 *             read it there. A name and a verdict that disagree send whoever
 *             reads one of them to the wrong place — to this harness instead of
 *             to the leak. Nothing downstream branches on which blocking value
 *             it is (`verdict === "pass"` is the only test), so the distinction
 *             is entirely for the reader, which is who it was always for.
 * `error`   — the item ran and something it depends on broke. Blocks. BAR.md
 *             names this one specifically: "if that derivation is absent from
 *             the integrated result the item is `error` — never `pass`."
 * `not-run` — the premise never held, so the assertion never happened. Blocks,
 *             and is NEVER reported as a pass: that substitution is the whole
 *             defect this file exists to close. `judgeDelivery` never answers
 *             it — the GATE always ran — but the assertions downstream of a
 *             failed gate are reported with it, because "not attempted" and
 *             "attempted and found nothing" are different facts and the second
 *             is the one a reader would otherwise assume.
 */
export type Item12Verdict = "pass" | "fail" | "error" | "not-run";

/**
 * `src/integrate/ownership.ts`'s refusal, as the operator reads it, matched so
 * the strayed paths can be lifted back out of it.
 *
 * Transcribed rather than imported — nothing under `bar/` imports from `src/` —
 * and deliberately tolerant: an unparseable refusal still produces `error` with
 * the raw sentence, because the outcome must not depend on this regex being
 * right about a wording that may drift.
 */
export const OWNERSHIP_REFUSAL =
  /wrote outside its declared paths and is rejected WHOLE\s+—\s+([\s\S]+?)\.\s+None of its work is integrated/;

/** The qualifier `src/integrate/integrate.ts` attaches to an ownership refusal. */
export const OWNERSHIP_QUALIFIER = "ownership";

export interface IntegrationReading {
  /** Did the record name this plan item at all? */
  found: boolean;
  /** The record's own word for it, or a sentence saying it was not there. */
  status: string;
  integrated: boolean;
  /** Ruling 51 refused this item's work whole. */
  ownershipRejected: boolean;
  /** The paths the refusal named. Identities, never a count. */
  strayed: string[];
  /** Every check the record carries for this item, rendered — on a pass as well. */
  detail: string;
}

/** What the run record says became of one plan item, read without being believed. */
export function readIntegration(record: RunRecord | undefined, itemId: string): IntegrationReading {
  const entry = record?.items.find((i) => i.id === itemId);
  if (entry === undefined) {
    return {
      found: false,
      status: `NOT IN THE RECORD — record.items named ${
        record?.items.map((i) => i.id).join(", ") || "no items at all"
      }`,
      integrated: false,
      ownershipRejected: false,
      strayed: [],
      detail: "the record does not account for this item, so nothing can be said about what it integrated",
    };
  }

  const checks = entry.checks ?? [];
  const refusals = checks.filter(
    (c) =>
      c.outcome !== "pass" &&
      (c.qualifier === OWNERSHIP_QUALIFIER || OWNERSHIP_REFUSAL.test(c.detail ?? "")),
  );
  const strayed = refusals.flatMap((c) => {
    const matched = OWNERSHIP_REFUSAL.exec(c.detail ?? "");
    if (matched?.[1] === undefined) return c.detail === undefined ? [] : [c.detail];
    return matched[1]
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  });

  return {
    found: true,
    status: entry.status,
    integrated: entry.status === "integrated",
    ownershipRejected: refusals.length > 0,
    strayed,
    detail:
      checks.map((c) => `${c.name}=${c.outcome}${c.qualifier === undefined ? "" : ` (${c.qualifier})`}`).join("; ") ||
      "the record carries no checks for this item",
  };
}

export interface DeliveryReading {
  integration: IntegrationReading;
  /** The plan item whose delivery is being judged. */
  itemId: string;
  /** Path in the merged tree the derivation must land at. */
  proofPath: string;
  /** The nonce this harness generated for this run, after the binary was built. */
  nonce: string;
  /** `sha256(granted value + nonce)`, truncated. Not the value, not an encoding of it. */
  expectedProof: string;
  /** What `git cat-file blob` answered at `proofPath`, or `undefined` if the path is absent. */
  proofInTree: string | undefined;
}

export interface DeliveryRuling {
  verdict: Item12Verdict;
  /** Carries the verdict word, because the outcome line cannot. */
  name: string;
  /** The bytes, recorded on a pass as well as a failure. */
  detail: string;
}

/**
 * The delivery clause, in order.
 *
 * Ownership first, because a rejected item explains every absence below it and
 * an item that reported "the derivation is missing" for a run brigadier
 * correctly refused would send a reader to the wrong place entirely.
 */
export function judgeDelivery(r: DeliveryReading): DeliveryRuling {
  const where = `expected ${r.proofPath} to carry ${r.expectedProof} = sha256("<the granted value>:${r.nonce}") truncated to 24 hex`;

  if (r.integration.ownershipRejected) {
    return {
      verdict: "error",
      name: `ERROR — ruling 51 rejected item \`${r.itemId}\` WHOLE, so there is no integrated result to scan`,
      detail:
        `strayed paths: ${r.integration.strayed.join(", ") || "named none"}. ` +
        "This item's plan must declare EVERY path its fixture writes; a plan that under-declares is rejected " +
        "correctly by the product and the item can never reach its own assertion. Reported ERROR rather than " +
        "scanning an empty integration for a secret and calling the absence a pass. " +
        `Record checks: ${r.integration.detail}`,
    };
  }

  if (!r.integration.found || !r.integration.integrated) {
    return {
      verdict: "error",
      name: `ERROR — item \`${r.itemId}\` did not integrate, so no persisted result exists to scan`,
      detail: `status: ${r.integration.status}. Record checks: ${r.integration.detail}`,
    };
  }

  if (r.proofInTree === undefined) {
    // BAR.md, in the owner's own words: "if that derivation is absent from the
    // integrated result the item is `error` — never `pass`." `not-run` is
    // reserved for the assertions DOWNSTREAM of this gate, which genuinely
    // never happened.
    return {
      verdict: "error",
      name: `ERROR — the granted secret never reached the worker, so this item asserted nothing`,
      detail:
        `${r.proofPath} is absent from the merged tree, so the worker never proved it received the value. ` +
        "An unset environment variable and a perfectly contained one produce IDENTICAL scans: a critic deleted " +
        "the redaction sink entirely and this item still passed, because it was proving that a secret nobody " +
        `moved did not move. ${where}`,
    };
  }

  if (!r.proofInTree.includes(r.expectedProof)) {
    return {
      verdict: "error",
      name: `ERROR — the worker's receipt does not derive from the granted value`,
      detail:
        `${r.proofPath} holds ${JSON.stringify(r.proofInTree.trim().slice(0, 80)) || "NOTHING"}; ${where}. ` +
        "Something wrote that file without the secret, so delivery is unproven and the scan below would be " +
        "measuring a run the secret never entered",
    };
  }

  return {
    verdict: "pass",
    name: "the granted secret really reached the worker (ruling 65's channel)",
    detail:
      `the worker committed a DERIVATION of the granted value at ${r.proofPath}: ${r.expectedProof}, ` +
      `which is sha256("<the granted value>:${r.nonce}") truncated. A hash is not one of the four enumerated ` +
      "encodings, so asserting on it proves the value arrived without weakening the leak scan. The nonce was " +
      "generated after the binary under test was built and cannot be baked into it",
  };
}

/**
 * The granted value, generated so that every claim this item makes is reachable.
 *
 * `bar/lib/secret.ts`'s `makeSecret` ends its value with a NEWLINE, and that one
 * character quietly costs the positive half of this item. A `git diff` is
 * line-oriented: it prefixes every line with `+`, so a value containing a
 * newline never appears in a diff as a contiguous run of bytes, and neither
 * ruling 65's sink nor this item's scan can match it there. It is v1's failure 3
 * — "a value spanning the join between two serialised fields" — one format over.
 *
 * What BAR.md actually requires is that the four encodings DISAGREE, so that
 * "literal" and "json-escaped" are different needles rather than the same one
 * twice. `"` and `\` do that on their own; `/`, `+` and `=` separate
 * url-encoded and base64. None of them survives a line break, and none of them
 * needs to.
 *
 * Local to item 12 rather than an edit to `secret.ts`: nothing else calls
 * `makeSecret`, and a shared helper changed for one caller's reasons is how a
 * fixture drifts under everyone else.
 */
export function makeItem12Secret(): string {
  return `bar-secret-${Math.random().toString(36).slice(2, 10)}/+="\\`;
}

// ─────────────────────── GATE THREE — THE SINK FIRED ────────────────────────

// Assembled from parts for the reason `bar/self-check.test.ts` records: a
// literal specifier here would itself read as a reach into `src/`, and the
// scanner would — correctly — flag this file. Reading a file is not importing a
// module; nothing here can execute the product's logic.
export const REDACT_SOURCE = fileURLToPath(
  new URL(["..", "..", "src", "secrets", "redact.ts"].join("/"), import.meta.url),
);

/**
 * The string ruling 65's sink writes where a granted value used to be,
 * recovered from the product's own source.
 *
 * A missing constant is a FINDING, not a default. Falling back to `"[redacted]"`
 * when the product renames it would restore the exact failure this module exists
 * to prevent — an assertion looking for something the product never emits, which
 * fails as loudly as a real leak and teaches the reader to disable it.
 */
export function productPlaceholder(source = readFileSync(REDACT_SOURCE, "utf8")): string {
  const match = /export const PLACEHOLDER\s*=\s*["\'`]([^"\'`]+)["\'`]/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(
      `PLACEHOLDER is not declared in ${REDACT_SOURCE} — item 12 cannot assert that ruling 65's sink fired ` +
        "without knowing what it emits. Re-anchor this, or tell the owner the sink emits nothing assertable.",
    );
  }
  return match[1];
}

export interface SinkReading {
  /** The plan item whose value had to traverse the sink. */
  itemId: string;
  /** The path in the leak item's clone the worker was told to put the value in. */
  leakPath: string;
  placeholder: string;
  /** `transcriptsPath/full.log`, or `undefined` when the record named no transcripts. */
  transcriptPath: string | undefined;
  /** Its lines, or an empty list when it could not be read. */
  transcriptLines: readonly string[];
  /**
   * Did brigadier actually put the granted value on its own writing path?
   *
   * Ruling 65 promises the sink redacts everything BRIGADIER writes. It does not
   * promise the value ever reaches brigadier — a worker that keeps it inside its
   * own clone gives the sink nothing to do, and that is not a product failure.
   * So this item ARRANGES the channel (ruling 52's reviewer is handed
   * `git diff <base>..<itemRef>`, which carries the worker\'s file) and then
   * checks the arrangement held. When it did not, the item proved nothing and
   * says so — an INSTRUMENT failure, labelled as one.
   */
  reviewerAgent: string | undefined;
  reviewVerdict: string | undefined;
  /**
   * Did the RAW value turn up in brigadier's own artifacts, in any enumerated
   * encoding?
   *
   * This is what tells a sink that was DELETED from a sink that was never handed
   * anything, and the first draft of this gate conflated them: with the sink
   * removed the value stood in the transcript in plain sight and the gate
   * reported "the value never reached brigadier's writing path", masking the
   * leak behind an instrument complaint. A missing placeholder BESIDE a present
   * value is a leak, and the leak is what a reader must be sent to.
   */
  leaksFound: readonly string[];
  /**
   * Did the value reach the transcript RE-ENCODED beyond the four enumerated
   * forms — JSON inside JSON?
   *
   * The worker writes a JSON file, so the value is escaped once on disk; the
   * frame carrying that file's diff escapes it again. A doubly-escaped value
   * matches none of `src/secrets/redact.ts`'s four forms, so ruling 65's sink
   * cannot act on it and this item's own scan cannot see it either. That is
   * BAR.md's stated honest limit — "re-encodes it in a scheme we do not
   * enumerate" — and it is a completely different fact from "the value never
   * arrived". Reporting the second when the first is true would send a reader
   * to the channel when the fault is in the encoding.
   */
  doubleEscapedInTranscript: boolean;
}

export interface SinkRuling {
  verdict: Item12Verdict;
  name: string;
  detail: string;
}

/**
 * The positive claim, which is a different claim from the absence beside it.
 *
 * "The secret is in none of brigadier's artifacts" is true of a run where the
 * value never reached brigadier at all, and a live PASS built only on absence
 * cannot tell *the sink caught it* from *the sink was never handed anything*.
 * That is the narrow remnant of this item\'s original sin: a critic deleted the
 * sink and the item passed. So the placeholder must be PRESENT, by identity, in
 * a named artifact, at the place the raw value would otherwise be.
 */
export function judgeSink(r: SinkReading): SinkRuling {
  const arranged = `ruling 52 hands a reviewer \`git diff <base>..<itemRef>\`, which carries ${r.leakPath} and the value in it`;
  const withPlaceholder = r.transcriptLines.filter((l) => l.includes(r.placeholder));
  const namingTheFile = r.transcriptLines.filter((l) => l.includes(r.leakPath));
  const both = r.transcriptLines.filter((l) => l.includes(r.placeholder) && l.includes(r.leakPath));

  // FIRST, because a present value settles every question below it. The sink was
  // handed the value and did NOT replace it: a product failure, not an
  // instrument one, and the reader must be sent to the leak rather than to a
  // complaint about the channel. The first draft of this gate had this branch
  // last and reported "the value never reached brigadier's writing path" for a
  // run in which the value was standing in the transcript in plain sight —
  // masking a real leak behind an instrument excuse.
  if (withPlaceholder.length === 0 && r.leaksFound.length > 0) {
    return {
      verdict: "fail",
      name: `FAIL — ruling 65's sink did NOT fire: ${r.placeholder} is absent and the granted value is PRESENT`,
      detail:
        `${r.transcriptPath ?? "no transcript named"} has ${r.transcriptLines.length} line(s), ` +
        `${namingTheFile.length} naming ${r.leakPath}, NONE holding ${r.placeholder}; the value itself was ` +
        `found in: ${r.leaksFound.join("; ")}. ${arranged}, so the value did reach brigadier's writing path ` +
        "— and came out the other side unchanged",
    };
  }

  if (r.reviewerAgent === undefined || r.reviewVerdict === undefined || r.reviewVerdict === "not-run") {
    return {
      verdict: "error",
      name: "ERROR — the granted value never reached brigadier's writing path, so the sink was never exercised",
      detail:
        `review for \`${r.itemId}\` settled ${r.reviewVerdict ?? "NOT AT ALL"} with reviewer ` +
        `${r.reviewerAgent ?? "none"}. ${arranged}, and without it nothing hands the value to ruling 65's sink. ` +
        "This is an INSTRUMENT failure, not a product one: the product does not promise to redact a value it " +
        "was never given. Reported ERROR rather than passing on an absence that would have been true of an " +
        "empty machine",
    };
  }

  if (r.transcriptPath === undefined || r.transcriptLines.length === 0) {
    return {
      verdict: "error",
      name: "ERROR — brigadier's transcript could not be read, so the sink cannot be shown to have fired",
      detail: `${r.transcriptPath ?? "the record named no transcriptsPath"} yielded ${r.transcriptLines.length} line(s)`,
    };
  }

  if (withPlaceholder.length === 0 && r.doubleEscapedInTranscript) {
    return {
      verdict: "error",
      name: `ERROR — the value reached the transcript RE-ENCODED past ruling 65's four forms, so the sink could not act`,
      detail:
        `${r.transcriptPath ?? "no transcript named"}: ${namingTheFile.length} line(s) name ${r.leakPath}, NONE ` +
        `hold ${r.placeholder}, and the granted value is present JSON-ESCAPED TWICE — once by the worker writing ` +
        "a JSON file, once by the frame carrying that file's diff. `src/secrets/redact.ts` enumerates four forms " +
        "and a doubly-escaped value is not one of them, so the sink cannot see it and neither can this item's " +
        "scan. THIS IS NOT CONTAINMENT AND IT IS NOT A PRODUCT FAILURE: it is BAR.md's stated honest limit, " +
        "and it means this run cannot demonstrate the sink fired. The fix is a channel that carries the value " +
        "at ONE escape level — a plain-text file beside the JSON one",
    };
  }

  if (withPlaceholder.length === 0) {
    return {
      verdict: "error",
      name: `ERROR — ruling 65's placeholder ${r.placeholder} is ABSENT from brigadier's transcript`,
      detail:
        `${r.transcriptPath} has ${r.transcriptLines.length} line(s), ${namingTheFile.length} naming ${r.leakPath}, ` +
        `NONE holding ${r.placeholder}, and the value is nowhere either. ${arranged}, so the value should have ` +
        "passed through this file — nothing did, which means the sink was never handed anything and this item " +
        "proved NOTHING. Absence-of-secret and presence-of-placeholder are different claims, and only the " +
        "second can tell a sink that caught the value from a sink that was never given one",
    };
  }

  if (namingTheFile.length === 0) {
    return {
      verdict: "error",
      name: `ERROR — brigadier's transcript never names ${r.leakPath}, so the value did not travel through it`,
      detail:
        `${withPlaceholder.length} line(s) hold ${r.placeholder}, but none of the ${r.transcriptLines.length} ` +
        `lines names ${r.leakPath}. The placeholder is there for some OTHER value, which is not this item's claim`,
    };
  }

  return {
    verdict: "pass",
    name: `ruling 65's sink FIRED: ${r.placeholder} stands where the granted value was`,
    detail:
      `${r.transcriptPath}: ${withPlaceholder.length} line(s) hold ${r.placeholder}, ${namingTheFile.length} name ` +
      `${r.leakPath}, and ${both.length} hold both. ${arranged}. Reviewer ${r.reviewerAgent} settled ` +
      `${r.reviewVerdict}. This is the POSITIVE half: the value reached brigadier's own writing path and the ` +
      "sink replaced it, which no absence on its own can show",
  };
}

/**
 * Is this path, relative to the run root, inside a WORKER'S CLONE?
 *
 * The boundary the owner ruled on, computed rather than assumed. BAR.md names
 * the round-9 leak explicitly — `r/<run>/1/config.json` — and rules it out of
 * scope: that file is the worker's own artifact, brigadier does not rewrite a
 * worker's commit, and reaching into a clone an agent has touched to do so is
 * what ruling 56 forbids. An item that failed on it would be failing the product
 * for not keeping a promise it never made.
 *
 * The shape is `<RUN_DIR>/<run-id>/<bare item number>/…`, and `RUN_DIR` is
 * recovered from the product's own source by `layout.ts` rather than written
 * here as a literal — the ninth instrument defect of that session was a harness
 * confidently enumerating a path shape the product had never used.
 *
 * SHAPE ONLY, with no filesystem probe: a clone that ruling 63 retained and one
 * that was swept must be classified the same way, and `.git` is present in only
 * one of them.
 *
 * The consequence of getting this WRONG in the generous direction — excluding
 * more than the clones — is a leak scan that reads nothing and reports no hit,
 * so item 12 asserts by NAME that the record and a transcript survived this
 * filter before it believes the absence.
 */
export function isInsideWorkerClone(relativePath: string, runDir = productRunDir()): boolean {
  const parts = relativePath.split("/");
  return parts.length >= 4 && parts[0] === runDir && /^[0-9]+$/.test(parts[2] ?? "");
}

/**
 * What item 12 prints about its own boundary, in the same breath as its result.
 *
 * The owner's ruling: BAR.md item 12's first sentence is unbounded, its
 * enumerated list is brigadier's OWN outputs, and the item is scoped to the
 * second. Ruling 65's single sink covers what brigadier persists; brigadier does
 * not rewrite a worker's commit, and doing so would put brigadier inside a clone
 * an agent touched, against ruling 56. `src/secrets/audit.ts` records the same
 * boundary at the product's end, in the same words.
 *
 * It is a constant rather than a sentence composed at the call site because it
 * must be printed on a PASS. The same honesty the item already applies to
 * paraphrase and to encodings we do not enumerate applies here, and an
 * exemption a reader only sees on a failure is an exemption nobody reads.
 */
export const SCOPE_NOTE =
  "PASS here is bounded, and the bound is printed with it rather than beneath it. This item asserts over " +
  "BRIGADIER'S OWN persisted artifacts — the run record, the transcripts on disk, the commit messages, the " +
  "diff and the host-session report — which is the list BAR.md enumerates and exactly what ruling 65's single " +
  "sink covers. In this fixture the worker was ASKED to commit the granted secret into a file in its own clone " +
  "AND IT DID. That file is the worker's artifact: brigadier does not rewrite a worker's commit, and rewriting " +
  "one would put brigadier inside a clone an agent touched, against ruling 56. So: A WORKER THAT COMMITS A " +
  "GRANTED SECRET INTO ITS OWN CLONE IS DEFEATED BY NEITHER THIS ITEM NOR THE PRODUCT. Neither is a worker " +
  "that paraphrases the key, re-encodes it in a scheme not enumerated here, or describes it in prose. Ruling " +
  "65 defeats VERBATIM leaks out of brigadier's own sink, and nothing wider.";
