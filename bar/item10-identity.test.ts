// SPDX-License-Identifier: Apache-2.0
/**
 * Item 10's attribution checks, driven in BOTH directions.
 *
 * The defect these checks exist for: this binary's warm start has been recorded
 * four times, against four artifacts, and nothing tied any figure to any
 * artifact. What changed between the figures was never established and no trend
 * may be read into them.
 *
 * The defect THIS FILE exists for is the other one. Round 15 audited seven items
 * and found all seven reporting green on something they were not checking, and
 * `Checks.note()` stamps `ok: true`, so a note is not a check. An attribution
 * guard that passes whatever the artifact prints would look exactly like a
 * working one. So each guard below is shown failing:
 *
 *   ABSENT   `brigadier version` prints no BUILD-ID line — the identifier check
 *            must fail, not shrug.
 *   STALE    it prints a well-formed BUILD-ID whose sha256 is some other
 *            build's — the "names the artifact that was timed" check must fail.
 *            This is the one a stamp cannot fake, because the harness recomputes
 *            the digest from the bytes it timed.
 *   PARTIAL  it prints a BUILD-ID with a field missing or a field that is a
 *            placeholder — refused, and the missing field is NAMED.
 *
 * Assertions are on check NAMES throughout. A count of failures is satisfied by
 * the wrong failures.
 */

import { describe, expect, test } from "bun:test";
import {
  BUILD_ID_FIELDS,
  QUIET_WARM_MEASUREMENT,
  STRUCK_WARM_START,
  WITHDRAWN_WARM_BUDGET_MS,
  attribution,
  judgeArtifact,
  parseBuildId,
  struckWarmLine,
  type ArtifactObservations,
} from "./items/10-the-artifact-ships.ts";

const SHA = "9".repeat(64);
const BUILD_ID =
  `BUILD-ID commit=${"a".repeat(40)} tree=clean bun=1.3.14 ` +
  `bun-revision=0d9b296af33f2b851fcbf4df3e9ec89751734ba4 binary-sha256=${SHA} binary-bytes=62914560`;

/**
 * An observation set that is identified, and otherwise says nothing in
 * particular.
 *
 * Deliberately NOT the fully truthful fixture: that one lives in
 * `bar/items.test.ts` beside the licence and hook material it exists for, and it
 * already asserts that a truthful artifact produces NO failing checks — so if
 * the three attribution guards below were wrong about a good artifact, that test
 * goes red rather than this one. Here the other rows are free to fail, because
 * every assertion in this file is on a check NAME. A count of failures would be
 * satisfied by the wrong failures, which is the mistake this repository has
 * shipped before.
 */
const ARTIFACT: ArtifactObservations = {
  licences: { code: 0, stdout: "brigadier — Apache-2.0", stderr: "" },
  full: { code: 0, stdout: "", stderr: "" },
  markersFound: [],
  sizeBytes: 60 * 1_048_576,
  emptyFloor: { bytes: 61_914_560, how: "compiled here by bun 1.3.14 and measured at 61914560 bytes" },
  versionProbe: { code: 0, stdout: `${BUILD_ID}\n\nbrigadier 0.0.0\n`, stderr: "" },
  binarySha256: SHA,
  warmMs: 8,
  spawnFloorMs: 1,
  nodeless: { code: 0, stdout: "", stderr: "" },
  nodelessPathRemoved: ["/nvm/bin"],
  nodeOnPath: { before: "/nvm/bin/node", after: "" },
  installProbe: "",
  installedPaths: [],
  homeBeforeInstall: [],
  homeAfterUninstall: [],
  uninstall: { code: 0, stdout: "", stderr: "" },
  emptyDirsLeft: [],
  hooksProbe: "",
  installedHookFile: { events: [] },
  hostDetails: { available: false, command: "claude plugin details brigadier", code: null, output: "" },
  poisonedHooksProbe: "",
  poisonedHooksCode: 1,
  poisonKey: "notARealEvent-abc123",
  poisonedPath: "/scratch/home/.claude/hooks.json",
};

const IDENTIFIED = "the artifact carries a build identifier — commit, tree state, compiling bun, and its own sha256";
const NAMES_THE_ARTIFACT = "the build identifier names the artifact that was actually timed";
const STATES_TREE = "the identifier states whether the tree it was built from was clean";

/** Every failing check's name. Names, never counts. */
const failed = (o: ArtifactObservations): string[] => judgeArtifact(o).failures.map((r) => r.name);
/** One check's rendered detail, so that what a reader is told can be asserted. */
const detailOf = (o: ArtifactObservations, name: string): string =>
  judgeArtifact(o).rows.find((r) => r.name === name)?.detail ?? "<no such check>";

const withVersion = (stdout: string, code = 0): ArtifactObservations => ({
  ...ARTIFACT,
  versionProbe: { code, stdout, stderr: "" },
});

describe("parseBuildId reads the line the artifact prints", () => {
  test("it finds every field of a well-formed line", () => {
    const parsed = parseBuildId(
      `some preamble\nBUILD-ID commit=${"a".repeat(40)} tree=dirty bun=1.3.14 ` +
        `bun-revision=${"b".repeat(40)} binary-sha256=${"c".repeat(64)} binary-bytes=62914560\ntrailer`,
    );
    expect(parsed.missing).toEqual([]);
    expect(parsed.malformed).toEqual([]);
    expect(parsed.fields["tree"]).toBe("dirty");
    expect(parsed.fields["binary-sha256"]).toBe("c".repeat(64));
  });

  test("a field that is a placeholder is MALFORMED, not present", () => {
    // The failure mode a lenient parser produces: `commit=unknown` satisfies a
    // "the field is there" check while identifying nothing at all.
    const parsed = parseBuildId("BUILD-ID commit=unknown tree=maybe bun=next bun-revision=none binary-sha256=n/a binary-bytes=lots");
    expect(parsed.missing.sort()).toEqual([...BUILD_ID_FIELDS].sort());
    expect(parsed.malformed.sort()).toEqual(
      ["binary-bytes=lots", "binary-sha256=n/a", "bun-revision=none", "bun=next", "commit=unknown", "tree=maybe"].sort(),
    );
  });

  test("no BUILD-ID line at all means every field is missing, by name", () => {
    const parsed = parseBuildId("brigadier 0.0.0\nsome other output entirely");
    expect(parsed.line).toBeUndefined();
    expect(parsed.missing.sort()).toEqual([...BUILD_ID_FIELDS].sort());
  });

  test("the unstamped rendering the product really prints is not mistaken for an identity", () => {
    // The exact string `src/build/identity.ts` emits when nothing was stamped
    // in. Written out here rather than imported, because `bar/` imports nothing
    // from `src/` — the harness must be told what to expect, not handed it.
    const parsed = parseBuildId(
      "BUILD-ID unstamped — this process was not produced by `bun run build`. No measurement may be attributed to this process.",
    );
    expect(parsed.line).toBeDefined();
    expect(parsed.missing.sort()).toEqual([...BUILD_ID_FIELDS].sort());
    expect(attribution(parsed)).toContain("UNIDENTIFIED");
  });
});

describe("the attribution string is printed whether or not there is one", () => {
  test("an identified artifact is cited by its own line", () => {
    const parsed = parseBuildId(ARTIFACT.versionProbe.stdout);
    expect(attribution(parsed)).toContain("ARTIFACT: BUILD-ID commit=");
  });

  test("an unidentified one says so, rather than saying nothing", () => {
    // Silence is the failure mode that produced four uncomparable timings. The
    // string must always be present beside a figure, and must always be either
    // an identity or the word UNIDENTIFIED.
    expect(attribution(parseBuildId(""))).toContain("ARTIFACT: UNIDENTIFIED");
    expect(attribution(parseBuildId(""))).toContain("cannot be compared with any other figure");
  });
});

describe("item 10's attribution guards, shown failing", () => {
  test("an identified artifact passes all three", () => {
    const names = failed(ARTIFACT);
    expect(names).not.toContain(IDENTIFIED);
    expect(names).not.toContain(NAMES_THE_ARTIFACT);
    expect(names).not.toContain(STATES_TREE);
  });

  test("NEGATIVE CONTROL — ABSENT: no BUILD-ID line fails the identifier check", () => {
    const names = failed(withVersion("brigadier 0.0.0\n"));
    expect(names).toContain(IDENTIFIED);
    expect(names).toContain(NAMES_THE_ARTIFACT);
    expect(names).toContain(STATES_TREE);
    expect(detailOf(withVersion("brigadier 0.0.0\n"), IDENTIFIED)).toContain("NO BUILD-ID line was printed");
  });

  test("NEGATIVE CONTROL — ABSENT: the version surface not existing at all fails it", () => {
    // `unknown command: version` on stderr, exit 2. An artifact with no version
    // surface must not be able to reach a pass.
    const o = withVersion("", 2);
    expect(failed(o)).toContain(IDENTIFIED);
  });

  test("NEGATIVE CONTROL — the JUDGE fails when the reported digest is not the timed file's", () => {
    // NOT a claim that a real artifact can reach this state on its own: a binary
    // that hashes `process.execPath` always reports the digest of the file that
    // is running, so a tampered copy reports its OWN true digest and passes.
    // This guards the judge against the states that ARE reachable — a report
    // stitched from two binaries, a hardcoded digest, and a future regression
    // that stamps the digest at compile time so it names the previous build.
    // The fixture is hand-edited because those states cannot be produced from a
    // single healthy artifact.
    const stale = ARTIFACT.versionProbe.stdout.replace(
      `binary-sha256=${ARTIFACT.binarySha256}`,
      `binary-sha256=${"1".repeat(64)}`,
    );
    expect(stale).not.toBe(ARTIFACT.versionProbe.stdout);
    const o = withVersion(stale);
    const names = failed(o);
    expect(names).toContain(NAMES_THE_ARTIFACT);
    // And the identifier itself is still well-formed, which is exactly why the
    // first check alone would have passed this artifact.
    expect(names).not.toContain(IDENTIFIED);
    expect(detailOf(o, NAMES_THE_ARTIFACT)).toContain("They DISAGREE");
  });

  test("the passing detail states the LIMIT of what agreement proves", () => {
    // A patched, re-signed copy of `dist/brigadier` reports the commit it was
    // stamped with beside its own true digest, and passes all three checks. A
    // reader of a green row must be told that, in the row.
    const detail = detailOf(ARTIFACT, NAMES_THE_ARTIFACT);
    expect(detail).toContain("LIMIT of what it proves");
    expect(detail).toContain("a patched binary reports its own true digest");
  });

  test("NEGATIVE CONTROL — PARTIAL: a missing field is refused, and NAMED", () => {
    for (const field of BUILD_ID_FIELDS) {
      const stripped = ARTIFACT.versionProbe.stdout.replace(new RegExp(`\\s${field}=\\S+`), "");
      const o = withVersion(stripped);
      expect(failed(o)).toContain(IDENTIFIED);
      expect(detailOf(o, IDENTIFIED)).toContain(field);
    }
  });

  test("NEGATIVE CONTROL — a commit that says `unknown` is not a commit", () => {
    const o = withVersion(ARTIFACT.versionProbe.stdout.replace(/commit=[0-9a-f]{40}/, "commit=unknown"));
    expect(failed(o)).toContain(IDENTIFIED);
    expect(detailOf(o, IDENTIFIED)).toContain("commit=unknown");
  });
});

describe("every figure item 10 reports is printed beside the artifact it belongs to", () => {
  const rowsOf = (o: ArtifactObservations) => judgeArtifact(o).rows;
  const warmRow = (o: ArtifactObservations) => rowsOf(o).find((r) => r.name.startsWith("warm start is MEASURED"));
  const coldRow = (o: ArtifactObservations) => rowsOf(o).find((r) => r.name.startsWith("what the struck clause"));
  const historyRow = (o: ArtifactObservations) => rowsOf(o).find((r) => r.name.startsWith("the warm figure has been recorded"));

  test("the warm figure carries the identifier", () => {
    const detail = warmRow(ARTIFACT)?.detail ?? "";
    expect(detail).toContain("ARTIFACT: BUILD-ID commit=");
    expect(detail).toContain(ARTIFACT.binarySha256);
  });

  test("the struck cold-start clause carries it too, and says the old cold figures do not", () => {
    const detail = coldRow(ARTIFACT)?.detail ?? "";
    expect(detail).toContain("ARTIFACT: BUILD-ID commit=");
    expect(detail).toContain("NONE OF THOSE COLD FIGURES NAMES AN ARTIFACT");
  });

  test("the four-reading history says it is not retroactively repairable", () => {
    const detail = historyRow(ARTIFACT)?.detail ?? "";
    expect(detail).toContain("NOT established");
    expect(detail).toContain("NOT RETROACTIVELY REPAIRABLE");
  });

  test("NEGATIVE CONTROL — an unidentified artifact's figures say UNIDENTIFIED, not nothing", () => {
    const o = withVersion("brigadier 0.0.0\n");
    expect(warmRow(o)?.detail ?? "").toContain("ARTIFACT: UNIDENTIFIED");
    expect(coldRow(o)?.detail ?? "").toContain("ARTIFACT: UNIDENTIFIED");
  });

  test("no number was moved to fit a measurement", () => {
    // Stated as a test because the temptation a strike creates is to raise the
    // number instead of withdrawing it. The clause that WAS in force said 10 ms;
    // it is withdrawn, and 10 is what the record still says it was.
    expect(WITHDRAWN_WARM_BUDGET_MS).toBe(10);
    expect(STRUCK_WARM_START.clause).toContain("≤10 ms warm start");
    // Amendment §17's 20 ms is named as NOT adopted, everywhere it is named.
    expect(struckWarmLine()).toContain("§17's proposed 20 ms is NOT adopted");
    const proposal = rowsOf(ARTIFACT).find((r) => r.name.startsWith("PROPOSAL, not adopted"));
    expect(proposal?.detail).toContain("has NOT adopted");
    expect(proposal?.detail).toContain("did not adopt it either");
    // And no row anywhere in this item states a threshold on the warm figure.
    for (const row of rowsOf(ARTIFACT)) {
      expect(row.name).not.toContain("warm start within");
    }
  });
});

/**
 * The 2026-08-20 strike, driven in both directions.
 *
 * Two behaviours have to be separated here, and a test that only checked the
 * first would pass on an item that had silently stopped timing the binary:
 *
 *   IT PRINTS.  A struck clause that leaves no trace in the output is the silent
 *               scaling-down `BAR.md` forbids, so the strike is a row of the
 *               item's own report on a PASS as well as on a failure, and it is
 *               not led with `ok  ` — a reader must be able to see that it
 *               asserted nothing.
 *   IT NO LONGER GATES.  This is the actual behaviour change, so it is driven
 *               with a figure far outside the withdrawn clause, and the item
 *               must not fail on it. The negative control is the other side: the
 *               MEASUREMENT is still a gate, so an artifact that produced no
 *               warm figure at all must go red.
 */
describe("the struck warm-start clause is PRINTED, and gates nothing", () => {
  const STRIKE = "STRUCK CLAUSE — this item asserts no warm-start budget, and none is promised (note)";
  const UNPROVEN = "what the struck warm clause leaves unproven (note)";
  const MEASURED = judgeArtifact(ARTIFACT)
    .rows.map((r) => r.name)
    .find((n) => n.startsWith("warm start is MEASURED"))!;

  test("the strike is a row of the item's own report, and carries its reasons", () => {
    const checks = judgeArtifact(ARTIFACT);
    const struck = checks.rows.find((r) => r.name === STRIKE);
    expect(struck).toBeDefined();
    expect(struck?.detail).toBe(struckWarmLine());
    expect(struck?.detail).toContain("WITHDRAWN by the owner");
    // The three reasons the record establishes, each present by its own bytes.
    expect(struck?.detail).toContain("MEASUREMENT-SESSION.md:140");
    expect(struck?.detail).toContain("7e6a547");
    expect(struck?.detail).toContain("13.99 ms corrected");
    expect(struck?.detail).toContain("0.65 ms");
    expect(struck?.detail).toContain("THREE DIFFERENT ARTIFACTS");
    // It names what is now unproven, and names the WARM promise rather than the
    // cold one: repeated invocation in a loop, not a first run.
    const unproven = checks.rows.find((r) => r.name === UNPROVEN);
    expect(unproven?.detail).toContain("REPEATEDLY IN A LOOP");
  });

  test("it prints on a PASSING run, not only when something else breaks", () => {
    // The whole point of `BAR.md`'s rule. Driven against the artifact fixture in
    // the state where the warm measurement itself is healthy.
    const checks = judgeArtifact(ARTIFACT);
    expect(checks.failures.map((r) => r.name)).not.toContain(STRIKE);
    expect(checks.failures.map((r) => r.name)).not.toContain(MEASURED);
    const line = checks
      .render()
      .split("\n")
      .find((l) => l.includes("STRUCK CLAUSE — this item asserts no warm-start budget"));
    expect(line).toBeDefined();
    // NEGATIVE CONTROL on the leader: a strike that printed with the same `ok`
    // leader as a genuine passing assertion would be indistinguishable from one,
    // which is the defect this item shipped once on a different row.
    expect(line?.startsWith("note ")).toBe(true);
    expect(line?.startsWith("ok")).toBe(false);
  });

  test("THE BEHAVIOUR CHANGE — a figure far outside the withdrawn clause does not fail the item", () => {
    // 13.99 ms is the quiet-machine reference, 3.99 ms outside the withdrawn
    // 10 ms clause; 40 ms is four times outside it. Neither may produce a
    // failing row, and no row may even name a threshold.
    for (const [warmMs, spawnFloorMs] of [
      [QUIET_WARM_MEASUREMENT.rawMinMs, QUIET_WARM_MEASUREMENT.spawnFloorMs],
      [41, 1],
      [1_000, 1],
    ] as const) {
      const checks = judgeArtifact({ ...ARTIFACT, warmMs, spawnFloorMs });
      expect(checks.failures.map((r) => r.name)).toEqual(
        judgeArtifact(ARTIFACT).failures.map((r) => r.name),
      );
      const row = checks.rows.find((r) => r.name === MEASURED);
      expect(row?.ok).toBe(true);
      expect(row?.detail).toContain("NO THRESHOLD IS APPLIED");
    }
  });

  test("the figure is still MEASURED and still PRINTED, with its method and provenance", () => {
    const detail = judgeArtifact({ ...ARTIFACT, warmMs: 15.27, spawnFloorMs: 1.28 }).rows.find(
      (r) => r.name === MEASURED,
    )?.detail;
    // The arithmetic a reader can re-derive: raw, floor, corrected.
    expect(detail).toContain("15.27 ms raw − 1.28 ms spawn floor = 13.99 ms");
    expect(detail).toContain("METHOD: minimum of 40 invocations");
    expect(detail).toContain(QUIET_WARM_MEASUREMENT.measuredOn);
    expect(detail).toContain(QUIET_WARM_MEASUREMENT.distribution);
    expect(detail).toContain("ARTIFACT: BUILD-ID commit=");
    // And no margin is stated, because there is nothing left to state one against.
    expect(detail).not.toContain("MARGIN:");
    expect(detail).not.toContain("ms OVER");
  });

  test("NEGATIVE CONTROL — the MEASUREMENT is still a gate: no figure at all is a FAILURE", () => {
    // The failure this leaves open if the strike is done carelessly: withdraw
    // the budget, and an item that stopped timing the binary altogether reads
    // exactly like one that timed it and reported. `run` leaves `warmMs` at
    // +Infinity when the loop produced no sample.
    for (const warmMs of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
      const checks = judgeArtifact({ ...ARTIFACT, warmMs, spawnFloorMs: 1 });
      expect(checks.failures.map((r) => r.name)).toContain(MEASURED);
      expect(checks.rows.find((r) => r.name === MEASURED)?.detail).toContain("ERROR — no warm figure was obtained");
    }
    // And a floor larger than the measurement is not a negative warm cost.
    const inverted = judgeArtifact({ ...ARTIFACT, warmMs: 1, spawnFloorMs: 5 });
    expect(inverted.failures.map((r) => r.name)).toContain(MEASURED);
  });

  test("NEGATIVE CONTROL — the strike row is not a check that can fail", () => {
    // A strike that could go red would block a tag exactly as a `FAIL` does,
    // which is the outcome `BAR.md`'s closing section exists to prevent. Driven
    // over every fixture state this file has.
    for (const o of [ARTIFACT, withVersion("brigadier 0.0.0\n"), { ...ARTIFACT, warmMs: Number.NaN }]) {
      const checks = judgeArtifact(o);
      expect(checks.failures.map((r) => r.name)).not.toContain(STRIKE);
      expect(checks.failures.map((r) => r.name)).not.toContain(UNPROVEN);
    }
  });

  test("the unidentified case still names no artifact rather than nothing", () => {
    const o = withVersion("brigadier 0.0.0\n");
    expect(judgeArtifact(o).rows.find((r) => r.name === UNPROVEN)?.detail).toContain("ARTIFACT: UNIDENTIFIED");
    expect(judgeArtifact(o).rows.find((r) => r.name === MEASURED)?.detail).toContain("ARTIFACT: UNIDENTIFIED");
  });
});
