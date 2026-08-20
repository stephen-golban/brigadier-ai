// SPDX-License-Identifier: Apache-2.0
/**
 * A demonstrated negative for every item's judgement.
 *
 * Ruling 62(b), and `AGENTS.md`: every check needs a negative control showing it
 * can fail, because a guard that always passes looks identical to a working one.
 * Mutation testing was researched and declined, so this file is where that
 * obligation lands for the JUDGEMENTS — each item's assertions are a pure
 * function of what it observed, so they can be handed the truth and then a lie,
 * and both directions asserted.
 *
 * The other half of the obligation lives in `bar/fakes.test.ts`, and it is the
 * one that matters more: a whole binary that prints correct-looking output and
 * does no work must score zero. A judgement that discriminates perfectly is
 * worthless if the item never reaches it, and only an end-to-end control catches
 * that.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  firstVersion,
  judgeDetection,
  parseAgentsTable,
  parseDetectJson,
  plantableAgent,
  type DetectObservations,
} from "./items/01-detection-is-honest.ts";
import { diffForeign, foreignPaths, type ForeignSnapshot } from "./items/03-no-foreign-file-touched.ts";
import { isLineAnchor, judgeCompetence } from "./items/05-review-is-cross-vendor.ts";
import {
  judgeInterrupt,
  namesPid,
  reportedBytesFor,
  type InterruptObservations,
} from "./items/07-interruption-leaves-nothing.ts";
import { judgeRefusal, type RefusalObservations } from "./items/08-impossible-plan-refused.ts";
import { judgeBinaryRefusal } from "./items/09-ambient-instructions-suppressed.ts";
import {
  emptyDirectories,
  hookEventsIn,
  HOST_NOT_RUN,
  judgeArtifact,
  lgplIntegrity,
  NODE_STRIP_NOT_RUN,
  pinNear,
  QUIET_WARM_MEASUREMENT,
  scanForMarkers,
  struckLine,
  struckWarmLine,
  WITHDRAWN_WARM_BUDGET_MS,
  type ArtifactObservations,
} from "./items/10-the-artifact-ships.ts";
import { judgeReport, type ReportObservations } from "./items/11-report-fits-the-window.ts";
import { judgeSecret } from "./items/12-secret-not-persisted.ts";
import { isUpwardClamp, judgeCost, savingsClaims, verifyIntegration, type CostObservations } from "./items/13-cost-model.ts";

import { Checks } from "./lib/checks.ts";
import type { RunRecord } from "./lib/contract.ts";
import { insideTempRoot, proofOfWork, resolveThroughSymlinks, type RunEvidence } from "./lib/evidence.ts";
import { probeFeature } from "./lib/feature.ts";
import { combine } from "./lib/halves.ts";
import { removeDir } from "./lib/fs.ts";
import { encodings, scanForSecret } from "./lib/secret.ts";
import { estimateTokens } from "./lib/plan.ts";
import { disagreements, parseSpec } from "./lib/spec.ts";

const created: string[] = [];
function scratch(name: string): string {
  const dir = join(tmpdir(), `bar-items-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) removeDir(dir);
});

const names = (checks: Checks): string[] => checks.failures.map((f) => f.name);

// ------------------------------------------------- the shared proof-of-work

describe("proofOfWork — the check a printer cannot satisfy", () => {
  const good: RunEvidence = {
    report: "run-record: /runs/r1/record.json",
    recordPath: "/runs/r1/record.json",
    recordExists: true,
    record: {
      runId: "r1",
      integrationRef: "refs/heads/brigadier/r1",
      integrationSha: "a".repeat(40),
      base: { ref: "refs/brigadier/r1/base", sha: "e".repeat(40) },
      runRoot: "/home/me/.brigadier/runs/r1",
      bindingFilter: "the plan had 1 item(s)",
      workers: 1,
      refusedDelegations: 0,
      // The product routes items by ORDINAL. `alpha` is the operator's handle;
      // `number` is the identity the clone, the marker and the item ref carry.
      items: [{ id: "alpha", number: 1, status: "integrated", commit: "f".repeat(40), itemRef: "refs/brigadier/r1/item/1" }],
    },
    refSha: "a".repeat(40),
    refType: "commit",
    fsckProblems: "",
    itemCommits: new Map([["alpha", { sha: "f".repeat(40), type: "commit", reachable: true }]]),
    subjects: ["brigadier: integrate item 1 of run r1 (wave 1)"],
    mergeParents: [{ sha: "b".repeat(40), parents: ["c".repeat(40), "d".repeat(40)] }],
    files: new Map([["alpha.txt", "TOKEN-1\n"]]),
    refsAfter: ["refs/heads/brigadier/r1"],
  };
  const expect1 = { expected: new Map([["alpha.txt", "TOKEN-1"]]), itemIds: ["alpha"] };

  // MEASURED by the independent verifier on 2026-08-20: in the full
  // `bun run gates` invocation this test was charged **149,471 ms** against Bun's
  // 5,000 ms default and failed, taking the whole gate red at 1,672 pass / 1
  // fail. An isolated `bun test bar/items.test.ts` was green — 140 pass in
  // 581 ms — and the verifier correctly retained the red rather than
  // substituting the green.
  //
  // The 149 seconds are not this test's work. `proofOfWork` is pure and
  // synchronous: it reads fields off the object it is handed, builds a `Checks`,
  // and returns. It opens no file, spawns nothing and awaits nothing. What it
  // was charged is wall-clock during which this process was not scheduled,
  // because the full suite runs in one process beside test files that spawn real
  // subprocesses.
  //
  // Ruling 62 (d): "a wall-clock bound may never be the only bound", for the
  // measured reason that a bound tight enough to catch a hang is tight enough to
  // flake. A pure synchronous call has no I/O to hang on — the only failure a
  // clock can catch here is an infinite loop — so the bound is kept and widened
  // to a value contention cannot reach, rather than removed.
  //
  // THIS IS A MITIGATION, NOT THE FIX, and it is written down rather than left
  // to be rediscovered: the real defect is that pure unit tests share a process
  // with subprocess-spawning ones and are charged their contention. Splitting
  // those into separate test processes is the fix, and it is not done here.
  const PURE_ASSERTION_TIMEOUT_MS = 120_000;

  test(
    "passes on a run that really happened",
    () => {
      expect(names(proofOfWork(good, expect1))).toEqual([]);
    },
    PURE_ASSERTION_TIMEOUT_MS,
  );

  test("fails when the ref file exists but the object does not — the 41-byte fake", () => {
    // The exact shape a blind critic used to score 10 of 13: a hand-written ref
    // file pointing at an object that was never created. `git fsck` sees it.
    const checks = proofOfWork({ ...good, fsckProblems: "broken link from ref refs/heads/brigadier/r1" }, expect1);
    expect(names(checks)).toContain("the repository survives `git fsck --connectivity-only --strict`");
  });

  test("fails when the ref does not resolve to a commit", () => {
    const checks = proofOfWork({ ...good, refSha: undefined, refType: undefined }, expect1);
    expect(names(checks)).toContain("the integration ref resolves to a real commit object");
  });

  test("fails when the report names a record that is not on disk", () => {
    const checks = proofOfWork({ ...good, recordExists: false, record: undefined }, expect1);
    expect(names(checks)).toContain("the run names a record on disk, and it is there");
  });

  test("fails when the merged tree does not carry the worker's token", () => {
    const checks = proofOfWork({ ...good, files: new Map([["alpha.txt", "something else"]]) }, expect1);
    expect(names(checks)).toContain("the merged tree contains every worker's actual output");
  });

  test("a commit SUBJECT naming the plan item proves nothing on its own", () => {
    // The shape `bar/fakes/forger.ts` used: chain commits, name each `-m "<id>:
    // integrated"`, publish no record entry for them. The old check searched
    // subjects for the id and passed; the product does not even write that
    // subject, so the check was measuring the forgery's manners.
    const checks = proofOfWork(
      {
        ...good,
        subjects: ["alpha: integrated"],
        record: { ...(good.record as RunRecord), items: [] },
        itemCommits: new Map(),
      },
      expect1,
    );
    expect(names(checks)).toContain("the record accounts for every plan item, by the ordinal the product routes it under");
    expect(names(checks)).toContain("each item's recorded commit is a real object the deliverable branch can reach");
  });

  test("fails when the record claims an item that is not `integrated`", () => {
    const record = good.record as RunRecord;
    const checks = proofOfWork(
      { ...good, record: { ...record, items: record.items.map((i) => ({ ...i, status: "failed" as const })) } },
      expect1,
    );
    expect(names(checks)).toContain("the record accounts for every plan item, by the ordinal the product routes it under");
  });

  test("fails when the record omits the ordinal the product routes by", () => {
    const record = good.record as RunRecord;
    const checks = proofOfWork(
      { ...good, record: { ...record, items: record.items.map(({ number: _n, ...rest }) => rest) } },
      expect1,
    );
    expect(names(checks)).toContain("the record accounts for every plan item, by the ordinal the product routes it under");
  });

  test("fails when the recorded commit is not an object the deliverable can reach", () => {
    const checks = proofOfWork(
      { ...good, itemCommits: new Map([["alpha", { sha: "f".repeat(40), type: "commit", reachable: false }]]) },
      expect1,
    );
    expect(names(checks)).toContain("each item's recorded commit is a real object the deliverable branch can reach");
  });

  test("fails when two items are recorded against ONE commit — a chain, not N merges", () => {
    const record = good.record as RunRecord;
    const twoItems: RunRecord = {
      ...record,
      items: [
        { id: "alpha", number: 1, status: "integrated", commit: "f".repeat(40) },
        { id: "beta", number: 2, status: "integrated", commit: "f".repeat(40) },
      ],
    };
    const checks = proofOfWork(
      {
        ...good,
        record: twoItems,
        itemCommits: new Map([
          ["alpha", { sha: "f".repeat(40), type: "commit", reachable: true }],
          ["beta", { sha: "f".repeat(40), type: "commit", reachable: true }],
        ]),
        mergeParents: [
          { sha: "b".repeat(40), parents: ["c".repeat(40), "d".repeat(40)] },
          { sha: "9".repeat(40), parents: ["8".repeat(40), "7".repeat(40)] },
        ],
        files: new Map([["alpha.txt", "TOKEN-1\n"]]),
      },
      { expected: new Map([["alpha.txt", "TOKEN-1"]]), itemIds: ["alpha", "beta"] },
    );
    expect(names(checks)).toContain("each item's recorded commit is a real object the deliverable branch can reach");
  });

  test("fails when the record names a branch but no integrationSha", () => {
    const record = good.record as RunRecord;
    const { integrationSha: _s, ...withoutSha } = record;
    const checks = proofOfWork({ ...good, record: withoutSha }, expect1);
    expect(names(checks)).toContain(
      "the record's integrationSha is what `git rev-parse` answers in the operator's repository",
    );
  });

  test("ruling 61 is checked by realpath, not lexically", () => {
    // macOS resolves /tmp to /private/tmp, so a lexical check would pass here.
    expect(insideTempRoot(tmpdir())).toBeDefined();
    expect(insideTempRoot("/usr")).toBeUndefined();
    // A run directory that was never created is exactly what a fabricating
    // binary names, and `realpath` throws on it. It must still be caught.
    expect(insideTempRoot(join(tmpdir(), "never-created-9f3a", "deeper"))).toBeDefined();
    expect(resolveThroughSymlinks(join(tmpdir(), "never-created-9f3a"))).toContain("never-created-9f3a");
    // THE PAIR THAT PINS THE SEPARATOR, both directions. Until 2026-08-20 this
    // function split on `"/"`, so on Windows it answered `undefined` for
    // everything — including the line above — and `undefined` is read by ruling
    // 61's check as *outside every temp root*, which is a pass. The line above
    // catches a separator that is too strict; this one catches a prefix test
    // that dropped the separator altogether and would call a SIBLING of the
    // temp root "inside" it.
    expect(insideTempRoot(`${realpathSync(tmpdir())}-elsewhere`)).toBeUndefined();
    expect(insideTempRoot(join(homedir(), "brigadier-not-a-temp-root"))).toBeUndefined();
    const checks = proofOfWork(
      { ...good, record: { ...(good.record as RunRecord), runRoot: join(tmpdir(), "runs") } },
      expect1,
    );
    expect(names(checks)).toContain("the run directory is outside every temp root (ruling 61, by realpath)");
  });
});

// ---------------------------------------------- the credential-free rule

describe("a failing credential-free half is never masked by a missing credential", () => {
  test("a failed credential-free check outranks a skipped live half", () => {
    const cf = new Checks();
    cf.expect("competence prints rows", false, "printed nothing at all");
    const result = combine(["did"], cf, { kind: "skipped", why: "needs vendors" });
    expect(result.outcome).toBe("FAIL");
    expect(result.halves).toEqual({ credentialFree: "FAIL", live: "SKIPPED" });
    expect(result.reason).toContain("competence prints rows");
  });

  test("a failed credential-free check outranks a missing feature", () => {
    const cf = new Checks();
    cf.expect("refusal fires", false, "did not refuse");
    const result = combine(["did"], cf, {
      kind: "missing",
      probe: { present: false, recognised: false, result: { stdout: "", stderr: "unknown command", code: 2, signal: null, ms: 1 }, transcript: "t" },
      promise: "no run",
    });
    expect(result.outcome).toBe("FAIL");
    expect(result.reason).toContain("refusal fires");
  });

  test("a clean credential-free half still yields SKIPPED when the live half needs vendors", () => {
    const result = combine(["did"], new Checks(), { kind: "skipped", why: "needs vendors" });
    expect(result.outcome).toBe("SKIPPED");
    expect(result.halves).toEqual({ credentialFree: "PASS", live: "SKIPPED" });
  });

  test("a missing feature is FAIL, never SKIPPED", () => {
    const result = combine(["did"], new Checks(), {
      kind: "missing",
      probe: { present: false, recognised: false, result: { stdout: "", stderr: "unknown command: run", code: 2, signal: null, ms: 1 }, transcript: "ran run; exit 2" },
      promise: "no run subcommand",
    });
    expect(result.outcome).toBe("FAIL");
    expect(result.reason).toContain("not a legal cause of a skip");
  });
});

// -------------------------------------------------- the registry derivation

describe("the item set is derived from BAR.md", () => {
  const spec = parseSpec(
    ["### 1. First thing", "", "*Rulings 6, 41.* because", "", "### 2. Second thing", "", "*Rulings 43.* because"].join("\n"),
  );

  test("headings and ruling lines are parsed", () => {
    expect(spec).toEqual([
      { id: 1, title: "First thing", rulings: [6, 41] },
      { id: 2, title: "Second thing", rulings: [43] },
    ]);
  });

  test("a deleted item is caught even if a constant beside the register is edited", () => {
    const register = [{ id: 1, title: "First thing", rulings: [6, 41] }];
    const found = disagreements(spec, register);
    expect(found.map((d) => d.kind)).toEqual(["missing-from-register"]);
  });

  test("an item the document never defined is caught too", () => {
    const register = [
      { id: 1, title: "First thing", rulings: [6, 41] },
      { id: 2, title: "Second thing", rulings: [43] },
      { id: 3, title: "Invented", rulings: [1] },
    ];
    expect(disagreements(spec, register).map((d) => d.kind)).toEqual(["not-in-spec"]);
  });

  test("a drifted title or ruling list is caught", () => {
    const register = [
      { id: 1, title: "First thing renamed", rulings: [6, 41] },
      { id: 2, title: "Second thing", rulings: [43, 99] },
    ];
    expect(disagreements(spec, register).map((d) => d.kind).sort()).toEqual(["rulings", "title"]);
  });

  test("agreement produces nothing", () => {
    expect(disagreements(spec, [...spec])).toEqual([]);
  });
});

// ------------------------------------------------------------------ item 1

const TRUTHFUL_DETECTION: DetectObservations = {
  agent: "qwen",
  measuredVersion: "0.21.13",
  plantedPath: "/planted/bin/qwen",
  driftVersion: "99.0.0-bar-moved",
  sentinel: "bar-remedy-abc",
  offPath: { id: "qwen", availability: "absent", remedy: "qwen is not on PATH" },
  decoy: { id: "qwen", availability: "absent", resolvedPath: "/planted/bin/qwen", remedy: "exit 9" },
  loggedOut: {
    id: "qwen",
    availability: "unusable",
    resolvedPath: "/planted/bin/qwen",
    remedy: "session/new: -32000 run auth login [bar-remedy-abc]",
  },
  loggedOutHuman: "! qwen unusable  session/new: -32000 run auth login [bar-remedy-abc]",
  atMeasured: { id: "qwen", availability: "usable", version: "0.21.13", resolvedPath: "/planted/bin/qwen" },
  drifted: { id: "qwen", availability: "usable", version: "99.0.0-bar-moved", resolvedPath: "/planted/bin/qwen" },
  driftedHuman:
    "qwen usable 99.0.0-bar-moved — DRIFT: measured against 0.21.13; laneAssertion unverified (blocking), capabilities unverified (warn)",
  contactWhenUsable: ["spawned", "initialize", "session-new"],
  contactWhenOffPath: [],
};

describe("item 1 — detection is honest", () => {
  test("passes on a product that reports what the harness planted", () => {
    expect(names(judgeDetection(TRUTHFUL_DETECTION))).toEqual([]);
  });

  test("fails when nothing was ever spawned, however good the JSON looked", () => {
    const checks = judgeDetection({ ...TRUTHFUL_DETECTION, contactWhenUsable: [] });
    expect(names(checks)).toContain("the binary really spawned the agent and completed BOTH protocol steps");
  });

  test("fails when only the handshake happened but `usable` was reported", () => {
    const checks = judgeDetection({ ...TRUTHFUL_DETECTION, contactWhenUsable: ["spawned", "initialize"] });
    expect(names(checks)).toContain("the binary really spawned the agent and completed BOTH protocol steps");
  });

  test("fails when an agent that is off PATH is claimed present", () => {
    const checks = judgeDetection({ ...TRUTHFUL_DETECTION, offPath: { id: "qwen", availability: "usable", version: "0.21.13" } });
    expect(names(checks)).toContain("renamed off PATH reports absent");
  });

  test("fails when the resolved PATH entry is assumed rather than reported", () => {
    const checks = judgeDetection({ ...TRUTHFUL_DETECTION, decoy: { id: "qwen", availability: "absent", resolvedPath: "/usr/local/bin/qwen" } });
    expect(names(checks)).toContain("the RESOLVED PATH entry is reported verbatim");
  });

  test("fails when a handshake alone is reported usable (ruling 41)", () => {
    const checks = judgeDetection({ ...TRUTHFUL_DETECTION, loggedOut: { id: "qwen", availability: "usable", version: "0.21.13" } });
    expect(names(checks)).toContain("handshake without a session is unusable, not usable");
  });

  test("fails when the vendor's remedy is swallowed", () => {
    const checks = judgeDetection({ ...TRUTHFUL_DETECTION, loggedOutHuman: "! qwen unusable" });
    expect(names(checks)).toContain("the vendor's own remedy text is printed to a human, not swallowed");
  });

  test("fails when drift is not reported at all (ruling 69)", () => {
    const checks = judgeDetection({ ...TRUTHFUL_DETECTION, driftedHuman: "qwen usable 99.0.0-bar-moved" });
    expect(names(checks)).toContain("a drifted version is reported at all");
  });

  test("is not satisfied by the echo of the version it planted", () => {
    const checks = judgeDetection({
      ...TRUTHFUL_DETECTION,
      driftVersion: "99.0.0-bar-drift",
      drifted: { id: "qwen", availability: "usable", version: "99.0.0-bar-drift" },
      driftedHuman: "qwen usable 99.0.0-bar-drift",
    });
    expect(names(checks)).toContain("a drifted version is reported at all");
  });

  test("parses `brigadier agents`, and picks a plantable row", () => {
    const rows = parseAgentsTable(
      [
        "claude — Claude Code",
        "  command    npx -y @agentclientprotocol/claude-agent-acp",
        "  measured   0.69.0 (claude 2.1.233)",
        "",
        "qwen — Qwen Code",
        "  command    qwen --acp",
        "  measured   0.21.13",
      ].join("\n"),
    );
    expect(rows.map((r) => r.id)).toEqual(["claude", "qwen"]);
    expect(plantableAgent(rows)?.id).toBe("qwen");
    expect(plantableAgent(rows.filter((r) => r.id === "claude"))).toBeUndefined();
    expect(firstVersion("0.69.0 (claude 2.1.233)")).toBe("0.69.0");
    expect(parseDetectJson("not json at all")).toEqual([]);
  });
});

// ------------------------------------------------------------------ item 3

describe("item 3 — no foreign file is touched", () => {
  const before: ForeignSnapshot = {
    files: { "/home/.claude/settings.json": "aaa" },
    trees: { "/home/.config/opencode": "bbb" },
  };

  test("passes when every digest is unchanged", () => {
    expect(diffForeign(before, before)).toEqual([]);
  });

  test("fails when a file changes", () => {
    expect(diffForeign(before, { files: { "/home/.claude/settings.json": "ccc" }, trees: before.trees })).toHaveLength(1);
  });

  test("an absent file is a distinct observation from a digest", () => {
    expect(diffForeign(before, { files: { "/home/.claude/settings.json": "absent" }, trees: before.trees })).toHaveLength(1);
  });

  test("BAR.md's own list of foreign locations is covered", () => {
    const paths = foreignPaths("/home").join(" ");
    for (const vendor of [".claude", ".codex", ".cursor", ".gemini", ".kiro"]) expect(paths).toContain(vendor);
  });
});

// ------------------------------------------------------------------ item 5

describe("item 5 — the competence table is auditable from the binary", () => {
  const good = [
    "claude-opus  0.92  measured  #46 handshake probe",
    "codex-gpt5   0.88  reported  vendor model card",
    "nobody-ranked  unranked  editorial  used, sorted last, and named",
  ].join("\n");

  test("passes on rows with an evidence class and a non-anchored citation", () => {
    expect(names(judgeCompetence({ code: 0, stdout: good, stderr: "" }))).toEqual([]);
  });

  test("fails on a line-anchored citation (ruling 68)", () => {
    const checks = judgeCompetence({ code: 0, stdout: `${good}\nqwen  0.4  measured  competence.ts:112`, stderr: "" });
    expect(names(checks)).toContain("no citation is a line anchor (ruling 68)");
  });

  test("fails when a model the table never heard of is silently excluded", () => {
    const checks = judgeCompetence({ code: 0, stdout: good.split("\n").slice(0, 2).join("\n"), stderr: "" });
    expect(names(checks)).toContain("a model the table has never heard of is named rather than silently excluded");
  });

  test("fails when it prints nothing at all", () => {
    const checks = judgeCompetence({ code: 0, stdout: "", stderr: "" });
    expect(names(checks)).toContain("`brigadier competence` prints rows");
  });

  test("the anchor predicate recognises all three spellings", () => {
    expect(isLineAnchor("src/foo.ts:112")).toBe(true);
    expect(isLineAnchor("https://example.invalid/blob/main/x.ts#L12")).toBe(true);
    expect(isLineAnchor("line 44 of the report")).toBe(true);
    expect(isLineAnchor("#46, the ACP handshake probe")).toBe(false);
  });
});

// ------------------------------------------------------------------ item 7

describe("item 7 — an interruption leaves nothing behind", () => {
  // Its own session and group leader, off the ppid graph, and carrying no
  // marker: the three facts that make ruling 38's THIRD link the thing under
  // test rather than its first two.
  const escapee = { pid: 4242, ppid: 1, pgid: 4242, commandLine: "/bin/sh /w/07/runs/r/ab12/escapee-escaper.sh" };

  const clean: InterruptObservations = {
    escapeePid: 4242,
    escapee,
    escapeeParentAlive: false,
    aliveBeforeSweep: true,
    aliveAfterSweep: false,
    interruptInFlight: true,
    survivedFirstInterrupt: true,
    heartbeatAtKill: 200,
    heartbeatBeforeSweep: 400,
    heartbeatAfterSweep: 420,
    heartbeatSettled: 420,
    clonesAtKill: ["/runs/r1/item-1", "/runs/r1/item-2"],
    survivingClones: [{ path: "/runs/r1/item-2", hadCommits: true, bytes: 4096, committedValue: "d3adb33fcafe" }],
    expectedCommittedValue: "d3adb33fcafe",
    reportAfterSweep:
      "  reclaimed pid 4242 (item 1): UNMARKED and unreachable through the ppid graph\n" +
      "  r1 item 2: /runs/r1/item-2 (0.00 MB, 4096 bytes) — holding commit 9c1f — the run is incomplete",
    recordAfterSweep: "",
    secondInterrupt: { code: null, signal: "SIGINT", timedOut: false },
  };

  test("passes when the sweep reclaimed the escapee and kept the committed clone", () => {
    expect(names(judgeInterrupt(clean))).toEqual([]);
  });

  test("fails when the escaped descendant is STILL ALIVE after the sweep (ruling 38)", () => {
    expect(names(judgeInterrupt({ ...clean, aliveAfterSweep: true }))).toContain("the next start's sweep reclaimed it (ruling 38)");
    expect(names(judgeInterrupt({ ...clean, heartbeatSettled: 900 }))).toContain("the next start's sweep reclaimed it (ruling 38)");
  });

  test("fails when nothing ever escaped — the check would pass for the wrong reason", () => {
    expect(names(judgeInterrupt({ ...clean, escapeePid: 0, aliveBeforeSweep: false }))).toContain(
      "a descendant really escaped and was STILL ALIVE when the sweep started",
    );
  });

  test("fails when the descendant SELF-TERMINATED, which reads like a successful sweep", () => {
    // Dead before the sweep even started. On file sizes alone this is
    // indistinguishable from containment; on the pid it is not.
    expect(names(judgeInterrupt({ ...clean, aliveBeforeSweep: false }))).toContain(
      "a descendant really escaped and was STILL ALIVE when the sweep started",
    );
  });

  test("fails when the binary died on the FIRST signal, having no handler at all", () => {
    // A binary with no SIGINT handling satisfies "re-raises rather than
    // inventing an exit code" for free. Surviving the first is what makes the
    // second interrupt a statement about a drain.
    expect(names(judgeInterrupt({ ...clean, survivedFirstInterrupt: false }))).toContain(
      "the orchestrator SURVIVED the first interrupt to drain (ruling 63)",
    );
  });

  test("a tick landing between the reading and the kill is not a failure", () => {
    // The race that fired as a real failure: 35 bytes read, then one more tick
    // before the sweep's `kill` arrived. Stopping is the property, not never
    // having grown again.
    expect(names(judgeInterrupt({ ...clean, heartbeatAfterSweep: 425, heartbeatSettled: 425 }))).toEqual([]);
  });

  test("fails when a clone with committed work was destroyed (ruling 63)", () => {
    const checks = judgeInterrupt({ ...clean, survivingClones: [] });
    expect(names(checks)).toContain("a clone WITH committed work is retained, reported with path and bytes (ruling 63)");
  });

  test("fails when the retained clone is not named in the report", () => {
    const checks = judgeInterrupt({ ...clean, reportAfterSweep: "interrupted" });
    expect(names(checks)).toContain("a clone WITH committed work is retained, reported with path and bytes (ruling 63)");
  });

  test("fails when an empty clone was left behind", () => {
    const checks = judgeInterrupt({
      ...clean,
      survivingClones: [...clean.survivingClones, { path: "/runs/r1/item-3", hadCommits: false, bytes: 0, committedValue: null }],
    });
    expect(names(checks)).toContain("every clone this item saw is accounted for, and none WITHOUT committed work survives");
  });

  test("naming an empty clone in the report is NOT a licence to keep it", () => {
    // BAR.md: "the next start's sweep reclaims it, no clone survives." The
    // product's own `test/run-kept.test.ts` fixes the answer for this exact
    // clone — *"NEGATIVE: a clone with no commits and a clean tree is NOT
    // retained"*, commented "the escapee's clone in BAR item 7" — so retention
    // here is a failure however loudly it is announced. Without this, a product
    // that stopped deleting empty clones altogether would pass item 7.
    const checks = judgeInterrupt({
      ...clean,
      survivingClones: [...clean.survivingClones, { path: "/runs/r1/item-1", hadCommits: false, bytes: 88, committedValue: null }],
      reportAfterSweep: `${clean.reportAfterSweep}\n  r1 item 1: /runs/r1/item-1 (0.00 MB, 88 bytes) — retained`,
    });
    expect(names(checks)).toContain("every clone this item saw is accounted for, and none WITHOUT committed work survives");
  });

  test("fails when the item never saw a clone at all — the check has no denominator", () => {
    // `filter(…).length === 0` over an empty list passes, and the list WAS
    // empty for nine rounds while this item enumerated a path shape the product
    // does not use. An empty denominator must never read as a clean sweep.
    expect(names(judgeInterrupt({ ...clean, clonesAtKill: [], survivingClones: [] }))).toContain(
      "every clone this item saw is accounted for, and none WITHOUT committed work survives",
    );
  });

  test("fails when the retained clone exists but no longer HOLDS the work (finding 92)", () => {
    // A directory with the right name and nothing in it satisfies every path
    // check ever written. Finding 92 is about work being unrecoverable.
    expect(
      names(
        judgeInterrupt({
          ...clean,
          survivingClones: [{ path: "/runs/r1/item-2", hadCommits: true, bytes: 4096, committedValue: null }],
        }),
      ),
    ).toContain("the retained clone still HOLDS the committed work, byte for byte (finding 92)");
  });

  test("fails when the report gives the path but no byte figure (ruling 63)", () => {
    const checks = judgeInterrupt({ ...clean, reportAfterSweep: "  r1 item 2: /runs/r1/item-2 — retained" });
    expect(names(checks)).toContain("a clone WITH committed work is retained, reported with path and bytes (ruling 63)");
  });

  test("fails when the descendant was still MARKED — links 1 and 2 would have caught it", () => {
    expect(
      names(judgeInterrupt({ ...clean, escapee: { ...escapee, commandLine: "bun agent.ts --brigadier-run=ab12/1" } })),
    ).toContain("the descendant defeated ruling 38's first two links: UNMARKED, and off the ppid graph");
  });

  test("fails when the descendant is still on the ppid graph of a live process", () => {
    expect(
      names(judgeInterrupt({ ...clean, escapee: { ...escapee, ppid: 9001 }, escapeeParentAlive: true })),
    ).toContain("the descendant defeated ruling 38's first two links: UNMARKED, and off the ppid graph");
  });

  test("fails when the sweep killed it and named the pid nowhere (ruling 63)", () => {
    const checks = judgeInterrupt({
      ...clean,
      reportAfterSweep: "  r1 item 2: /runs/r1/item-2 (0.00 MB, 4096 bytes) — retained",
      recordAfterSweep: "{\"type\":\"run-started\"}",
    });
    expect(names(checks)).toContain("the sweep NAMED the pid it reclaimed (ruling 63)");
  });

  test("the pid named only in the run record on disk is enough", () => {
    // `describeStartSweep`'s lines travel as the report's `detail`, and ruling
    // 58's cap drops `detail` entirely for the DEFAULT audience. A check that
    // only read stdout would fail a product that wrote the pid down correctly.
    expect(
      names(
        judgeInterrupt({
          ...clean,
          reportAfterSweep: "  r1 item 2: /runs/r1/item-2 (0.00 MB, 4096 bytes) — retained",
          recordAfterSweep: "{\"type\":\"swept\",\"reclaimedPids\":[4242],\"survivors\":[]}",
        }),
      ),
    ).toEqual([]);
  });

  test("fails when the run was never in flight when this item signalled it", () => {
    // `src/run/interrupt.ts` defines a signal arriving before the first clone
    // as "exit immediately with the signal's status" — correct behaviour that
    // looks, from outside, exactly like having no handler at all.
    expect(names(judgeInterrupt({ ...clean, interruptInFlight: false }))).toContain(
      "the orchestrator SURVIVED the first interrupt to drain (ruling 63)",
    );
  });

  test("fails when a second interrupt invents an exit code instead of re-raising", () => {
    const checks = judgeInterrupt({ ...clean, secondInterrupt: { code: 130, signal: null, timedOut: false } });
    expect(names(checks)).toContain("a second interrupt re-raises the signal rather than inventing an exit code");
  });

  test("a pid is read from a pid-bearing line and never from a coincidence", () => {
    // The failure this guards: a byte count, a timestamp or a MB figure that
    // happens to contain the digits. A check a coincidence can pass is not one.
    expect(namesPid("  reclaimed pid 4242 (item 1): confirmed gone", 4242)).toBe(true);
    expect(namesPid("  r1 item 2: /runs/r1/x (0.00 MB, 4242 bytes) — retained", 4242)).toBe(false);
    expect(namesPid("  reclaimed pid 42421 (item 1)", 4242)).toBe(false);
    expect(namesPid('{"type":"swept","reclaimedPids":[4242]}', 4242)).toBe(false);
    // …and the record's own field names are only readable in the loose form,
    // which reads the FIELD and not the line: a minified event is one line, so
    // a byte count beside an empty `reclaimedPids` must not credit the pid.
    expect(namesPid('{"type":"swept","reclaimedPids":[4242]}', 4242, true)).toBe(true);
    expect(namesPid('{"type":"swept","reclaimedPids":[7,4242,9],"survivors":[]}', 4242, true)).toBe(true);
    expect(namesPid('{"type":"swept","survivors":[4242]}', 4242, true)).toBe(true);
    expect(namesPid('{"type":"swept","reclaimedPids":[],"bytes":4242}', 4242, true)).toBe(false);
    expect(namesPid('{"type":"item","bytes":4242}', 4242, true)).toBe(false);
    expect(namesPid('{"type":"swept","reclaimedPids":[42421]}', 4242, true)).toBe(false);
  });

  test("the retained clone's bytes are read out of the PRODUCT's line, not the harness's stat", () => {
    const line = "  r1 item 2: /runs/r1/item-2 (0.00 MB, 4096 bytes) — holding commit 9c1f";
    expect(reportedBytesFor(line, "/runs/r1/item-2")).toBe(4096);
    expect(reportedBytesFor("  r1 item 2: /runs/r1/item-2 — retained", "/runs/r1/item-2")).toBe(null);
    expect(reportedBytesFor(line, "/runs/r1/item-9")).toBe(null);
    expect(reportedBytesFor("  x: /p (1,048,576 bytes)", "/p")).toBe(1048576);
  });

  test("fails when two signals left it running and the bounded wait expired", () => {
    const checks = judgeInterrupt({ ...clean, secondInterrupt: { code: null, signal: null, timedOut: true } });
    expect(names(checks)).toContain("a second interrupt re-raises the signal rather than inventing an exit code");
  });
});

// ------------------------------------------------------------------ item 8

describe("item 8 — an impossible plan is refused before anything is spawned", () => {
  const clean: RefusalObservations = {
    refusal:
      "refused: item needs-a-missing-tool requires `no-such-tool-9f3a`, not resolvable on PATH. On codex this term is UNMEASURED — nobody has measured it. Remedy: measure it or drop it. verify command `bnu-x tset` does not resolve",
    code: 4,
    missingTool: "no-such-tool-9f3a",
    misspelledCommand: "bnu-x tset",
    appeared: [],
    clones: [],
    committedCommandRan: false,
    hostileScriptWorks: true,
  };

  test("passes on a refusal that names the term, the agent and the remedy", () => {
    expect(names(judgeRefusal(clean))).toEqual([]);
  });

  test("fails when a clone was created before the refusal", () => {
    expect(names(judgeRefusal({ ...clean, appeared: ["r1/item-1/.git/HEAD"], clones: ["r1/item-1/.git/HEAD"] }))).toContain(
      "zero clones and zero processes were created",
    );
  });

  test("fails when a committed verify command ran (ruling 37)", () => {
    expect(names(judgeRefusal({ ...clean, committedCommandRan: true }))).toContain(
      "a verify command from a COMMITTED file was not executed (ruling 37)",
    );
  });

  test("fails when the hostile script was inert, so its canary proves nothing", () => {
    expect(names(judgeRefusal({ ...clean, hostileScriptWorks: false }))).toContain(
      "the hostile committed command WOULD have written its canary if run",
    );
  });

  test("fails on v1's arithmetic refusal (ruling 53)", () => {
    expect(
      names(judgeRefusal({ ...clean, refusal: "ROUTING_FAILED — 11 model(s) were eliminated. no-such-tool-9f3a bnu-x tset" })),
    ).toContain("the refusal is a remedy, not arithmetic (ruling 53)");
  });

  test("fails when the refusal does not distinguish unmeasured from unable", () => {
    expect(
      names(judgeRefusal({ ...clean, refusal: "refused: no-such-tool-9f3a is unavailable; bnu-x tset does not resolve" })),
    ).toContain("the refusal is a remedy, not arithmetic (ruling 53)");
  });

  test("fails when the plan was accepted", () => {
    expect(names(judgeRefusal({ ...clean, code: 0 }))).toContain("the plan is refused");
  });
});

// ------------------------------------------------------------------ item 9

describe("item 9 — ruling 57's binary refusal", () => {
  const refusalText = "brigadier is already running: this session IS a brigadier worker.\n\nDo the work directly.";
  const clean = {
    markedCode: 3,
    markedOutput: refusalText,
    unmarkedCode: 2,
    unmarkedOutput: "unknown command: run",
    unknownWhileMarkedCode: 3,
    unknownWhileMarkedOutput: refusalText,
  };

  test("passes when the marker refuses and the unmarked call does not", () => {
    expect(names(judgeBinaryRefusal(clean))).toEqual([]);
  });

  test("fails when a marked worker is allowed to orchestrate", () => {
    expect(names(judgeBinaryRefusal({ ...clean, markedCode: 0, markedOutput: "run started" }))).toContain(
      "an orchestrating command refuses when the worker marker is set (ruling 57)",
    );
  });

  test("fails when the marker is read AFTER command dispatch", () => {
    expect(
      names(judgeBinaryRefusal({ ...clean, unknownWhileMarkedCode: 2, unknownWhileMarkedOutput: "unknown command: plan" })),
    ).toContain("the marker is read before command dispatch");
  });

  test("fails when an unmarked invocation is also refused", () => {
    expect(names(judgeBinaryRefusal({ ...clean, unmarkedOutput: refusalText }))).toContain(
      "the same command without the marker is NOT refused",
    );
  });
});

// ----------------------------------------------------------------- item 10

const APACHE = "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION ... APPENDIX: How to apply the Apache License";
/**
 * The landmarks `lgplIntegrity` requires, spread as they are in the real text.
 *
 * A title and a version string used to be enough, and that is the defect the
 * truncation test below pins: §6's obligation is the BODY.
 */
const LGPL = [
  "GNU LESSER GENERAL PUBLIC LICENSE Version 2.1, February 1999",
  "TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION",
  "...you must supply a copy of this License, and deliver the complete object files to the recipients so that they can relink...",
  "NO WARRANTY",
  "END OF TERMS AND CONDITIONS",
].join("\n");
const ATTRIBUTION = [
  "brigadier — Apache-2.0",
  "Copyright 2026",
  "",
  "  bun 1.3.14 — MIT",
  "  javascriptcore-webkit oven-sh/WebKit@5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b — LGPL-2.0-or-later",
  "  tinycc oven-sh/tinycc@12882eee073cfe5c7621bcfadf679e1372d4537b — LGPL-2.1-or-later",
  "",
].join("\n");
const INSTALL_OUTPUT = [
  "brigadier installed.",
  "~/.agents/skills/brigadier/",
  "  discovery auto-discovered with no manifest — MEASURED on Codex, opencode, Gemini CLI, Copilot and Cursor.",
  "    Qwen is a MEASURED counterexample, so this is a broad convention and NOT a universal one.",
  "    ChatGPT is a permanent blank: a hosted surface has no filesystem.",
  "~/.claude/skills/brigadier/",
].join("\n");
const POISON_PATH = "/scratch/home/.claude/hooks.json";
/**
 * The sha256 the fixture's harness "computed" from the bytes it timed, and the
 * `BUILD-ID` line a truthful artifact prints about itself. They agree here; the
 * negative controls below break exactly one of them at a time.
 */
const FIXTURE_SHA = "9".repeat(64);
const FIXTURE_BUILD_ID =
  `BUILD-ID commit=${"a".repeat(40)} tree=clean bun=1.3.14 ` +
  `bun-revision=0d9b296af33f2b851fcbf4df3e9ec89751734ba4 binary-sha256=${FIXTURE_SHA} binary-bytes=62914560`;
const TRUTHFUL_ARTIFACT: ArtifactObservations = {
  licences: { code: 0, stdout: ATTRIBUTION, stderr: "" },
  full: {
    code: 0,
    stdout: [
      APACHE,
      LGPL,
      "relink: git clone https://github.com/oven-sh/WebKit pinned to 532c8b70b9142c17e07737ab6d3da68d7500cbca",
      "git clone https://github.com/oven-sh/tinycc — tinycc corresponding source, pinned to 0123456789abcdef0123456789abcdef01234567",
    ].join("\n"),
    stderr: "",
  },
  markersFound: [],
  sizeBytes: 60 * 1_048_576,
  versionProbe: { code: 0, stdout: `${FIXTURE_BUILD_ID}\n\nbrigadier 0.0.0\n`, stderr: "" },
  binarySha256: FIXTURE_SHA,
  warmMs: 8,
  spawnFloorMs: 1,
  nodeless: { code: 0, stdout: ATTRIBUTION, stderr: "" },
  nodelessPathRemoved: ["/nvm/bin"],
  nodeOnPath: { before: "/nvm/bin/node", after: "" },
  installProbe: INSTALL_OUTPUT,
  installedPaths: [
    ".agents/skills/brigadier/SKILL.md",
    ".claude/skills/brigadier/SKILL.md",
    ".claude/skills/brigadier/hooks/hooks.json",
  ],
  homeBeforeInstall: [],
  homeAfterUninstall: [],
  uninstall: { code: 0, stdout: "brigadier uninstalled", stderr: "" },
  emptyDirsLeft: [".agents/skills"],
  hooksProbe: "hooks: PreCompact",
  installedHookFile: { path: ".claude/skills/brigadier/hooks/hooks.json", events: ["PreCompact"] },
  hostDetails: {
    available: true,
    command: "claude plugin details brigadier",
    code: 0,
    output: "Component inventory\n  Hooks (1)  PreCompact\n",
  },
  poisonedHooksProbe:
    `POISONED ${POISON_PATH} — UNRECOGNISED EVENT(S): notARealEvent-abc123. ` +
    "One unrecognised event DISCARDS EVERY HOOK IN THIS FILE",
  poisonedHooksCode: 1,
  poisonKey: "notARealEvent-abc123",
  poisonedPath: POISON_PATH,
};

describe("item 10 — the artifact ships, and says what is in it", () => {
  test("passes on an artifact that discharges every obligation", () => {
    expect(names(judgeArtifact(TRUTHFUL_ARTIFACT))).toEqual([]);
  });

  test("fails when the LGPL text is absent (ruling 72)", () => {
    const checks = judgeArtifact({
      ...TRUTHFUL_ARTIFACT,
      full: { ...TRUTHFUL_ARTIFACT.full, stdout: TRUTHFUL_ARTIFACT.full.stdout.replace(LGPL, "") },
    });
    expect(names(checks)).toContain("`--full` carries the LGPL text itself (ruling 72)");
  });

  test("a TITLE without the body is not the LGPL text (ruling 72)", () => {
    // The check this replaces matched a title and any one of three version
    // strings, so the two lines below would have passed it — against §6, whose
    // whole content is the obligation to supply the body.
    const headerOnly = "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1, February 1999\nThis library is free software";
    const checks = judgeArtifact({
      ...TRUTHFUL_ARTIFACT,
      full: { ...TRUTHFUL_ARTIFACT.full, stdout: TRUTHFUL_ARTIFACT.full.stdout.replace(LGPL, headerOnly) },
    });
    expect(names(checks)).toContain("`--full` carries the LGPL text itself (ruling 72)");
    expect(lgplIntegrity(headerOnly).missing).toContain("§6's relink sentence");
    expect(lgplIntegrity(LGPL).missing).toEqual([]);
  });

  test("fails when the attribution drops a statically linked component", () => {
    const withoutTinycc = ATTRIBUTION.split("\n").filter((l) => !/tinycc/i.test(l)).join("\n");
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, licences: { code: 0, stdout: withoutTinycc, stderr: "" }, nodeless: { code: 0, stdout: withoutTinycc, stderr: "" } })),
    ).toContain("attribution names every component `bun --compile` puts in the binary regardless");
  });

  test("fails when the relink recipe is a citation rather than commands", () => {
    const citation = TRUTHFUL_ARTIFACT.full.stdout.replace(/git clone /g, "see ");
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, full: { ...TRUTHFUL_ARTIFACT.full, stdout: citation } }))).toContain(
      "the relink recipe is present, as commands rather than a citation",
    );
  });

  test("fails when the binary carries a proprietary marker (ruling 47)", () => {
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, markersFound: ["© Anthropic PBC. All rights reserved."] }))).toContain(
      "the binary carries no proprietary marker",
    );
  });

  test("the size budget is in bytes, and both readings are printed", () => {
    const under = judgeArtifact({ ...TRUTHFUL_ARTIFACT, sizeBytes: 63_479_138 });
    const sizeRow = under.rows.find((r) => r.name.includes("63 MiB budget"));
    expect(sizeRow?.ok).toBe(true);
    expect(sizeRow?.detail).toContain("60.54 MiB");
    expect(sizeRow?.detail).toContain("63.48 MB decimal");
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, sizeBytes: 70 * 1_048_576 }))).toContain(
      "binary within the 63 MiB budget of 66060288 bytes",
    );
  });

  test("a warm figure outside the withdrawn 10 ms clause does not fail the item", () => {
    // OBSOLETED BY THE OWNER'S RULING OF 2026-08-20 AND INVERTED ON PURPOSE,
    // rather than deleted. Until that date this test was
    // "fails when warm start is over budget, net of the harness's own spawn
    // cost" and required 14 ms raw / 13 ms net to produce a failing
    // `warm start within 10 ms` row. The owner withdrew that clause in the
    // open, exactly as the ≤70 ms cold-start clause was withdrawn on
    // 2026-08-19. So the same over-budget figure must now gate NOTHING — and
    // the concern the old test carried does not simply evaporate with it. Two
    // halves of it are still live and are asserted below: the spawn-floor
    // correction the old name pointed at ("net of the harness's own spawn
    // cost") still has to be applied and printed, and the withdrawal that
    // removed the gate still has to be visible in the same run.
    const checks = judgeArtifact({ ...TRUTHFUL_ARTIFACT, warmMs: 14, spawnFloorMs: 1 });
    expect(names(checks)).toEqual([]);
    expect(names(checks).some((n) => n.startsWith("warm start within"))).toBe(false);
    const warm = checks.rows.find((r) => r.name.startsWith("warm start is MEASURED"));
    expect(warm?.ok).toBe(true);
    expect(warm?.detail).toContain("14 ms raw − 1 ms spawn floor = 13 ms");
    expect(warm?.detail).toContain("NO THRESHOLD IS APPLIED");
    // The strike is legible in the very run that stopped gating, and it is not
    // itself a check that can fail. `bar/item10-identity.test.ts` drives this
    // in both directions against its own fixture; this is the guard local to
    // the fixture the rest of this file uses.
    const struck = checks.rows.find((r) => r.name.startsWith("STRUCK CLAUSE — this item asserts no warm-start budget"));
    expect(struck?.detail).toBe(struckWarmLine());
    expect(struck?.detail).toContain("WITHDRAWN by the owner");
    expect(names(checks)).not.toContain(struck?.name);
  });

  test("the headroom the withdrawn warm clause was argued over is KEPT in the record", () => {
    // MIS-KEYED, AND SILENTLY SO. This was "the warm budget is reachable by the
    // runtime ruling 5 mandates" and asserted that no `warm start within 10 ms`
    // row FAILED for a 7.76 ms figure. On 2026-08-20 that became vacuous rather
    // than false: no row starts with that prefix any more, so the assertion
    // passed for free and covered nothing. Repaired, not deleted, because the
    // evidence it was really about is still in the item on purpose — a strike
    // must not take out of the record the thing that was argued over — and
    // nothing else in this suite asserts that note survives.
    //
    // MEASURED against `bun --compile` on 2026-08-17 (the bun version of that
    // day is not recorded, and is not reconstructed here): a binary whose whole
    // program is `process.exit(0)` starts in 7.76 ms min-of-40 raw, about
    // 6.5 ms floor-corrected. That answered a verifier who held the clause was
    // only satisfiable by something ruling 5 forbids the product to be.
    const checks = judgeArtifact({ ...TRUTHFUL_ARTIFACT, warmMs: 7.76, spawnFloorMs: 1.21 });
    const headroom = checks.rows.find((r) => r.name.startsWith("the headroom measurement the withdrawn clause was argued over"));
    expect(headroom?.detail).toContain("7.76 ms");
    expect(headroom?.detail).toContain("ruling 5 does not permit the product to be");
    expect(names(checks)).not.toContain(headroom?.name);
    // And a figure well INSIDE the withdrawn number gates exactly as little as
    // the 14 ms one above: the clause is struck, not relaxed in either direction.
    expect(names(checks).some((n) => n.startsWith("warm start within"))).toBe(false);
  });

  test("fails when the binary will not start without node (ruling 4)", () => {
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, nodeless: { code: 1, stdout: "", stderr: "node: not found" } })),
    ).toContain("runs with node absent from PATH (ruling 4)");
  });

  test("blocks when there was no node to strip, instead of passing for free", () => {
    // `after === ""` is satisfied for free on a machine with no node at all, so
    // the strip reads green having removed nothing.
    const checks = judgeArtifact({ ...TRUTHFUL_ARTIFACT, nodeOnPath: { before: "", after: "" } });
    expect(names(checks)).toContain(NODE_STRIP_NOT_RUN);
    expect(NODE_STRIP_NOT_RUN.startsWith("NOT-RUN —")).toBe(true);
    expect(names(checks)).not.toContain("node is genuinely unreachable on the stripped PATH");
  });

  test("fails when the PATH strip did not actually remove node", () => {
    // The check that matters is not "did we run the binary" but "was node
    // really gone". A strip verified with the predicate that did the stripping
    // agrees with itself for free, so the shell's own answer is the subject.
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, nodeOnPath: { before: "/nvm/bin/node", after: "/usr/bin/node" } })),
    ).toContain("node is genuinely unreachable on the stripped PATH");
  });

  test("fails when the nodeless run silently prints something different", () => {
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, nodeless: { code: 0, stdout: "brigadier — Apache-2.0\n", stderr: "" } })),
    ).toContain("and produces the SAME output it produces with node present");
  });

  test("fails when install does not reach ruling 42's real discovery path", () => {
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, installedPaths: [] }))).toContain(
      "install reaches ruling 42's cross-vendor discovery path, named",
    );
  });

  test("fails when install reaches only the cross-vendor root (ruling 42)", () => {
    // MEASURED: Claude Code does not discover ~/.agents/skills/ at all, so one
    // root is one host's discovery path, not "each host's".
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, installedPaths: [".agents/skills/brigadier/SKILL.md"] })),
    ).toContain("and Claude Code's own root, which does not see the cross-vendor one (ruling 42)");
  });

  test("fails when install implies six uniform clients", () => {
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, installProbe: "installed to ~/.agents/skills/brigadier — every client finds it" })),
    ).toContain("install does not imply six uniform clients — ChatGPT is named as a permanent blank");
  });

  test("fails when uninstall leaves brigadier's own files behind (ruling 26)", () => {
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, homeAfterUninstall: [".claude/skills/brigadier/SKILL.md"] })),
    ).toContain("`uninstall` removes every file install wrote, and nothing else (ruling 26)");
  });

  test("fails when uninstall destroys something of the operator's", () => {
    expect(
      names(
        judgeArtifact({
          ...TRUTHFUL_ARTIFACT,
          homeBeforeInstall: [".claude/settings.json"],
          homeAfterUninstall: [],
        }),
      ),
    ).toContain("`uninstall` removes every file install wrote, and nothing else (ruling 26)");
  });

  test("fails when install puts a bin/ on PATH (ruling 42)", () => {
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, installedPaths: [".agents/skills/brigadier/SKILL.md", ".local/bin/brigadier"] })),
    ).toContain("install puts no `bin/` on PATH outside Claude Code (ruling 42)");
  });

  test("fails when the hook surface does not name PreCompact (ruling 60)", () => {
    // A count-based check passes here; ruling 60 exists because `.lsp.json` was
    // measured reporting `LSP servers (1)` for `{"notARealKey": 1}`.
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, hooksProbe: "hooks (1)" }))).toContain(
      "brigadier's own printed hook surface names `PreCompact`",
    );
  });

  test("fails when install wrote no hook file, however the binary describes itself", () => {
    // The defect this pins: `brigadier plugin hooks` is a compiled-in string, so
    // the self-report above still names PreCompact while nothing was written.
    const checks = judgeArtifact({ ...TRUTHFUL_ARTIFACT, installedHookFile: { events: [] } });
    expect(names(checks)).toContain("install wrote a hooks.json that NAMES `PreCompact` (ruling 60)");
    expect(names(checks)).not.toContain("brigadier's own printed hook surface names `PreCompact`");
  });

  test("fails when the installed hook file names some other event", () => {
    expect(
      names(
        judgeArtifact({
          ...TRUTHFUL_ARTIFACT,
          installedHookFile: { path: ".claude/skills/brigadier/hooks/hooks.json", events: ["SessionStart"] },
        }),
      ),
    ).toContain("install wrote a hooks.json that NAMES `PreCompact` (ruling 60)");
  });

  test("fails when the hook file is written outside a directory brigadier owns (ruling 8)", () => {
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, installedHookFile: { path: ".claude/hooks/hooks.json", events: ["PreCompact"] } })),
    ).toContain("the hook file is inside a directory brigadier owns (rulings 8, 27)");
  });

  test("fails when the HOST does not name PreCompact — and says so when it was not asked", () => {
    const silent = judgeArtifact({
      ...TRUTHFUL_ARTIFACT,
      hostDetails: { ...TRUTHFUL_ARTIFACT.hostDetails, output: "Component inventory\n  Hooks (0)\n" },
    });
    expect(names(silent)).toContain("the HOST names `PreCompact` after install (ruling 60, BAR.md's own instrument)");

    // With no `claude` on the machine the host view BLOCKS. It was a note, and a
    // note renders `ok`: item 10 printed PASS on a CI leg where `BAR.md`'s named
    // instrument never executed, and the test here asserted that as correct.
    // Ruling 48 — a check that did not run is not a check that passed — and
    // `claude` installs on all three runners, so this is a missing dependency
    // rather than a platform impossibility.
    const unasked = judgeArtifact({
      ...TRUTHFUL_ARTIFACT,
      hostDetails: { available: false, command: "claude plugin details brigadier", code: null, output: "" },
    });
    expect(names(unasked)).toContain(HOST_NOT_RUN);
    expect(HOST_NOT_RUN.startsWith("NOT-RUN —")).toBe(true);
    // And it does not take the file half down with it: what install wrote is
    // still proven, and only "the host loads it" is not.
    expect(names(unasked)).not.toContain("install wrote a hooks.json that NAMES `PreCompact` (ruling 60)");
  });

  test("fails when a poisoned hooks.json is silently discarded (ruling 60)", () => {
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, poisonedHooksProbe: "hooks: PreCompact" }))).toContain(
      "a hooks.json carrying one unrecognised event is REPORTED, not silently discarded (ruling 60)",
    );
  });

  test("fails when the poisoned file is reported without naming the file", () => {
    expect(
      names(
        judgeArtifact({
          ...TRUTHFUL_ARTIFACT,
          poisonedHooksProbe: "an unrecognised event notARealEvent-abc123 discards every hook in the file",
        }),
      ),
    ).toContain("a hooks.json carrying one unrecognised event is REPORTED, not silently discarded (ruling 60)");
  });

  test("fails when the poisoned file is reported and the check still exits 0", () => {
    // Exactly what the host does: prints nothing, exits 0, discards the file.
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, poisonedHooksCode: 0 }))).toContain(
      "and the poisoned file makes the check EXIT NON-ZERO",
    );
  });

  test("the struck cold-start clause is PRINTED, and gates nothing", () => {
    // `BAR.md`'s closing rule: an item is struck only in the open. The strike
    // must appear in the output of a PASSING run, it must not be a check that
    // can fail, and no cold-start budget may survive anywhere in the item.
    const checks = judgeArtifact(TRUTHFUL_ARTIFACT);
    const struck = checks.rows.find((r) => r.name.startsWith("STRUCK CLAUSE"));
    expect(struck).toBeDefined();
    expect(struck?.ok).toBe(true);
    expect(struck?.detail).toContain("WITHDRAWN by the owner");
    expect(struck?.detail).toContain("MEASUREMENT-SESSION.md:140");
    expect(struck?.detail).toContain("873 ms");
    expect(struck?.detail).toContain("892 ms");
    expect(struck?.detail).toContain("11.3 ms/MB");
    expect(struck?.detail).toBe(struckLine());
    expect(checks.rows.map((r) => r.name)).toContain("what the struck clause leaves unproven (note)");

    // `ok: true` above is the HAZARD, not the promise: a note gates nothing, so
    // it can only ever be `ok: true`, and until 2026-08-19 it also PRINTED with
    // the same `ok` leader as a genuine passing assertion. This row is one of
    // the legitimate cases — a strike `BAR.md` requires be printed, which was
    // never an assertion — but item 10 also shipped a BLOCKING condition as a
    // note once (see `HOST_NOT_RUN` above). So what this test now pins is that
    // the reader can TELL: the row is un-gated, and it says so in its leader.
    // `bar/lib/checks.test.ts` is the control for the mechanism.
    expect(checks.failures.map((r) => r.name)).not.toContain(struck?.name);
    const struckLineOut = checks
      .render()
      .split("\n")
      .find((l) => l.includes("STRUCK CLAUSE"));
    expect(struckLineOut?.startsWith("note ")).toBe(true);
    expect(struckLineOut?.startsWith("ok")).toBe(false);

    // No surviving cold-start gate, under any wording. The ` (note)` suffix is
    // still the filter, and it is still what `note()` writes.
    const gates = checks.rows.filter((r) => !r.name.endsWith("(note)")).map((r) => r.name.toLowerCase());
    expect(gates.filter((n) => n.includes("cold"))).toEqual([]);
    expect(gates.filter((n) => n.includes("never-executed"))).toEqual([]);
  });

  test("the §17 warm proposal is recorded as a proposal, not as a budget", () => {
    const checks = judgeArtifact({ ...TRUTHFUL_ARTIFACT, warmMs: 17, spawnFloorMs: 1 });
    // 16 ms net is inside §17's PROPOSED 20 ms and outside the 10 ms clause
    // that was in force until 2026-08-20. NEITHER decides anything now, and
    // that is the whole assertion: the 10 ms clause was withdrawn by the owner
    // and §17's 20 ms was NOT adopted in its place, because a clause struck for
    // want of provenance is not repaired by installing a second figure picked
    // to clear the last reading. So the first assertion here — which until
    // 2026-08-20 required this figure to FAIL a `warm start within 10 ms` row —
    // is replaced by its opposite: no threshold of either size came back.
    expect(names(checks).some((n) => n.startsWith("warm start within"))).toBe(false);
    expect(names(checks)).toEqual([]);
    expect(checks.rows.find((r) => r.name.startsWith("warm start is MEASURED"))?.ok).toBe(true);
    const proposal = checks.rows.find((r) => r.name.startsWith("PROPOSAL, not adopted"));
    expect(proposal?.ok).toBe(true);
    expect(proposal?.detail).toContain("has NOT adopted");
  });

  test("the quiet-machine warm figure is recorded, and its own arithmetic agrees", () => {
    // The record has to be internally consistent, or a later edit to one field
    // leaves a number that reads authoritative and is not.
    const q = QUIET_WARM_MEASUREMENT;
    expect(Math.round((q.rawMinMs - q.spawnFloorMs) * 100) / 100).toBe(q.correctedMs);
    // `marginOverBudgetMs` is HISTORY since 2026-08-20, not a verdict: it is how
    // far this figure stood from the ≤10 ms clause on the day that clause was
    // still in force. It is kept re-derivable, and keyed off the withdrawn
    // number by name rather than a bare literal, so that "the strike did not
    // erase what it struck" stays checkable.
    expect(Math.round((q.correctedMs - WITHDRAWN_WARM_BUDGET_MS) * 100) / 100).toBe(q.marginOverBudgetMs);

    // And it reaches the row a reader actually sees, with the distribution that
    // makes the minimum trustworthy rather than merely conservative. MIS-KEYED
    // ON 2026-08-20 AND REPAIRED, NOT DELETED: the row is still there and still
    // carries all of this, it is simply no longer named for a budget. The one
    // half that WAS obsoleted is `MARGIN:`, which the item now deliberately does
    // not print because there is nothing left to state a margin against — so
    // that assertion is inverted rather than dropped, and it is now the guard
    // against a threshold creeping back in beside the figure.
    const warm = judgeArtifact(TRUTHFUL_ARTIFACT).rows.find((r) => r.name.startsWith("warm start is MEASURED"));
    expect(warm?.detail).toContain("METHOD:");
    expect(warm?.detail).not.toContain("MARGIN:");
    expect(warm?.detail).toContain("13.99 ms");
    expect(warm?.detail).toContain("median 15.67");
    // The 2026-08-17 series must stay labelled as an EARLIER artifact: reading
    // it as this binary's warm cost produced a wrong correction once already.
    expect(warm?.detail).toContain("EARLIER artifact");
  });

  test("three warm figures against three artifacts are not reported as a trend", () => {
    const history = judgeArtifact(TRUTHFUL_ARTIFACT).rows.find((r) => r.name.startsWith("the warm figure has been recorded three times"));
    expect(history?.ok).toBe(true);
    expect(history?.detail).toContain("11.29 ms");
    expect(history?.detail).toContain("16.13 ms");
    expect(history?.detail).toContain("NOT established");
  });

  test("hook events are read in both shapes, and a broken file is not read as empty", () => {
    expect(hookEventsIn('{"hooks":{"PreCompact":[]}}').events).toEqual(["PreCompact"]);
    expect(hookEventsIn('{"PreCompact":[]}').events).toEqual(["PreCompact"]);
    expect(hookEventsIn("{not json").problem).toContain("malformed JSON");
    expect(hookEventsIn("[]").problem).toContain("not an object");
  });

  test("empty directories are found from the same listing the removal check uses", () => {
    const home = scratch("item10-dirs");
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(home, ".claude", "skills", "other"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "other", "SKILL.md"), "kept");
    expect(emptyDirectories(home, [".claude/skills/other/SKILL.md"])).toEqual([".agents"]);
  });

  test("a pin belonging to some other component is not a pin", () => {
    const tigerbeetleOnly =
      "| Tigerbeetle IO (https://github.com/tigerbeetle/tigerbeetle/blob/532c8b70b9142c17e07737ab6d3da68d7500cbca/x.zig) | Apache 2.0 |\n| tinycc | LGPL v2.1 |";
    expect(pinNear(tigerbeetleOnly, "webkit")).toBeUndefined();
    expect(pinNear(tigerbeetleOnly, "tinycc")).toBeUndefined();
    expect(pinNear("WebKit pinned to 532c8b70b9142c17e07737ab6d3da68d7500cbca", "webkit")).toBe(
      "532c8b70b9142c17e07737ab6d3da68d7500cbca",
    );
  });

  test("the marker scan finds a planted marker in both encodings", () => {
    expect(scanForMarkers(Buffer.from("nothing here", "utf8"))).toEqual([]);
    expect(scanForMarkers(Buffer.from("...© Anthropic PBC. All rights reserved....", "utf8"))).toHaveLength(1);
    expect(scanForMarkers(Buffer.from("...ANTHROPIC_BEDROCK_MANTLE_BASE_URL...", "latin1"))).toHaveLength(1);
  });
});

// ----------------------------------------------------------------- item 11

describe("item 11 — the report fits the window and never hides a failure", () => {
  const clean: ReportObservations = {
    hostReport:
      "run r1: fifty-4 FAILED — tests_pass. fifty-18 FAILED — tests_pass. fifty-43 FAILED — tests_pass. 47 passing item(s) collapsed to this count. run-record: /runs/r1/record.json",
    fullRecordPath: "/runs/r1/record.json",
    fullRecordExists: true,
    transcriptBytes: 6_400,
    transcriptMentions: 3,
    failingCount: 3,
  };

  test("passes on a compact report that names every failure", () => {
    expect(names(judgeReport(clean))).toEqual([]);
  });

  // "every failing item still appears", "every blocking check appears" and
  // "passing items collapsed" moved OUT of `judgeReport` in the 2026-08-19
  // audit and are tested in `lib/item11-structure.test.ts`. They were three
  // substring tests that could not fail: `includes("fifty-4")` is satisfied by
  // `fifty-43`, `includes("verify")` by the tail sentence "the merged result
  // was verified", and `/collapsed/i` by the word itself.

  test("fails when a worker transcript reached the host session", () => {
    const checks = judgeReport({ ...clean, hostReport: `${clean.hostReport}\n{"jsonrpc":"2.0","method":"session/update"}` });
    expect(names(checks)).toContain("no worker transcript appears in the host report");
  });

  test("fails when the report blows the 2,000-token ceiling", () => {
    const checks = judgeReport({ ...clean, hostReport: `${clean.hostReport}${"x".repeat(10_000)}` });
    expect(names(checks)).toContain("a fifty-item run reports under 2000 tokens");
  });

  test("fails when the named full record is not actually on disk", () => {
    expect(names(judgeReport({ ...clean, fullRecordExists: false }))).toContain(
      "the report names the full record, and the file is really there",
    );
  });

  test("fails when the `full record` is no bigger than the summary", () => {
    expect(names(judgeReport({ ...clean, transcriptBytes: 10 }))).toContain(
      "the full record on disk is substantially larger than the report",
    );
  });

  test("fails when the `full record` is large but is filler", () => {
    // A forger's full record was 60 KB of one repeated line. Bigger is not the
    // property; being about this run is.
    expect(names(judgeReport({ ...clean, transcriptMentions: 0 }))).toContain(
      "the full record on disk is about THIS run, not filler",
    );
  });

  test("the estimate applies #23's measured +22% correction rather than the naive formula", () => {
    expect(estimateTokens("x".repeat(4_000))).toBe(1_220);
  });
});

// ----------------------------------------------------------------- item 12

describe("item 12 — a granted secret does not reach a persisted artifact", () => {
  test("passes when nothing holds the secret and something was actually scanned", () => {
    expect(names(judgeSecret({ secret: "abc", leaks: [], literalLeaks: [], inClone: [], artefactsScanned: 7, deliveryProved: true, deliveryDetail: "hash matched" }))).toEqual([]);
  });

  test("fails when the scan examined nothing — the first draft's hardcoded empty list", () => {
    expect(names(judgeSecret({ secret: "abc", leaks: [], literalLeaks: [], inClone: [], artefactsScanned: 0, deliveryProved: true, deliveryDetail: "hash matched" }))).toContain(
      "the scan examined something",
    );
  });

  test("fails on an escaped-form leak that v1's assertion would have passed", () => {
    const checks = judgeSecret({
      secret: "abc",
      leaks: [{ file: "record.json", encoding: "json-escaped" }],
      literalLeaks: [],
      inClone: [],
      artefactsScanned: 7,
      deliveryProved: true,
      deliveryDetail: "hash matched",
    });
    expect(names(checks)).toContain("no persisted artifact holds the secret in ANY enumerated encoding");
  });

  test("fails when the secret reached the tree every clone came from (ruling 50)", () => {
    const checks = judgeSecret({
      secret: "abc",
      leaks: [],
      literalLeaks: [],
      inClone: [{ file: "tree:.env", encoding: "file" }],
      artefactsScanned: 7,
      deliveryProved: true,
      deliveryDetail: "hash matched",
    });
    expect(names(checks)).toContain("the secret is not in the tree every clone came from (ruling 50)");
  });

  test("fails when the secret was never DELIVERED — a critic deleted the sink and it still passed", () => {
    const checks = judgeSecret({
      secret: "abc",
      leaks: [],
      literalLeaks: [],
      inClone: [],
      artefactsScanned: 7,
      deliveryProved: false,
      deliveryDetail: "the worker's proof file held NOTHING",
    });
    expect(names(checks)).toContain("the granted secret really reached the worker (ruling 65's channel)");
  });

  test("the four encodings are genuinely different needles", () => {
    expect(new Set(encodings('a"b/c+d').map((e) => e.value)).size).toBe(4);
  });

  test("the scan finds an escaped-form leak the literal scan misses", () => {
    const dir = scratch("secret");
    const secret = 'a"b';
    writeFileSync(join(dir, "record.json"), JSON.stringify({ note: `value is ${secret}` }));
    const all = scanForSecret(dir, secret);
    expect(all.map((l) => l.encoding)).toContain("json-escaped");
    expect(all.filter((l) => l.encoding === "literal")).toEqual([]);
  });
});

// ----------------------------------------------------------------- item 13

describe("item 13 — the cost model predicts, enforces, and says what it could not see", () => {
  const record: RunRecord = {
    runId: "r1",
    integrationRef: "refs/heads/brigadier/r1",
    base: { ref: "refs/brigadier/r1/base", sha: "b".repeat(40) },
    runRoot: "/home/me/.brigadier/runs/r1",
    bindingFilter: "the plan had 4 item(s)",
    workers: 4,
    refusedDelegations: 0,
    cost: {
      currency: "USD",
      estimateLow: 0.4,
      estimateHigh: 1.9,
      provenance: "#44 measured 15×",
      actual: 0.14,
      softCeiling: 0.06,
      hardCeiling: 0.14,
      softCeilingHit: true,
      hardCeilingHit: true,
      quota: { codex: "read" },
      levers: ["prompt cache (measured at 16.5× elsewhere; this run claims nothing)"],
      lowerBound: false,
    },
    items: [
      { id: "cheap", number: 1, status: "integrated", agent: "codex", model: "codex-m", effort: "medium", attempts: 1, commit: "1".repeat(40) },
      { id: "declared-hard", number: 2, status: "integrated", agent: "codex", model: "codex-m", effort: "medium", difficulty: "hard", clampedTo: "medium", commit: "2".repeat(40) },
      { id: "third", number: 3, status: "unrun" },
      { id: "fourth", number: 4, status: "cancelled" },
    ],
  };
  /** What `gatherRunEvidence` learned by putting the record's shas to `git`. */
  const commitsOf = (
    entries: ReadonlyArray<[string, string]>,
  ): Map<string, { sha: string | undefined; type: string | undefined; reachable: boolean }> =>
    new Map(entries.map(([id, sha]) => [id, { sha, type: "commit", reachable: true }]));

  const cappedCommits = commitsOf([
    ["cheap", "1".repeat(40)],
    ["declared-hard", "2".repeat(40)],
  ]);
  const capped = verifyIntegration({ record, itemCommits: cappedCommits, refSha: "a".repeat(40) });
  const uncappedRecord: RunRecord = {
    ...record,
    items: record.items.map((i, index) => ({ ...i, status: "integrated" as const, commit: `${index + 1}`.repeat(40) })),
  };
  const uncapped = verifyIntegration({
    record: uncappedRecord,
    itemCommits: commitsOf(uncappedRecord.items.map((i) => [i.id, i.commit as string])),
    refSha: "a".repeat(40),
  });
  const clean: CostObservations = {
    report:
      "estimate 0.40 – 1.90 USD\nactual 0.14 USD against predicted 0.40 – 1.90\nceilings — soft reached: no new items dispatched, hard reached: work in flight cancelled\ndeclared-hard: difficulty: hard (clamped to medium)\nquota — codex: read\nlevers active: prompt cache",
    record,
    integrated: capped,
    uncappedIntegrated: uncapped,
    plannedCount: 4,
  };

  test("passes on a report that ranges, clamps down, enforces and prices honestly", () => {
    expect(names(judgeCost(clean))).toEqual([]);
  });

  test("integration is counted from the record and then CONFIRMED against git", () => {
    // Two integrated, one unrun, one cancelled. The product's integration
    // commits read `brigadier: integrate item <n> of run <id>` and never
    // `<id>: integrated`, so counting subjects read ZERO here and made the
    // ceiling check fail for a reason that had nothing to do with ceilings —
    // hiding the real gap, which is `cost.actual` never being assigned.
    expect(capped).toEqual({ claimed: 2, verified: 2, detail: expect.any(String) });
    expect(verifyIntegration({ record: undefined, itemCommits: new Map(), refSha: undefined }).claimed).toBe(0);
  });

  test("a record claiming integration that git cannot confirm is claimed-but-unverified", () => {
    // The forger's exact shape: every item pointed at the SAME tip commit, and
    // no ordinal. Real objects, real refs, one chain, no work.
    const forged: RunRecord = {
      ...record,
      items: record.items.map(({ number: _n, ...rest }) => ({ ...rest, status: "integrated" as const, commit: "9".repeat(40) })),
    };
    const claim = verifyIntegration({
      record: forged,
      itemCommits: commitsOf(forged.items.map((i) => [i.id, "9".repeat(40)])),
      refSha: "a".repeat(40),
    });
    expect(claim.claimed).toBe(4);
    expect(claim.verified).toBe(0);
    expect(names(judgeCost({ ...clean, record: forged, integrated: claim, uncappedIntegrated: claim }))).toContain(
      "every item the record calls `integrated` has its OWN commit on the deliverable branch",
    );
  });

  test("a commit the deliverable branch cannot reach is not an integration", () => {
    const unreachable = new Map(cappedCommits);
    unreachable.set("cheap", { sha: "1".repeat(40), type: "commit", reachable: false });
    expect(verifyIntegration({ record, itemCommits: unreachable, refSha: "a".repeat(40) }).verified).toBe(1);
  });

  test("a clamp that did not happen still has to be printed, in the form the record states", () => {
    // An earlier version demanded the word "clamped" unconditionally, so a run
    // that correctly clamped nothing failed a ruling-67 check it satisfied.
    const unclamped: RunRecord = {
      ...record,
      items: record.items.map((i) => (i.id === "declared-hard" ? { ...i, difficulty: "medium", clampedTo: "medium" } : i)),
    };
    const printed = clean.report.replace("difficulty: hard (clamped to medium)", "difficulty: medium");
    expect(names(judgeCost({ ...clean, record: unclamped, report: printed }))).toEqual([]);
    // And it still fails when that line is absent altogether.
    expect(
      names(judgeCost({ ...clean, record: unclamped, report: clean.report.replace("difficulty: hard (clamped to medium)", "") })),
    ).toContain("the difficulty clamp is recorded per item and printed (ruling 67)");
  });

  test("fails when the ceiling only printed and every item still ran", () => {
    expect(names(judgeCost({ ...clean, integrated: uncapped }))).toContain(
      "the same plan without ceilings integrates MORE — so the ceiling is the cause (ruling 66)",
    );
  });

  test("fails when the binary simply does less, with or without a ceiling", () => {
    // Two of four either way: the shortfall is the binary, not the ceiling.
    expect(names(judgeCost({ ...clean, uncappedIntegrated: capped }))).toContain(
      "the same plan without ceilings integrates MORE — so the ceiling is the cause (ruling 66)",
    );
  });

  test("fails when a clamp goes UPWARD (ruling 67)", () => {
    const upward: RunRecord = {
      ...record,
      items: record.items.map((i) => (i.id === "declared-hard" ? { ...i, difficulty: "easy", clampedTo: "hard" } : i)),
    };
    const checks = judgeCost({
      ...clean,
      record: upward,
      report: clean.report.replace("hard (clamped to medium)", "easy (clamped to hard)"),
    });
    expect(names(checks)).toContain("brigadier never clamps UPWARD");
  });

  test("fails when no clamp is recorded at all", () => {
    const noClamp: RunRecord = { ...record, items: record.items.map(({ difficulty: _d, clampedTo: _c, ...rest }) => rest) };
    expect(names(judgeCost({ ...clean, record: noClamp }))).toContain(
      "the difficulty clamp is recorded per item and printed (ruling 67)",
    );
  });

  test("fails when the clamp is recorded but never printed", () => {
    expect(names(judgeCost({ ...clean, report: clean.report.replace("difficulty: hard (clamped to medium)", "") }))).toContain(
      "the difficulty clamp is recorded per item and printed (ruling 67)",
    );
  });

  test("fails when a vendor that ran has no quota entry", () => {
    const noQuota: RunRecord = { ...record, cost: { ...(record.cost as NonNullable<RunRecord["cost"]>), quota: {} } };
    expect(names(judgeCost({ ...clean, record: noQuota }))).toContain(
      "quota is reported for every vendor that actually ran, as read / unreadable / unpriceable",
    );
  });

  // "a run using opencode says `unpriceable`" left `judgeCost` in the
  // 2026-08-19 audit. It was `!used.includes("opencode") || …`, and item 13
  // planted a fleet of qwen and copilot — so it was true by construction on
  // every run the item had ever driven, and it stays true whenever the router
  // picks no opencode. The replacement keys on the vendors the HARNESS planted
  // and is tested in `lib/item13-cost.test.ts`.

  test("fails on a token-reduction claim (ruling 70)", () => {
    expect(names(judgeCost({ ...clean, report: `${clean.report}\nthis run saved 16.5× on tokens` }))).toContain(
      "no token-reduction claim is made (ruling 70)",
    );
  });

  test("ruling 70's own required phrasing is not itself a violation", () => {
    // The first version of this check failed the honest fixture on exactly the
    // sentence ruling 70 asks for. A check that rejects the wording it exists to
    // require is broken, not strict.
    expect(savingsClaims("levers active: prompt cache (measured at 16.5× elsewhere; this run makes no claim to have saved anything)")).toEqual([]);
    expect(savingsClaims("the 16.5× cache lever was active — that cannot be read as a saving on this run")).toEqual([]);
    expect(savingsClaims("this run saved 16.5×")).toHaveLength(1);
    expect(savingsClaims("savings of 40% on tokens")).toHaveLength(1);
    // Line-scoped, so a disclaimer somewhere else in the report does not launder
    // a claim made on its own line.
    expect(savingsClaims("this run saved 16.5×\nwe make no claim about anything")).toHaveLength(1);
  });

  test("the clamp direction predicate is right in both directions", () => {
    expect(isUpwardClamp("hard", "medium")).toBe(false);
    expect(isUpwardClamp("easy", "hard")).toBe(true);
  });
});

/**
 * "Unbuilt" and "it ran and failed" are different findings.
 *
 * MEASURED on this host on 2026-08-18: item 6 read a `run --review` that exited
 * 1 as "the artifact does not implement this yet". The exit was a cascade from a
 * fixture that never committed, and the label sent the reader to build something
 * that was already there. A harness that infers "unbuilt" from a non-zero exit
 * will keep doing that, so recognition is now decided separately from success.
 */
describe("probeFeature separates recognition from success", () => {
  const ctxWith = (result: { stdout: string; stderr: string; code: number | null }): Parameters<typeof probeFeature>[0] =>
    ({
      run: async () => ({ ...result, signal: null, ms: 1 }),
    }) as unknown as Parameters<typeof probeFeature>[0];

  test("a subcommand that RAN and exited non-zero is recognised, not missing", async () => {
    const probe = await probeFeature(ctxWith({ stdout: "admitted — 1 item(s)\nreview failed", stderr: "", code: 1 }), ["run", "--review"]);
    expect(probe.recognised).toBe(true);
    // It still did not do what the caller needs, and that stays true.
    expect(probe.present).toBe(false);
  });

  test("NEGATIVE CONTROL: a subcommand the binary rejects is NOT recognised", async () => {
    const probe = await probeFeature(ctxWith({ stdout: "", stderr: "unknown command: review", code: 2 }), ["run", "--review"]);
    expect(probe.recognised).toBe(false);
    expect(probe.present).toBe(false);
  });

  test("NEGATIVE CONTROL: a binary that only prints its usage is NOT recognised", async () => {
    const usage = "brigadier — an ACP hub\n\n  brigadier detect\n  brigadier agents\n  brigadier licenses\n";
    const probe = await probeFeature(ctxWith({ stdout: usage, stderr: "", code: 0 }), ["run", "--review"]);
    expect(probe.recognised).toBe(false);
    expect(probe.present).toBe(false);
  });

  test("a subcommand that ran and succeeded is both", async () => {
    const probe = await probeFeature(ctxWith({ stdout: "admitted — 1 item(s) in 1 wave(s)", stderr: "", code: 0 }), ["run", "--dry-run"]);
    expect(probe.recognised).toBe(true);
    expect(probe.present).toBe(true);
  });
});
