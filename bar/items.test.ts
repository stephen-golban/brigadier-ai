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
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { judgeInterrupt, type InterruptObservations } from "./items/07-interruption-leaves-nothing.ts";
import { judgeRefusal, type RefusalObservations } from "./items/08-impossible-plan-refused.ts";
import { judgeBinaryRefusal } from "./items/09-ambient-instructions-suppressed.ts";
import { judgeArtifact, pinNear, scanForMarkers, type ArtifactObservations } from "./items/10-the-artifact-ships.ts";
import { judgeReport, type ReportObservations } from "./items/11-report-fits-the-window.ts";
import { judgeSecret } from "./items/12-secret-not-persisted.ts";
import { isUpwardClamp, judgeCost, savingsClaims, type CostObservations } from "./items/13-cost-model.ts";

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
      runRoot: "/home/me/.brigadier/runs/r1",
      bindingFilter: "the plan had 1 item(s)",
      workers: 1,
      refusedDelegations: 0,
      items: [],
    },
    refSha: "a".repeat(40),
    refType: "commit",
    fsckProblems: "",
    subjects: ["alpha: integrated", "alpha: work"],
    mergeParents: [{ sha: "b".repeat(40), parents: ["c".repeat(40), "d".repeat(40)] }],
    files: new Map([["alpha.txt", "TOKEN-1\n"]]),
    refsAfter: ["refs/heads/brigadier/r1"],
  };
  const expect1 = { expected: new Map([["alpha.txt", "TOKEN-1"]]), itemIds: ["alpha"] };

  test("passes on a run that really happened", () => {
    expect(names(proofOfWork(good, expect1))).toEqual([]);
  });

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

  test("fails when the history is missing a commit per item", () => {
    const checks = proofOfWork({ ...good, subjects: [] }, expect1);
    expect(names(checks)).toContain("the integration history carries one commit per plan item");
  });

  test("ruling 61 is checked by realpath, not lexically", () => {
    // macOS resolves /tmp to /private/tmp, so a lexical check would pass here.
    expect(insideTempRoot(tmpdir())).toBeDefined();
    expect(insideTempRoot("/usr")).toBeUndefined();
    // A run directory that was never created is exactly what a fabricating
    // binary names, and `realpath` throws on it. It must still be caught.
    expect(insideTempRoot(join(tmpdir(), "never-created-9f3a", "deeper"))).toBeDefined();
    expect(resolveThroughSymlinks(join(tmpdir(), "never-created-9f3a"))).toContain("never-created-9f3a");
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
  const clean: InterruptObservations = {
    escapeePid: 4242,
    aliveBeforeSweep: true,
    aliveAfterSweep: false,
    survivedFirstInterrupt: true,
    heartbeatAtKill: 200,
    heartbeatBeforeSweep: 400,
    heartbeatAfterSweep: 420,
    heartbeatSettled: 420,
    survivingClones: [{ path: "/runs/r1/item-2", hadCommits: true, bytes: 4096 }],
    reportAfterSweep: "retained (interrupted, has committed work): /runs/r1/item-2 (4096 bytes)",
    secondInterrupt: { code: null, signal: "SIGINT" },
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
      survivingClones: [...clean.survivingClones, { path: "/runs/r1/item-3", hadCommits: false, bytes: 0 }],
    });
    expect(names(checks)).toContain("no clone WITHOUT committed work survives");
  });

  test("fails when a second interrupt invents an exit code instead of re-raising", () => {
    const checks = judgeInterrupt({ ...clean, secondInterrupt: { code: 130, signal: null } });
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
const LGPL = "GNU LESSER GENERAL PUBLIC LICENSE Version 2.1, February 1999 ... This library is free software";
const TRUTHFUL_ARTIFACT: ArtifactObservations = {
  licences: { code: 0, stdout: "brigadier — Apache-2.0\nCopyright 2026\n\n  bun 1.3.14 — MIT\n", stderr: "" },
  full: {
    code: 0,
    stdout: [
      APACHE,
      LGPL,
      "relink: clone https://github.com/oven-sh/WebKit pinned to 532c8b70b9142c17e07737ab6d3da68d7500cbca",
      "tinycc corresponding source, pinned to 0123456789abcdef0123456789abcdef01234567",
    ].join("\n"),
    stderr: "",
  },
  markersFound: [],
  sizeBytes: 60 * 1_048_576,
  coldMs: 20,
  warmMs: 8,
  spawnFloorMs: 1,
  nodeless: { code: 0, stdout: "brigadier — Apache-2.0", stderr: "" },
  nodelessPathRemoved: ["/nvm/bin"],
  installProbe: "installed to ~/.agents/skills/brigadier",
  hooksProbe: "hooks: PreCompact",
  installedPaths: [".agents/skills/brigadier/SKILL.md"],
  poisonedHooksProbe: "hooks.json carries an unrecognised event notARealEvent-abc123 — the whole file was discarded",
  poisonKey: "notARealEvent-abc123",
  freshColdMs: 40,
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

  test("fails when the binary carries a proprietary marker (ruling 47)", () => {
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, markersFound: ["© Anthropic PBC. All rights reserved."] }))).toContain(
      "the binary carries no proprietary marker",
    );
  });

  test("the size budget is in bytes, and both readings are printed", () => {
    const under = judgeArtifact({ ...TRUTHFUL_ARTIFACT, sizeBytes: 63_479_138 });
    const sizeRow = under.rows.find((r) => r.name.includes("bytes (63 MiB)"));
    expect(sizeRow?.ok).toBe(true);
    expect(sizeRow?.detail).toContain("60.54 MiB");
    expect(sizeRow?.detail).toContain("63.48 MB decimal");
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, sizeBytes: 70 * 1_048_576 }))).toContain(
      "binary within the measured budget of 66060288 bytes (63 MiB)",
    );
  });

  test("fails when warm start is over budget, net of the harness's own spawn cost", () => {
    const checks = judgeArtifact({ ...TRUTHFUL_ARTIFACT, warmMs: 14, spawnFloorMs: 1 });
    expect(names(checks).some((n) => n.startsWith("warm start within 10 ms"))).toBe(true);
  });

  test("the warm budget is reachable by the runtime ruling 5 mandates", () => {
    // MEASURED 2026-08-17: a `bun --compile` no-op is 7.76 ms min-of-40, ~6.5 ms
    // floor-corrected. A budget only satisfiable by something the product may
    // not be would be a broken check, so this pins that it is satisfiable.
    const checks = judgeArtifact({ ...TRUTHFUL_ARTIFACT, warmMs: 7.76, spawnFloorMs: 1.21 });
    expect(names(checks).some((n) => n.startsWith("warm start within 10 ms"))).toBe(false);
  });

  test("fails when the binary will not start without node (ruling 4)", () => {
    expect(
      names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, nodeless: { code: 1, stdout: "", stderr: "node: not found" } })),
    ).toContain("runs with node absent from PATH (ruling 4)");
  });

  test("fails when install does not reach ruling 42's real discovery path", () => {
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, installedPaths: [] }))).toContain(
      "install reaches ruling 42's real discovery path, named",
    );
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
      "the hook surface names `PreCompact` (ruling 60)",
    );
  });

  test("fails when a poisoned hooks.json is silently discarded (ruling 60)", () => {
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, poisonedHooksProbe: "hooks: PreCompact" }))).toContain(
      "a hooks.json carrying one unrecognised event is REPORTED, not silently discarded (ruling 60)",
    );
  });

  test("fails when a never-executed copy blows the cold-start budget", () => {
    expect(names(judgeArtifact({ ...TRUTHFUL_ARTIFACT, freshColdMs: 3_900 })).some((n) => n.includes("NEVER-EXECUTED"))).toBe(true);
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
    failingItems: ["fifty-4", "fifty-18", "fifty-43"],
    blockingChecks: ["tests_pass"],
    fullRecordPath: "/runs/r1/record.json",
    fullRecordExists: true,
    transcriptBytes: 6_400,
    transcriptMentions: 3,
    failingCount: 3,
  };

  test("passes on a compact report that names every failure", () => {
    expect(names(judgeReport(clean))).toEqual([]);
  });

  test("fails when the cap hid a failing item (ruling 52)", () => {
    const checks = judgeReport({ ...clean, hostReport: clean.hostReport.replace("fifty-43 FAILED — tests_pass. ", "") });
    expect(names(checks)).toContain("every failing item still appears under the cap (ruling 52)");
  });

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
      { id: "cheap", status: "integrated", agent: "codex", model: "codex-m", effort: "medium", attempts: 1 },
      { id: "declared-hard", status: "integrated", agent: "codex", model: "codex-m", effort: "medium", difficulty: "hard", clampedTo: "medium" },
      { id: "third", status: "unrun" },
      { id: "fourth", status: "cancelled" },
    ],
  };
  const clean: CostObservations = {
    report:
      "estimate 0.40 – 1.90 USD\nactual 0.14 USD against predicted 0.40 – 1.90\nceilings — soft reached: no new items dispatched, hard reached: work in flight cancelled\ndeclared-hard: difficulty: hard (clamped to medium)\nquota — codex: read\nlevers active: prompt cache",
    record,
    integratedCount: 2,
    uncappedIntegratedCount: 4,
    plannedCount: 4,
  };

  test("passes on a report that ranges, clamps down, enforces and prices honestly", () => {
    expect(names(judgeCost(clean))).toEqual([]);
  });

  test("fails when the ceiling only printed and every item still ran", () => {
    expect(names(judgeCost({ ...clean, integratedCount: 4 }))).toContain(
      "the same plan without ceilings integrates MORE — so the ceiling is the cause (ruling 66)",
    );
  });

  test("fails when the binary simply does less, with or without a ceiling", () => {
    // Two of four either way: the shortfall is the binary, not the ceiling.
    expect(names(judgeCost({ ...clean, uncappedIntegratedCount: 2 }))).toContain(
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

  test("fails when a run using opencode does not say `unpriceable`", () => {
    const withOpencode: RunRecord = {
      ...record,
      cost: { ...(record.cost as NonNullable<RunRecord["cost"]>), quota: { opencode: "read" }, lowerBound: false },
      items: record.items.map((i) => (i.agent ? { ...i, agent: "opencode" } : i)),
    };
    expect(names(judgeCost({ ...clean, record: withOpencode }))).toContain(
      "a run using opencode says `unpriceable` and its total is a lower bound",
    );
  });

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
