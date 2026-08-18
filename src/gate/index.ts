// SPDX-License-Identifier: Apache-2.0
/**
 * The pre-flight half of ruling 52.
 *
 * `src/integrate/gate.ts` runs the verify command on the MERGED result; this
 * directory answers the question that has to be settled before anything is
 * spent — whether the command's executable exists at all. They are separate
 * because the two answers have separate lifetimes: the lookup happens once, at
 * plan validation, and the merged-result gate happens once per wave, at the
 * end.
 *
 * `run.ts` is the middle one, and its absence was a defect: ruling 52 asks for
 * the operator's verify command as a BLOCKING CHECK PER ITEM, and `verify.ts`
 * only ever resolved it. A resolution that is never executed is a checker that
 * was validated and never consulted, which is the same class of failure as a
 * result that was never produced — so the lookup and the execution ship
 * together, and `src/queue/execute.ts` runs one per item in that item's clone.
 */

export {
  resolveVerify,
  splitCommand,
  type VerifyResolution,
  type VerifyStatus,
} from "./verify.ts";

export {
  VERIFY_TAIL_LINES,
  initialVerifyCheck,
  runVerify,
  unconfiguredVerify,
  type VerifyRunSpec,
} from "./run.ts";
