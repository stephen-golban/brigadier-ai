// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 71's unlearnable things, in ONE place because there are two printers.
 *
 * `brigadier detect`'s first run prints them and `brigadier setup` prints them,
 * and ruling 76 named the failure mode of that when it accepted the second
 * printer: *"one silently stops while the other keeps the tests green."* Two
 * copies of the same paragraph is how that happens — so there is one copy, and
 * `test/setup.test.ts` asserts both printers emit it.
 *
 * The suppression sentence changed with ruling 83 and the change is the reason
 * this module exists rather than a shared string being tidier: suppression is no
 * longer one mechanism applied to every vendor, so a sentence claiming a blanket
 * is a sentence that is wrong on at least one vendor of every fleet.
 */

export const UNLEARNABLE = [
  "",
  "Ambient instruction files (a user-global AGENTS.md and the like) are SUPPRESSED in workers by",
  "  default — decision 17. The lever is per vendor (ruling 83): on Claude the vendor's own argv",
  "  drops the user settings source, every other vendor gets a redirected config root, and a vendor",
  "  with neither is NAMED in the run report rather than counted as suppressed. A worker will not",
  "  obey them, so anything load-bearing belongs in the plan.",
  "Isolation covers the filesystem and the process tree. It does NOT cover external services: a",
  "  worker that reaches the network can still act on the world, and no clone contains that.",
] as const;
