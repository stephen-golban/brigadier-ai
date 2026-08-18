// SPDX-License-Identifier: Apache-2.0
/**
 * The full record, written to disk BEFORE anything is summarised.
 *
 * Ruling 58's order is the whole design: **the full record lands on disk first,
 * and only a POINTER travels.** A report that summarised from memory and then
 * wrote the record would have a window in which the summary exists and the
 * thing it points at does not — and the summary is the half that reaches a
 * model's context, permanently, whether or not the file was ever written.
 *
 * This is a different artifact from `src/run/record.ts`, and both are needed.
 * That one is NDJSON, appended as the run happens, never rewritten, so a
 * process killed without warning still leaves evidence of everything before the
 * last line. This one is a single JSON document written once at the end, and it
 * is the thing a reader — a person, a host model following the pointer, a CI
 * job — actually opens. The NDJSON is the flight recorder; this is the report
 * filed afterwards. Where they disagree the NDJSON wins, because it was written
 * while the facts were happening.
 *
 * Every field here exists because a ruling requires it to be checkable rather
 * than printable, and the ones that are easiest to fake are the ones a reader
 * can re-derive from the repository: `commit` is a real object id, `itemRef`
 * resolves, `integrationRef` is a branch `git switch` can reach.
 */

import type { CheckOutcome } from "../work/check.ts";
import type { WorkKind } from "../work/kind.ts";

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

export interface RecordCheck {
  name: string;
  outcome: CheckOutcome;
  /** Ruling 52: three of the four outcomes block. A blocking check never collapses. */
  blocking: boolean;
  /** Ruling 52: the qualifier lives INSIDE the result, never in a footnote. */
  qualifier?: string;
  detail?: string;
}

export interface RecordItem {
  id: string;
  /** 1-based. The clone's directory name and the run marker's item. */
  number: number;
  status: ItemStatus;
  kind: WorkKind;
  /** Ruling 29: the routing unit is a triple, recorded per item. */
  agent?: string;
  model?: string;
  effort?: string;
  /** Ruling 67: recorded per item, and only ever downward. */
  difficulty?: string;
  clampedTo?: string;
  /** Ruling 55: the rung it got, and whether a second rung existed at all. */
  attempts?: number;
  attemptsAvailable?: number;
  builderAgent?: string;
  reviewerAgent?: string;
  reviewVerdict?: CheckOutcome;
  /** Identities, not a count: a count can be printed by anything. */
  caughtDefects?: string[];
  checks: RecordCheck[];
  /** The item's own commit, verifiable with `git cat-file`. */
  commit?: string;
  /** `refs/brigadier/<run-id>/item/<n>`, whether or not it integrated. */
  itemRef?: string;
  /** Ruling 63: a retained clone is reported with its path and its bytes. */
  clonePath?: string;
  bytes?: number;
}

export interface RunRecord {
  runId: string;
  /** Ruling 51: `refs/heads/brigadier/<run-id>`, visible to `git branch`. */
  integrationRef: string;
  /** Ruling 61: outside every temp root, by `realpath`. */
  runRoot: string;
  /** Ruling 54: WHICH of the filters bound the worker count, not just the number. */
  bindingFilter: string;
  workers: number;
  /** Ruling 59: how many workers tried to delegate back to brigadier and were refused. */
  refusedDelegations: number;
  /** Ruling 17: stated out loud rather than assumed. */
  ambientSuppressed?: string[];
  review?: {
    crossVendor: boolean;
    /** Ruling 32: a weakened check is stated, never rendered as a pass. */
    sameVendorReason?: string;
    caught?: number;
    planted?: number;
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
    /** Ruling 13, per vendor: never absent and never optimistic. */
    quota: Record<string, "read" | "unreadable" | "unpriceable">;
    /** Ruling 70: levers that were active, phrased so they cannot be read as savings. */
    levers: string[];
    lowerBound: boolean;
  };
  /** On disk in full. The host report carries the path, never the transcript. */
  transcriptsPath?: string;
  items: RecordItem[];
}

/** The line the host report prints so the record can be found. Nothing else carries a path. */
export const RECORD_POINTER = "run-record:";

export function recordPointer(path: string): string {
  return `${RECORD_POINTER} ${path}`;
}
