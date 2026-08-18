// SPDX-License-Identifier: Apache-2.0
/**
 * The one relationship between the harness's deadline and the subject's.
 *
 * MEASURED on this host on 2026-08-18: the harness gave a full `brigadier run`
 * 300 s while the product gives each worker 600 s. Every wedged worker was
 * therefore SIGKILLed by the harness strictly before the product's own deadline
 * could fire, so the run produced no record at all and the bar reported "no
 * `run-record:` path" — a signal that a deadlocked fixture, a hung product and
 * a product three seconds from finishing all produce identically. It was the
 * first of those, and six items were charged to the product for it.
 *
 * A harness that kills its subject before the subject can explain itself cannot
 * distinguish a hang from a slow success. So: **the harness deadline must
 * exceed the subject's own, with room for the subject to report after its
 * deadline fires.**
 *
 * `bar/` imports nothing from `src/`, so `SUBJECT_WORKER_TIMEOUT_MS` is a
 * second copy of a product constant and copies go stale in silence. This reads
 * the product's own source as TEXT — a copy checked against its original is not
 * the same thing as a harness assembled from the code under test — and fails if
 * the two ever cross. Both directions are asserted, per `AGENTS.md`: the rule
 * holds over the real numbers, AND the predicate that enforces it fires when it
 * is handed an inverted pair.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HARNESS_RUN_TIMEOUT_MS, REPORTING_MARGIN_MS, SUBJECT_WORKER_TIMEOUT_MS } from "./proc.ts";

// Assembled from parts rather than written as one literal, for the reason
// `bar/self-check.test.ts` records: a literal specifier here would itself be a
// reach into `src/`, and the scanner would — correctly — flag this file.
const EXECUTE = fileURLToPath(new URL(["..", "..", "src", "queue", "execute.ts"].join("/"), import.meta.url));

/** The subject's declared worker deadline, read out of the subject. */
function subjectWorkerTimeoutMs(): number {
  const source = readFileSync(EXECUTE, "utf8");
  const match = /DEFAULT_WORKER_TIMEOUT_MS\s*=\s*([0-9_]+)/.exec(source);
  // A missing constant is a finding, not a pass. If the product renames it,
  // this fails loudly rather than quietly checking nothing.
  expect(match).not.toBeNull();
  return Number((match?.[1] ?? "").split("_").join(""));
}

/** The rule, as a predicate, so it can be shown to fail. */
export function ordersCorrectly(harnessMs: number, subjectMs: number, marginMs: number): boolean {
  return harnessMs >= subjectMs + marginMs;
}

describe("the harness outlives its subject's own deadline", () => {
  test("the harness deadline exceeds the product's worker deadline by the reporting margin", () => {
    const subject = subjectWorkerTimeoutMs();
    // The copy is checked against the original, which is the whole reason this
    // file exists.
    expect(SUBJECT_WORKER_TIMEOUT_MS).toBe(subject);
    expect(REPORTING_MARGIN_MS).toBeGreaterThan(0);
    expect(ordersCorrectly(HARNESS_RUN_TIMEOUT_MS, subject, REPORTING_MARGIN_MS)).toBe(true);
    // Named as bytes rather than as a boolean, so a failure says which numbers.
    expect(`${HARNESS_RUN_TIMEOUT_MS} > ${subject}`).toBe(`${subject + REPORTING_MARGIN_MS} > ${subject}`);
  });

  test("NEGATIVE CONTROL: the rule fires on the ordering that produced the defect", () => {
    // The pair as it actually was on 2026-08-18.
    expect(ordersCorrectly(300_000, 600_000, 120_000)).toBe(false);
    // And on the subtler version: longer than the subject, but with no room to
    // report — which loses the record just as completely.
    expect(ordersCorrectly(600_001, 600_000, 120_000)).toBe(false);
  });

  test("every full run the bar drives uses the constant, not a literal", () => {
    // The rule is worth nothing if a call site keeps its own number. This scans
    // the items for the shape that was there before.
    const items = fileURLToPath(new URL("../items/", import.meta.url));
    const offenders: string[] = [];
    for (const file of new Bun.Glob("*.ts").scanSync({ cwd: items, absolute: true })) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/timeoutMs:\s*([0-9_]+)/g)) {
        const ms = Number((match[1] ?? "").split("_").join(""));
        // A deadline at or above the subject's worker deadline must come from
        // the constant; anything long enough to collide with it and not derived
        // from it is the bug returning under a different literal.
        if (ms >= SUBJECT_WORKER_TIMEOUT_MS / 2) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
