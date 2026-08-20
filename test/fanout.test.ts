// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 54, with the measurement that decided it written down as a test.
 *
 * The assertion that matters most is the negative one: the obvious
 * implementation of this filter returns zero on a healthy machine, and the
 * whole reason this module reads `totalmem()` is that `freemem()` was measured
 * doing exactly that.
 */

import { describe, expect, test } from "bun:test";
import { LEGALITY_UNBOUNDED, bindingSentence } from "../src/queue/admit.ts";
import {
  DEFAULT_DESIRABILITY_CAP,
  OS_RESERVE_BYTES,
  WORKER_MEMORY_BYTES,
  dispatchWidth,
  feasibilityCap,
  planFanOut,
  type BindingFilter,
  type FanOut,
} from "../src/work/fanout.ts";

const GB = 1024 ** 3;

describe("the feasibility filter, on the machine it was measured on", () => {
  test("24 GB host-first gives 5, and terminal-only gives 6", () => {
    expect(feasibilityCap(true, 24 * GB)).toBe(5); // (24 - 4 - 3) / 3
    expect(feasibilityCap(false, 24 * GB)).toBe(6); // (24 - 4) / 3
  });

  test("the host agent's own budget is reserved — the map's fog item", () => {
    // Under decision 25 the host agent IS an agent, so it gets an agent's
    // budget. Without this the filter measures the machine and ignores the
    // largest single consumer on it.
    expect(feasibilityCap(false, 24 * GB) - feasibilityCap(true, 24 * GB)).toBe(1);
  });

  test("MEASURED NEGATIVE: the obvious implementation returns zero on a healthy machine", () => {
    // os.freemem() on this 24 GB machine read 1.75 GB, then 0.06 GB seconds
    // later, while macOS `memory_pressure` reported it 41% free. Feeding either
    // reading to the same arithmetic yields no workers at all.
    for (const freememReading of [1.75 * GB, 0.06 * GB]) {
      expect(feasibilityCap(true, freememReading)).toBe(0);
      expect(feasibilityCap(false, freememReading)).toBe(0);
    }
    // Even the generous vm_stat free+reclaimable figure is not enough.
    expect(feasibilityCap(true, 4.37 * GB)).toBe(0);
  });

  test("a tiny machine is capped rather than going negative", () => {
    expect(feasibilityCap(true, 2 * GB)).toBe(0);
  });

  test("the constants are the ones ruling 54 measured", () => {
    expect(WORKER_MEMORY_BYTES).toBe(3 * GB); // v1's measured UPPER bound
    expect(OS_RESERVE_BYTES).toBe(4 * GB); // against 3.99 GB wired, measured
    expect(DEFAULT_DESIRABILITY_CAP).toBe(3); // was 5 in v1, before ruling 21
  });
});

describe("ruling 14: the lowest wins and the report names which", () => {
  const base = { itemCount: 10, legalityCap: 10, hostFirst: true, totalMemoryBytes: 24 * GB };

  test("desirability binds on the owner's machine by default", () => {
    const out = planFanOut(base);
    expect(out.workers).toBe(3);
    expect(out.boundBy).toBe("desirability");
    // The losing filters are still reported — a filter that did not constrain
    // must not be rendered as one that did.
    expect(out.candidates.feasibility).toBe(5);
    expect(out.candidates.legality).toBe(10);
  });

  test("RAM can bind when the operator raises the budget", () => {
    const out = planFanOut({ ...base, desirabilityCap: 20 });
    expect(out.workers).toBe(5);
    expect(out.boundBy).toBe("feasibility");
  });

  test("legality can bind", () => {
    const out = planFanOut({ ...base, legalityCap: 2 });
    expect(out.boundBy).toBe("legality");
    expect(out.workers).toBe(2);
  });

  test("three different reasons to run ONE worker are three different answers", () => {
    // This is the whole point of ruling 14's reporting requirement.
    expect(planFanOut({ ...base, itemCount: 1 }).boundBy).toBe("item-count");
    expect(planFanOut({ ...base, legalityCap: 1 }).boundBy).toBe("legality");
    expect(planFanOut({ ...base, desirabilityCap: 1 }).boundBy).toBe("desirability");
    expect(planFanOut({ ...base, totalMemoryBytes: 10 * GB }).boundBy).toBe("feasibility");
    // ...and all four produce the same worker count, which is why collapsing
    // them would be invisible.
    for (const o of [
      planFanOut({ ...base, itemCount: 1 }),
      planFanOut({ ...base, legalityCap: 1 }),
      planFanOut({ ...base, desirabilityCap: 1 }),
      planFanOut({ ...base, totalMemoryBytes: 10 * GB }),
    ]) {
      expect(o.workers).toBe(1);
    }
  });

  test("MEASURED NEGATIVE: `feasibility` is the answer exactly when RAM is the least", () => {
    // The property `bar/items/04-fanout-isolates.ts` drives through the
    // compiled binary, asserted here as arithmetic and in BOTH directions.
    // Ruling 54's sentence is worth printing only because it is true, so the
    // filter must never be named when something else was lower, and must always
    // be named when nothing else was.
    const legalityCap = Number.MAX_SAFE_INTEGER; // `LEGALITY_UNBOUNDED` at admission
    for (const totalMemoryBytes of [8, 10, 16, 24, 64, 512].map((g) => g * GB)) {
      const ram = feasibilityCap(true, totalMemoryBytes);
      for (const itemCount of [1, 3, 6, 8, 64, 512]) {
        for (const desirabilityCap of [1, 2, 3, 65_536]) {
          const out = planFanOut({ itemCount, legalityCap, hostFirst: true, desirabilityCap, totalMemoryBytes });
          if (out.boundBy === "feasibility") {
            // Never claimed without cause.
            expect(ram).toBeLessThanOrEqual(Math.min(itemCount, desirabilityCap));
            // `Math.max(1, …)` because a cap of zero is admitted as ONE — see
            // the last describe in this file. The FILTER is still feasibility,
            // which is the half ruling 54 cares about; the count is the floor.
            expect(out.workers).toBe(Math.max(1, ram));
          }
          // Never withheld when it is the only cause.
          if (ram < itemCount && ram < desirabilityCap) expect(out.boundBy).toBe("feasibility");
        }
      }
    }
  });

  test("the bands: which hosts can tell ruling 54's three causes apart, and which cannot", () => {
    // The sizing rule `bar/items/04-fanout-isolates.ts` drives the bar with,
    // verified here against the real filter: ONE item for `item-count`, and a
    // `cap + 2`-item plan with a budget of `cap - 1` for `desirability`. `bar/`
    // imports nothing from `src/`, so the rule is pinned on both sides of that
    // wall — `planTheOtherTwoDrives` holds the same three numbers and
    // `bar/lib/item4-fanout.test.ts` pins them there.
    //
    // MEASURED with `feasibilityCap` on 2026-08-20. The bands matter because
    // GitHub's own runner table, read the same day, gives `macos-latest` 7 GB
    // and a private repository's `ubuntu-latest` 8 GB — a cap of ZERO — while a
    // public one gets 16 GB. An item that assumed a one-item plan was under the
    // cap would go red on ordinary hardware.
    const legalityCap = Number.MAX_SAFE_INTEGER; // `LEGALITY_UNBOUNDED` at admission
    const bands: Array<[number, number]> = [];
    for (const gib of [7, 8, 10, 12, 13, 14, 16, 24, 64]) {
      const totalMemoryBytes = gib * GB;
      const cap = feasibilityCap(true, totalMemoryBytes);
      bands.push([gib, cap]);
      const base = { legalityCap, hostFirst: true, totalMemoryBytes };
      if (cap < 2) {
        // The band the bar refuses to grade in, asserted rather than skipped:
        // one item is not below a cap of one or zero, so RAM binds here too and
        // the three causes are genuinely indistinguishable on such a host.
        expect(planFanOut({ ...base, itemCount: 1 }).boundBy).toBe("feasibility");
        continue;
      }
      expect(planFanOut({ ...base, itemCount: 1 }).boundBy).toBe("item-count");
      expect(planFanOut({ ...base, itemCount: cap + 2, desirabilityCap: cap - 1 }).boundBy).toBe("desirability");
      expect(planFanOut({ ...base, itemCount: cap + 2, desirabilityCap: 65_536 }).boundBy).toBe("feasibility");
    }
    // The bands themselves, so a change to ruling 54's arithmetic shows up as a
    // number rather than as a distant item going red.
    expect(bands).toEqual([
      [7, 0],
      [8, 0],
      [10, 1],
      [12, 1],
      [13, 2],
      [14, 2],
      [16, 3],
      [24, 5],
      [64, 19],
    ]);
  });

  test("the RAM bound is reachable from the operator's own inputs on THIS machine", () => {
    // This is why the bar never has to tell the product something false about
    // the machine to drive ruling 54's third sentence: no `totalMemoryBytes` is
    // passed here, so the number is this host's own `totalmem()`.
    //
    // Every assertion below is written to hold on ANY host, because this file
    // runs in `gates.yml` on three runners whose memory differs by a factor of
    // two. A test that only holds above 13 GiB is a test that fails a green
    // build on `macos-latest`.
    const real = feasibilityCap(true);
    const legalityCap = Number.MAX_SAFE_INTEGER;
    const base = { legalityCap, hostFirst: true };
    const bound = planFanOut({ ...base, itemCount: real + 1, desirabilityCap: 65_536 });
    expect(bound.boundBy).toBe("feasibility");
    // On a runner whose cap is zero this is ONE, not zero: the filter is still
    // RAM and the count is floored where it is reported. Written this way
    // because this file runs on hosts that differ by a factor of three.
    expect(bound.workers).toBe(Math.max(1, real));
    // And the same two operator inputs, moved the other way. BOTH branches
    // assert: on a host with room for two workers the answer leaves RAM, and on
    // one without it the answer correctly stays — a branch that merely skipped
    // is a branch nobody notices going wrong.
    if (real >= 2) {
      expect(planFanOut({ ...base, itemCount: 1, desirabilityCap: 65_536 }).boundBy).toBe("item-count");
      expect(planFanOut({ ...base, itemCount: real + 1, desirabilityCap: real - 1 }).boundBy).toBe("desirability");
    } else {
      expect(planFanOut({ ...base, itemCount: 1, desirabilityCap: 65_536 }).boundBy).toBe("feasibility");
    }
  });

  test("a tie prefers the more specific explanation over `item-count`", () => {
    const out = planFanOut({ ...base, itemCount: 3, desirabilityCap: 3 });
    expect(out.workers).toBe(3);
    expect(out.boundBy).toBe("desirability");
  });
});

describe("zero workers is a real answer, and it is never the count that is printed", () => {
  /**
   * THE DEFECT THIS BLOCK CLOSES, and it was on stdout rather than on CI.
   *
   * `feasibilityCap` returns 0 on any host-first machine below about 9 GiB.
   * `planFanOut` used to return that zero as `workers`, `bindingSentence`
   * renders `workers` verbatim, and `execute.ts` dispatched
   * `Math.max(1, workers)` — so brigadier printed *0 worker(s) in wave 1 — RAM
   * capped it* and then ran one. `src/cli.ts` defaults the audience to
   * `host-session`, so every run on an ordinary 8 GiB laptop said it. Nothing
   * caught it because nothing compared the printed number to the dispatched
   * one: `expectedWorkers` in `bar/lib/evidence.ts` is supplied by the harness,
   * never read out of the report.
   *
   * The floor now lives in `planFanOut`, so `workers` is the same number in all
   * three places, and `dispatchWidth` is the one function both the report and
   * the dispatch loop go through. `boundBy` is deliberately NOT floored: on a
   * small host RAM really is the filter that bound the count, and ruling 54
   * wants that said — *RAM capped it* and *the plan only had one item* have
   * different remedies.
   */
  const base = { legalityCap: LEGALITY_UNBOUNDED, hostFirst: true, desirabilityCap: 65_536, itemCount: 8 };
  /** Only `workers` is under test in the `dispatchWidth` arm; these are filler. */
  const EMPTY_CANDIDATES: Record<BindingFilter, number> = { legality: 0, feasibility: 0, desirability: 0, "item-count": 0 };

  test("the cap is still zero on both runner sizes this repository builds on", () => {
    // The arithmetic is untouched. What changed is what is done with it.
    expect(feasibilityCap(true, 7 * GB)).toBe(0); // macos-latest
    expect(feasibilityCap(true, 8 * GB)).toBe(0); // a private repo's ubuntu/windows
  });

  test("a machine with room for none admits ONE, and still says RAM bound it", () => {
    const out = planFanOut({ ...base, totalMemoryBytes: 7 * GB });
    expect(out.workers).toBe(1);
    // The filter is read off the raw candidates, so the reason survives the
    // floor. A run that printed `item-count` here would be telling the operator
    // to lengthen the plan when the answer is a bigger machine.
    expect(out.boundBy).toBe("feasibility");
    // And the losing filter still reports what it actually answered, so the
    // sentence can explain why one worker runs where there is room for none.
    expect(out.candidates.feasibility).toBe(0);
  });

  test("THE CONTROL: the printed worker count IS the dispatched worker count", () => {
    // Behavioural, not a grep over `execute.ts`: `bindingSentence` is the
    // function that writes the number a reader sees and `dispatchWidth` is the
    // function `execute.ts` steps its batch cursor by. This is the comparison
    // that did not exist, across the whole range of hosts brigadier ships to.
    for (const gib of [2, 4, 7, 8, 10, 12, 13, 16, 24, 64, 512]) {
      for (const itemCount of [1, 3, 8, 64]) {
        for (const desirabilityCap of [1, 3, 65_536]) {
          const fanOut = planFanOut({ ...base, itemCount, desirabilityCap, totalMemoryBytes: gib * GB });
          const printed = /^(\d+) worker\(s\) in wave/.exec(bindingSentence(fanOut, 1))?.[1];
          expect([gib, itemCount, desirabilityCap, printed]).toEqual([
            gib,
            itemCount,
            desirabilityCap,
            String(dispatchWidth(fanOut)),
          ]);
          // Never zero either, on any host: a run that dispatches nothing and
          // reports success for it is the failure this whole file is about.
          expect(dispatchWidth(fanOut)).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  test("NEGATIVE: the control can fail — an unfloored count is caught by it", () => {
    // The mutation, applied to a value rather than to the source: this is what
    // `planFanOut` returned before, and the comparison above is what would have
    // rejected it. Without this arm the control could be satisfied by a
    // `dispatchWidth` that simply echoed whatever it was handed.
    const unfloored = { workers: 0, boundBy: "feasibility" as const, candidates: { legality: LEGALITY_UNBOUNDED, feasibility: 0, desirability: 3, "item-count": 8 } };
    const printed = /^(\d+) worker\(s\) in wave/.exec(bindingSentence(unfloored, 1))?.[1];
    expect(printed).toBe("0");
    expect(dispatchWidth(unfloored)).toBe(1);
    expect(printed).not.toBe(String(dispatchWidth(unfloored)));
  });

  test("THE CONTROL: an operator's `--workers` typo can never produce a silent zero-item run", () => {
    // `src/cli.ts` does `Number(value("workers"))` with no validation, so this
    // is exactly what reaches `planFanOut` from the command line. Before the
    // floor, `NaN` was discarded by accident — it never won a `<` comparison.
    // The floor is a `Math.min`/`Math.max` chain and those PROPAGATE it.
    // MEASURED against `bun 1.3.14` on 2026-08-20 before the guard: `--workers
    // abc` printed `NaN worker(s) in wave 1 — RAM capped it…` and handed `NaN`
    // to the batch cursor, which dispatches nothing and exits reporting
    // success — the failure `BAR.md` opens on, from a typo.
    for (const typed of ["abc", "", " ", "1e", "Infinity", "-1", "0", "2.5"]) {
      const desirabilityCap = Number(typed);
      // Loud, and it names the field and the value it was given. The input is
      // carried into every assertion so a failure says WHICH typo got through.
      let threw = false;
      let message = "";
      try {
        planFanOut({ ...base, desirabilityCap });
      } catch (error) {
        threw = true;
        message = (error as Error).message;
      }
      expect([typed, threw]).toEqual([typed, true]);
      expect([typed, message.includes("desirabilityCap")]).toEqual([typed, true]);
      expect([typed, message.includes(String(desirabilityCap))]).toEqual([typed, true]);
    }
    // And a value the operator plainly meant still works, so this is a guard
    // rather than a refusal to accept the flag at all.
    const good = planFanOut({ ...base, desirabilityCap: 2, totalMemoryBytes: 24 * GB });
    expect(good.workers).toBe(2);
    expect(good.boundBy).toBe("desirability");
    expect(dispatchWidth(good)).toBe(2);
  });

  test("the same guard covers the machine reading and the plan's own counts", () => {
    // `feasibilityCap` DIVIDES by the byte count, so a non-finite reading is a
    // non-finite worker count by arithmetic rather than by carelessness.
    expect(() => planFanOut({ ...base, totalMemoryBytes: Number.NaN })).toThrow(/totalMemoryBytes/);
    expect(() => planFanOut({ ...base, totalMemoryBytes: -1 })).toThrow(/totalMemoryBytes/);
    expect(() => planFanOut({ ...base, itemCount: Number.NaN })).toThrow(/itemCount/);
    expect(() => planFanOut({ ...base, itemCount: -1 })).toThrow(/itemCount/);
    expect(() => planFanOut({ ...base, legalityCap: Number.NaN })).toThrow(/legalityCap/);
    // A fractional byte reading is fine — `1.75 * GB` is a real `freemem()`
    // sample and the floor division handles it. Only the counts must be whole.
    expect(() => planFanOut({ ...base, totalMemoryBytes: 4.37 * GB })).not.toThrow();
  });

  test("`dispatchWidth` cannot return a number the batch loop could misuse", () => {
    // Structural, rather than every caller remembering to clamp: the dispatch
    // loop steps its cursor by this value, so a zero spins forever and a
    // fraction slices batches at fractional indices.
    const junk: Array<FanOut | undefined> = [
      undefined,
      { workers: Number.NaN, boundBy: "feasibility", candidates: EMPTY_CANDIDATES },
      { workers: 0, boundBy: "item-count", candidates: EMPTY_CANDIDATES },
      { workers: -3, boundBy: "desirability", candidates: EMPTY_CANDIDATES },
      { workers: 2.5, boundBy: "desirability", candidates: EMPTY_CANDIDATES },
      { workers: Number.POSITIVE_INFINITY, boundBy: "legality", candidates: EMPTY_CANDIDATES },
    ];
    for (const fanOut of junk) {
      const width = dispatchWidth(fanOut);
      expect([fanOut?.workers, Number.isInteger(width) && width >= 1]).toEqual([fanOut?.workers, true]);
    }
    // The one value it passes through unchanged is a real one.
    expect(dispatchWidth({ workers: 4, boundBy: "desirability", candidates: EMPTY_CANDIDATES })).toBe(4);
  });

  test("the two HARD filters are not floored — nothing is invented to run", () => {
    // Feasibility and desirability are planning numbers and get the floor. An
    // empty wave and an illegal one are facts about the plan: running an item
    // that may not run, or an item that does not exist, would be a correctness
    // failure rather than a tight fit.
    expect(planFanOut({ ...base, itemCount: 0, totalMemoryBytes: 24 * GB }).workers).toBe(0);
    expect(planFanOut({ ...base, legalityCap: 0, totalMemoryBytes: 24 * GB }).workers).toBe(0);
    // And `dispatchWidth` still refuses to hand the batch loop a zero to step
    // its cursor by, which would spin rather than run nothing.
    expect(dispatchWidth(planFanOut({ ...base, itemCount: 0, totalMemoryBytes: 24 * GB }))).toBe(1);
    expect(dispatchWidth(undefined)).toBe(1);
  });
});
