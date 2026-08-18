// SPDX-License-Identifier: Apache-2.0
/**
 * A ledger the fixtures write and the product cannot.
 *
 * Item 5 used to pass on two different vendor strings in a record the forger
 * wrote, without running either vendor. A record is the product's account of
 * itself; a ledger is a file written by a process that had to exist.
 *
 * Every planted vendor appends one line per invocation: which vendor, which
 * role, which item, which pid. So "the reviewer's vendor differed from the
 * builder's" becomes a claim about two processes rather than about two strings,
 * and "the worker did the work" becomes a claim about a process that ran rather
 * than about a commit that exists.
 *
 * This is the harness's own channel and no product implements it. That is the
 * point and also its limit: it proves a FIXTURE vendor ran, which is what the
 * positive control needs. Against a real vendor there is no ledger, and item 5's
 * cross-vendor half falls back to the run record plus the independent verifier —
 * said out loud in the item rather than implied.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface LedgerLine {
  vendor: string;
  role: string;
  item: string;
  pid: number;
}

export function appendLedger(path: string, line: LedgerLine): void {
  try {
    appendFileSync(path, `${line.vendor}\t${line.role}\t${line.item}\t${line.pid}\n`);
  } catch {
    // A fixture that cannot record its own invocation must not take the run
    // down with it; the absence will show up as a failed check, which is the
    // honest outcome.
  }
}

export function readLedger(path: string): LedgerLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [vendor = "", role = "", item = "", pid = "0"] = l.split("\t");
      return { vendor, role, item, pid: Number(pid) };
    });
}

/** Distinct vendors that actually ran, in a given role. */
export function vendorsIn(lines: readonly LedgerLine[], role: string): string[] {
  return [...new Set(lines.filter((l) => l.role === role).map((l) => l.vendor))];
}
