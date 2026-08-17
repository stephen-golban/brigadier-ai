// SPDX-License-Identifier: Apache-2.0
/**
 * What a run must leave behind, so that "it ran" is checkable rather than
 * printable.
 *
 * A blind critic wrote a fake brigadier whose entire behaviour was `console.log`
 * plus one hand-written 41-byte ref file, and the first draft of this harness
 * scored it 10 of 13. Every one of those ten checks was a substring of stdout —
 * and stdout is the one thing a liar controls completely. Ruling 62(a) and v1's
 * finding 41 say it in one line: **assert on the escaped bytes, never on a
 * flag.** A printed word is a flag with more characters.
 *
 * The repair is that every item now needs two things at once: an artefact only
 * a working brigadier could have produced, and the absence of the artefact a
 * broken one would leave. A ref that `git fsck` can walk. A blob whose contents
 * are a token this harness generated after the binary was built. A record on
 * disk whose item ids match the commit subjects in that ref. A canary that must
 * exist because work happened, beside one that must not exist because
 * containment held.
 *
 * The SHAPE below is the harness's proposal, not the product's — no run record
 * has shipped. Stated here rather than buried, because an item that quietly
 * invented a format and then reported "refused" would be measuring its own
 * guess. When the real one lands this file changes and thirteen items keep
 * working, which is why it is one file rather than thirteen literals.
 */

/** The line a run must print so its record can be found. Nothing else is parsed for paths. */
export const RECORD_LINE = /^\s*run-record:\s*(\S.*?)\s*$/m;

export type ItemStatus =
  /** Merged into the integration branch. */
  | "integrated"
  /** Ran, did not pass its checks, not merged. */
  | "failed"
  /** Never dispatched — a prerequisite did not integrate, or a ceiling stopped it. */
  | "unrun"
  /** Cancelled in flight by a hard ceiling or an interrupt. */
  | "cancelled"
  /** Ruling 63: interrupted with committed work in its clone, kept rather than swept. */
  | "retained";

export type CheckOutcome = "pass" | "fail" | "error" | "skipped";

export interface RecordCheck {
  name: string;
  outcome: CheckOutcome;
  /** Ruling 52: three of the four outcomes block. A blocking check never collapses. */
  blocking: boolean;
}

export interface RecordItem {
  id: string;
  status: ItemStatus;
  kind?: "write" | "read-only";
  /** Ruling 29: the routing unit is a triple, recorded per item. */
  agent?: string;
  model?: string;
  effort?: string;
  /** Ruling 67: printed per item, and only ever downward. */
  difficulty?: string;
  clampedTo?: string;
  /** Ruling 55: the rung it actually got, and whether a second rung existed at all. */
  attempts?: number;
  attemptsAvailable?: number;
  /** Ruling 32: the reviewer's vendor, which must differ from the builder's where it can. */
  builderAgent?: string;
  reviewerAgent?: string;
  reviewVerdict?: CheckOutcome;
  /**
   * Which planted defect markers this reviewer actually found.
   *
   * Identities, not a count. Ruling 52's named assumption is what item 5
   * converts into a public measurement, and a count can be printed by anything;
   * a list of markers generated after the binary was built cannot.
   */
  caughtDefects?: string[];
  checks?: RecordCheck[];
  /** The commit this item contributed, verifiable with `git cat-file`. */
  commit?: string;
  /** Ruling 63: a retained clone is reported with its path and its bytes. */
  clonePath?: string;
  bytes?: number;
}

export interface RunRecord {
  runId: string;
  /** `refs/heads/brigadier/<runId>` — ruling 51, visible to `git branch`, survives cleanup. */
  integrationRef: string;
  /** Ruling 61: asserted outside every temp root by `realpath`, never lexically. */
  runRoot: string;
  /** Ruling 54: WHICH of the three filters bound the worker count, not just the number. */
  bindingFilter: string;
  workers: number;
  /** Ruling 59: how many workers tried to delegate to brigadier and were refused. */
  refusedDelegations: number;
  /** Ruling 17: stated out loud on a first run rather than assumed. */
  ambientSuppressed?: string[];
  review?: {
    crossVendor: boolean;
    /** Ruling 32: a weakened check is stated, never rendered as a pass. */
    sameVendorReason?: string;
    caught?: number;
    planted?: number;
    /** The markers actually found, so the rate can be re-derived rather than believed. */
    caughtDefects?: string[];
  };
  cost?: {
    currency: string;
    /** Ruling 66: a RANGE, because #44 measured 15× between two identical runs. */
    estimateLow: number;
    estimateHigh: number;
    provenance: string;
    actual?: number;
    softCeiling?: number;
    hardCeiling?: number;
    softCeilingHit?: boolean;
    hardCeilingHit?: boolean;
    /** Ruling 13: per vendor, never absent and never optimistic. */
    quota: Record<string, "read" | "unreadable" | "unpriceable">;
    /** Ruling 70: levers that were active, phrased so they cannot be read as savings. */
    levers: string[];
    lowerBound: boolean;
  };
  /** On disk in full — the host report carries the path, never the transcript. */
  transcriptsPath?: string;
  items: RecordItem[];
}

export function recordPathFrom(report: string): string | undefined {
  return RECORD_LINE.exec(report)?.[1];
}

/**
 * Parse without trusting. A record that is not an object with an `items` array
 * is not a record, and returning `undefined` here is what makes the item say so
 * rather than crash.
 */
export function parseRecord(text: string): RunRecord | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as RunRecord;
    if (!Array.isArray(record.items)) return undefined;
    if (typeof record.runId !== "string" || typeof record.integrationRef !== "string") return undefined;
    return record;
  } catch {
    return undefined;
  }
}
