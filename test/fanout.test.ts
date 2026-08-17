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

  test("a tie prefers the more specific explanation over `item-count`", () => {
    const out = planFanOut({ ...base, itemCount: 3, desirabilityCap: 3 });
    expect(out.workers).toBe(3);
    expect(out.boundBy).toBe("desirability");
  });
});
