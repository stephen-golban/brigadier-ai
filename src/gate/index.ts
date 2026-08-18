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
 */

export {
  resolveVerify,
  splitCommand,
  type VerifyResolution,
  type VerifyStatus,
} from "./verify.ts";
