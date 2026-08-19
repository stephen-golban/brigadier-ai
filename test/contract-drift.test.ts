// SPDX-License-Identifier: Apache-2.0
/**
 * The transcription guard, exercised against drift it was not shown.
 *
 * `bar/lib/contract.ts` is a hand copy of the product's record format, because
 * `bar/` imports nothing from `src/`. Round 15 proved the copy fails SILENTLY:
 * `CheckOutcome` listed `skipped`, which the product has never emitted, and
 * omitted `not-run`, which is `INITIAL_OUTCOME` and lands in every blocking
 * check's slot before the check runs. Three items found the shape wrong,
 * widened it locally and carried on. Nothing failed; three items measured the
 * wrong thing.
 *
 * `compareContract` is the mechanical version of "somebody diffs the two files
 * on purpose". A guard that always passes is indistinguishable from a working
 * one until the day it matters, so every case below is a drift the checker must
 * SEE, in synthetic sources rather than in the real tree — and each one is
 * asserted by the words it prints, never by how many it found. A count is the
 * failure mode this repository has already measured: `.lsp.json` reported
 * `LSP servers (1)` for `{"notARealKey": 1}`.
 *
 * The last three describes are a critic's, not the author's: an earlier draft
 * passed everything above and still missed a merged interface declaration, a
 * re-exported type and a product field that turned optional.
 */

import { describe, expect, test } from "bun:test";
import { compareContract, runtimeDrift, vocabulary } from "../scripts/claims.ts";

const BAR = "bar/lib/contract.ts";
const ENTRY = "src/report/record.ts";

/** The product's side: a record module that names its enumerations elsewhere. */
const SRC: Record<string, string> = {
  [ENTRY]: `
    import type { CheckOutcome } from "../work/check.ts";
    import type { WorkKind } from "../work/kind.ts";
    export type ItemStatus = "integrated" | "failed";
    export interface RecordCheck {
      name: string;
      outcome: CheckOutcome;
      qualifier?: string;
    }
    export interface RunRecord {
      runId: string;
      runRoot: string;
      kind: WorkKind;
      status: ItemStatus;
      checks: RecordCheck[];
      cost?: { currency: string; quota: Record<string, "read" | "unreadable"> };
    }
  `,
  "src/work/check.ts": `export type CheckOutcome = "pass" | "fail" | "not-run";`,
  "src/work/kind.ts": `export type WorkKind = "write" | "read-only";`,
};

/** The harness's side: the same shape, inlined, and loose about optionality on purpose. */
const FAITHFUL = `
  export type ItemStatus = "integrated" | "failed";
  export type CheckOutcome = "pass" | "fail" | "not-run";
  export interface RecordCheck {
    name: string;
    outcome: CheckOutcome;
    qualifier?: string;
  }
  export interface RunRecord {
    runId: string;
    runRoot: string;
    kind?: "write" | "read-only";
    status?: ItemStatus;
    checks?: RecordCheck[];
    cost?: { currency: string; quota: Record<string, "read" | "unreadable"> };
  }
`;

function compare(bar: string, src: Record<string, string> = SRC) {
  return compareContract(new Map(Object.entries({ ...src, [BAR]: bar })), BAR, ENTRY);
}

/** Drift lines for one symbol. Asserting on the words is the point — see the header. */
function about(bar: string, symbol: string, src?: Record<string, string>): string[] {
  return compare(bar, src)
    .drifts.filter((d) => d.symbol === symbol)
    .map((d) => d.how);
}

describe("NEGATIVE CONTROL: a faithful transcription", () => {
  test("drifts against nothing", () => {
    expect(compare(FAITHFUL).drifts).toEqual([]);
  });

  test("and says by name what it compared, so a guard that resolved nothing is visible", () => {
    // The `.lsp.json` lesson: "everything agreed" and "nothing was read" print
    // the same when the report is a number.
    const { compared } = compare(FAITHFUL);
    expect(compared).toContain("CheckOutcome");
    expect(compared).toContain("RunRecord.kind");
    expect(compared).toContain("RunRecord.cost.quota");
  });

  test("the bar being LOOSER than the product is not drift — it distrusts every field it parses", () => {
    // `parseRecord` enforces almost nothing because it reads forged records too.
    // Requiring `checks: RecordCheck[]` here would fail a correct tree, and a
    // check that fails on a correct tree gets deleted rather than fixed.
    expect(compare(FAITHFUL.replace("checks?:", "checks:")).drifts).toEqual([]);
  });
});

describe("round 15, exactly: the vocabulary that drifted and nothing failed", () => {
  const drifted = FAITHFUL.replace(`"pass" | "fail" | "not-run"`, `"pass" | "fail" | "skipped"`);

  test("both directions are named, and the member is greppable", () => {
    expect(about(drifted, "CheckOutcome")).toEqual([
      "bar declares 'skipped' which src never emits; src emits 'not-run' which bar omits",
    ]);
  });

  test("and every field typed by it drifts too, so the blast radius is on the page", () => {
    expect(about(drifted, "RecordCheck.outcome")).toHaveLength(1);
  });
});

describe("a field on one side and not the other", () => {
  test("src writes a field the bar cannot see — the failure that made three items widen locally", () => {
    const [how] = about(FAITHFUL.replace("qualifier?: string;", ""), "RecordCheck.qualifier");
    expect(how).toContain("src writes this field");
    expect(how).toContain("bar omits it");
  });

  test("the bar describes a field the product never writes", () => {
    const [how] = about(FAITHFUL.replace("qualifier?: string;", "wasSkipped?: boolean;"), "RecordCheck.wasSkipped");
    expect(how).toContain("src writes no such field");
  });
});

describe("names are followed on both sides before anything is compared", () => {
  test("the bar inlining what the product names is not drift", () => {
    // `kind?: "write" | "read-only"` against `kind: WorkKind`, one import away.
    expect(about(FAITHFUL, "RunRecord.kind")).toEqual([]);
  });

  test("but the product growing a member behind that name is", () => {
    const grown = { ...SRC, "src/work/kind.ts": `export type WorkKind = "write" | "read-only" | "sandboxed";` };
    expect(about(FAITHFUL, "RunRecord.kind", grown)).toEqual(["src emits 'sandboxed' which bar omits"]);
  });

  test("a nested object literal is compared field by field, with the path in the name", () => {
    const narrowed = FAITHFUL.replace(`"read" | "unreadable"`, `"read"`);
    expect(about(narrowed, "RunRecord.cost.quota")).toHaveLength(1);
    expect(about(narrowed, "RunRecord.cost.quota")[0]).toContain("unreadable");
  });
});

describe("the shapes a transcription can lose whole", () => {
  test("the product exports a type the bar transcribes nothing for", () => {
    const [how] = about(FAITHFUL.replace(`export type ItemStatus = "integrated" | "failed";`, ""), "ItemStatus");
    expect(how).toContain("transcribes nothing by that name");
  });

  test("the bar transcribes a type the product no longer declares", () => {
    const [how] = about(`${FAITHFUL}\nexport type Phase = "planned" | "done";`, "Phase");
    expect(how).toContain(`nothing reachable from ${ENTRY} declares it`);
  });

  test("an alias where the product has an interface", () => {
    const [how] = about(
      FAITHFUL.replace(/export interface RecordCheck \{[^}]*\}/, "export type RecordCheck = string;"),
      "RecordCheck",
    );
    expect(how).toBe("bar declares a type alias; src declares an interface");
  });

  test("a transcription that cannot be read at all is drift, not silence", () => {
    // The vacuous pass this whole file exists to prevent: nothing exported,
    // nothing comparable, nothing to report.
    const { compared, drifts } = compare("// nothing here\n");
    expect(compared).toEqual([]);
    expect(drifts.some((d) => d.how.includes("could not be read"))).toBe(true);
  });
});

describe("CRITIC: a merged interface declaration", () => {
  // `interface RecordItem { … }` twice in one file is legal TypeScript and adds
  // fields to every item. A draft that kept the last declaration and dropped the
  // first printed a clean pass over a shape that had grown.
  test("a second declaration on the bar side is seen", () => {
    const merged = `${FAITHFUL}\nexport interface RecordCheck { sandboxEscape?: boolean }`;
    const [how] = about(merged, "RecordCheck.sandboxEscape");
    expect(how).toContain("src writes no such field");
  });

  test("a second declaration on the product side is seen", () => {
    const grown = {
      ...SRC,
      [ENTRY]: `${SRC[ENTRY]}\nexport interface RecordCheck { escapeDetail?: string }`,
    };
    const [how] = about(FAITHFUL, "RecordCheck.escapeDetail", grown);
    expect(how).toContain("src writes this field");
  });
});

describe("CRITIC: a re-exported type is not drift", () => {
  // Same members, same behaviour, `tsc --noEmit` clean — and a draft that
  // understood `import` but not `export … from` failed the correct tree.
  const moved = {
    ...SRC,
    "src/work/check.ts": `export type { CheckOutcome } from "./outcome.ts";`,
    "src/work/outcome.ts": `export type CheckOutcome = "pass" | "fail" | "not-run";`,
  };

  test("through a named re-export", () => {
    expect(compare(FAITHFUL, moved).drifts).toEqual([]);
    expect(compare(FAITHFUL, moved).compared).toContain("CheckOutcome");
  });

  test("through a star re-export", () => {
    const starred = { ...moved, "src/work/check.ts": `export * from "./outcome.ts";` };
    expect(compare(FAITHFUL, starred).drifts).toEqual([]);
  });

  test("and drift behind the re-export is still caught", () => {
    const drifted = { ...moved, "src/work/outcome.ts": `export type CheckOutcome = "pass" | "fail" | "skipped";` };
    expect(about(FAITHFUL, "CheckOutcome", drifted)).toEqual([
      "bar declares 'not-run' which src never emits; src emits 'skipped' which bar omits",
    ]);
  });
});

describe("CRITIC: optionality is exempt in ONE direction only", () => {
  test("the product loosening a field the bar still requires is drift", () => {
    // `runRoot: string` became `runRoot?: string` in the product. `tsc` catches
    // it; a draft that exempted optionality in both directions did not.
    const loosened = { ...SRC, [ENTRY]: SRC[ENTRY]!.replace("runRoot: string;", "runRoot?: string;") };
    const [how] = about(FAITHFUL, "RunRecord.runRoot", loosened);
    expect(how).toContain("src may omit this field");
    expect(how).toContain("bar declares it required");
  });

  test("NEGATIVE CONTROL: and the bar loosening it in step is not", () => {
    const loosened = { ...SRC, [ENTRY]: SRC[ENTRY]!.replace("runRoot: string;", "runRoot?: string;") };
    expect(compare(FAITHFUL.replace("runRoot: string;", "runRoot?: string;"), loosened).drifts).toEqual([]);
  });
});

describe("CRITIC: nothing may fail open", () => {
  test("a file that does not parse is drift rather than a file with fewer fields", () => {
    // Also pins `parseDiagnostics`, which is TypeScript-internal: the day it
    // stops existing, this test goes red instead of the gate going quiet.
    const broken = { ...SRC, [ENTRY]: `export interface RunRecord { runId: string;` };
    const [how] = about(FAITHFUL, ENTRY, broken);
    expect(how).toContain("did not parse");
  });

  test("an unreadable vocabulary is undefined, never an empty list", () => {
    const sources = new Map(Object.entries({ ...SRC, [BAR]: FAITHFUL }));
    expect(vocabulary(sources, ENTRY, "CheckOutcome")).toEqual({
      members: ["fail", "not-run", "pass"],
      enumerable: true,
    });
    expect(vocabulary(sources, BAR, "RecordCheck")).toBeUndefined();
    expect(vocabulary(sources, BAR, "NeverDeclared")).toBeUndefined();
  });

  test("a union widened out of an enumeration reports its literals AND says it is no longer closed", () => {
    // `blocks()` parity cannot be checked exhaustively against an open union.
    // Reporting `enumerable: false` is what makes the gate say so instead of
    // comparing an empty list and exiting 0.
    const widened = new Map([[BAR, `export type CheckOutcome = "pass" | "fail" | (string & {});`]]);
    expect(vocabulary(widened, BAR, "CheckOutcome")).toEqual({
      members: ["fail", "pass"],
      enumerable: false,
    });
  });
});

describe("CRITIC: the runtime half must fail loud, never empty", () => {
  // A regex, a function and a value: none of them is a type, so all three can
  // move while both files still declare identical shapes.
  const sources = (bar: string, src: Record<string, string> = SRC) =>
    new Map(Object.entries({ ...src, [BAR]: bar }));

  const PROBE = {
    pointerFor: (path: string) => `run-record: ${path}`,
    samplePath: "/tmp/record.json",
    recordLine: /^\s*run-record:\s*(\S.*?)\s*$/m,
    initialOutcome: "not-run",
    barBlocks: (outcome: string) => outcome !== "pass",
    srcBlocks: (outcome: string) => outcome !== "pass",
    behaviourFile: "src/work/check.ts",
  };

  test("NEGATIVE CONTROL: a transcription in step reports nothing", () => {
    expect(runtimeDrift(sources(FAITHFUL), BAR, ENTRY, PROBE)).toEqual([]);
  });

  test("a pattern that cannot read the product's own pointer line", () => {
    const [found] = runtimeDrift(sources(FAITHFUL), BAR, ENTRY, { ...PROBE, recordLine: /^record:\s*(\S+)$/m });
    expect(found?.symbol).toBe("RECORD_LINE");
    expect(found?.how).toContain("reads nothing out of it");
  });

  test("blocks() disagreeing on one outcome names the outcome", () => {
    const found = runtimeDrift(sources(FAITHFUL), BAR, ENTRY, { ...PROBE, barBlocks: () => true });
    expect(found.map((d) => d.symbol)).toEqual(["blocks('pass')"]);
    expect(found[0]?.how).toBe("bar says true, src says false");
  });

  test("a vocabulary the gate cannot read is a failure, not an empty comparison", () => {
    // The draft this replaces coalesced `undefined` to `[]`, compared nothing,
    // and exited 0 while printing an empty outcome list.
    const gone = { ...SRC, "src/work/check.ts": `export interface CheckOutcome { pass: boolean }` };
    const found = runtimeDrift(sources(FAITHFUL, gone), BAR, ENTRY, PROBE);
    expect(found.map((d) => d.how).join("\n")).toContain("never an empty list");
  });

  test("BOTH sides widened in step, and only the behaviour underneath moved", () => {
    // The structural diff is silent here — the two forms are identical — so this
    // is the only thing standing between an open union and an unchecked one.
    const open = `export type CheckOutcome = "pass" | "fail" | "not-run" | (string & {});`;
    const found = runtimeDrift(
      sources(FAITHFUL.replace(`export type CheckOutcome = "pass" | "fail" | "not-run";`, open), {
        ...SRC,
        "src/work/check.ts": open,
      }),
      BAR,
      ENTRY,
      { ...PROBE, srcBlocks: (outcome) => outcome !== "pass" && outcome !== "not-run" },
    );
    const said = found.map((d) => d.how).join("\n");
    expect(said).toContain("the product's outcome union is no longer a closed set");
    expect(said).toContain("bar's outcome union is no longer a closed set");
    // And the literals that DID survive are still compared behaviourally.
    expect(found.map((d) => d.symbol)).toContain("blocks('not-run')");
  });

  test("the value the product writes into every blocking slot must be nameable", () => {
    const found = runtimeDrift(sources(FAITHFUL), BAR, ENTRY, { ...PROBE, initialOutcome: "skipped" });
    expect(found[0]?.how).toContain("INITIAL_OUTCOME 'skipped'");
  });
});
