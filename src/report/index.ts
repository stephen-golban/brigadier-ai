// SPDX-License-Identifier: Apache-2.0
/**
 * What brigadier is allowed to say, what it writes down, and how the two
 * relate.
 *
 * Ruling 58 in one sentence: the full record goes to disk first and only a
 * pointer travels. `record.ts` is the thing on disk, `budget.ts` is the
 * arithmetic that decides how much of it may be spoken aloud, and
 * `run-report.ts` is the speaking.
 */

export {
  HOST_REPORT_TOKEN_CEILING,
  capItems,
  estimateTokens,
  hasInFlightDisplay,
  isCapped,
  type Audience,
  type CappedReport,
  type ItemLine,
} from "./budget.ts";

export {
  RECORD_POINTER,
  recordPointer,
  type ItemStatus,
  type RecordCheck,
  type RecordItem,
  type RunRecord,
} from "./record.ts";

export {
  itemBlocks,
  refusedDelegationLine,
  renderItem,
  renderRecordCheck,
  renderRunReport,
  runHeadline,
  type HeadlineInput,
  type RunReportInput,
} from "./run-report.ts";
