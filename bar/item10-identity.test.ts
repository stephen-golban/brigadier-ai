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
  attribution,
  judgeArtifact,
  parseBuildId,
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
  const warmRow = (o: ArtifactObservations) => rowsOf(o).find((r) => r.name.startsWith("warm start within"));
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

  test("the warm budget is untouched by any of this", () => {
    // Stated as a test because the temptation this slice creates is to make the
    // number pass instead of naming the artifact. The budget is 10 ms, the
    // artifact misses it, and this file changed neither fact.
    expect(warmRow(ARTIFACT)?.name).toBe(
      "warm start within 10 ms (minimum of 40, floor-corrected)",
    );
    const over = judgeArtifact({ ...ARTIFACT, warmMs: 15.27, spawnFloorMs: 1.28 });
    expect(over.failures.map((r) => r.name)).toContain("warm start within 10 ms (minimum of 40, floor-corrected)");
  });
});
