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
import {
  DEFAULT_DESIRABILITY_CAP,
  OS_RESERVE_BYTES,
  WORKER_MEMORY_BYTES,
  feasibilityCap,
  planFanOut,
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
            expect(out.workers).toBe(ram);
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
    expect(bound.workers).toBe(real);
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
