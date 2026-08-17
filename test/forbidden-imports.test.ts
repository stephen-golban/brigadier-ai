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
