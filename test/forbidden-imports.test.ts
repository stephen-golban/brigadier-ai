// SPDX-License-Identifier: Apache-2.0
/**
 * The seam gate, with its demonstrated negative.
 *
 * Decision 22 says the cost store and the competence ranking stay physically
 * separate "so a later refactor cannot merge them by accident". Neither module
 * exists yet, which is exactly when a gate like this is most likely to be a
 * guard that always passes — so it is exercised here against synthetic files
 * rather than trusted to fire when the day comes.
 */

import { describe, expect, test } from "bun:test";
import { crossings, importsIn } from "../scripts/forbidden-imports.ts";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("import extraction", () => {
  test("static and dynamic forms", () => {
    const found = importsIn(`
      import { a } from "./a.ts";
      import type { B } from "../b/b.ts";
      const c = await import("./c.ts");
    `);
    expect(found).toEqual(["./a.ts", "../b/b.ts", "./c.ts"]);
  });
});

describe("src/ may not reach into probes/", () => {
  test("a crossing is caught", () => {
    const found = crossings(files({ "src/agent/worker.ts": `import { x } from "../../probes/acp.ts";` }));
    expect(found).toHaveLength(1);
    expect(found[0]!.specifier).toContain("probes/");
  });

  test("NEGATIVE CONTROL: ordinary imports pass", () => {
    expect(crossings(files({ "src/agent/worker.ts": `import { x } from "../lane/lane.ts";` }))).toEqual([]);
  });

  test("a probe importing a probe is fine — the ban is directional", () => {
    expect(crossings(files({ "probes/x.ts": `import { y } from "./y.ts";` }))).toEqual([]);
  });
});

describe("decision 22: the router and the cost store, in BOTH directions", () => {
  test("the router importing the cost store is caught", () => {
    const found = crossings(
      files({ "src/router/competence.ts": `import { estimate } from "../cost/store.ts";` }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.seam.why).toContain("competence");
  });

  test("the cost store importing the router is caught too", () => {
    // The mistake that reads naturally is the first one. This is the other one,
    // and decision 22 forbids it just as hard — a learning loop that reaches
    // into competence rankings is the failure, whichever file the import is in.
    const found = crossings(
      files({ "src/cost/store.ts": `import { rank } from "../router/competence.ts";` }),
    );
    expect(found).toHaveLength(1);
  });

  test("NEGATIVE CONTROL: each may import elsewhere freely", () => {
    expect(
      crossings(
        files({
          "src/router/competence.ts": `import { PROFILES } from "../agent/profiles.ts";`,
          "src/cost/store.ts": `import { WorkKind } from "../work/kind.ts";`,
        }),
      ),
    ).toEqual([]);
  });

  test("a module outside both paths is unaffected", () => {
    expect(crossings(files({ "src/work/kind.ts": `import { x } from "../cost/store.ts";` }))).toEqual([]);
  });
});

describe("ruling 81's third path: the outcome store is barred from cost too", () => {
  test("the outcome store reaching cost is CAUGHT", () => {
    // The hop this entry exists for. Without it, `outcomes.ts` importing cost
    // and the router importing `outcomes.ts` satisfies the older seam
    // letter-perfect while cost reaches the ranking anyway.
    const found = crossings(files({ "src/router/outcomes.ts": `import { c } from "../cost/model.ts";` }));
    // TWO, and that is right rather than redundant: the outcome store lives
    // under `src/router/`, so the decision-22 seam catches it as well. The
    // ruling-81 entry is what would still catch it if the store ever moved out
    // from under that prefix — which is exactly the refactor it guards against.
    expect(found).toHaveLength(2);
    expect(found.map((c) => c.seam.why).join(" ")).toContain("ruling 81");
  });

  test("and it is caught even if the outcome store MOVES out from under src/router/", () => {
    // The decision-22 seam is keyed on the directory. This one is keyed on the
    // file, so the guard survives the move that would otherwise silently drop
    // half of it. Asserted by pointing the same import at the path it would
    // have then — a check that only fires at today's path is a check that
    // expires on a rename nobody connects to it.
    const moved = crossings(files({ "src/router/outcomes.ts": `import { c } from "../../elsewhere/cost/model.ts";` }));
    expect(moved.some((c) => c.seam.why.includes("ruling 81"))).toBe(true);
  });

  test("and cost reaching the outcome store is caught, because the ban is MUTUAL", () => {
    const found = crossings(files({ "src/cost/model.ts": `import { t } from "../router/outcomes.ts";` }));
    expect(found.length).toBeGreaterThan(0);
  });

  test("NEGATIVE CONTROL: the outcome store's real imports pass", () => {
    // What it actually imports today. A guard that also refused this would be a
    // guard nobody could satisfy.
    expect(
      crossings(files({ "src/router/outcomes.ts": `import type { WorkKind } from "../work/kind.ts";` })),
    ).toEqual([]);
  });

  test("the router may import the outcome store — that is what ruling 81 ALLOWS", () => {
    expect(
      crossings(files({ "src/router/assign.ts": `import { adjustment } from "./outcomes.ts";` })),
    ).toEqual([]);
  });

  test("the router reaching cost DIRECTLY is still caught — ruling 81 relaxed nothing", () => {
    const found = crossings(files({ "src/router/assign.ts": `import { c } from "../cost/model.ts";` }));
    expect(found).toHaveLength(1);
    expect(found[0]!.seam.why).toContain("decision 22");
  });
});
