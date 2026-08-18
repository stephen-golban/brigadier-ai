// SPDX-License-Identifier: Apache-2.0
/**
 * `brigadier run`, driven as a process against a planted ACP agent.
 *
 * This is the only kind of test that can show the composition is REACHED.
 * `driftFor`, `laneFailureBlocks` and `overrideWarning` were a complete,
 * on-spec implementation of ruling 69 with zero call sites outside their own
 * module, and every unit test passed the whole time; the same is true of every
 * module this file composes. So nothing here imports a predicate from `src/` to
 * decide whether the run worked — the assertions are `git` output, files on
 * disk, and the bytes the binary printed.
 *
 * The agent is planted rather than mocked, for the same reason `bar/` plants
 * one: the product discovers agents by resolving a name on `PATH`, and a mock
 * injected past that would be testing a code path the product does not have.
 *
 * WHAT THIS FILE DOES NOT PROVE. The planted agent is a script, so nothing here
 * says anything about a real vendor's permission payloads, its sandbox, or
 * whether it obeys a brief. That is `BAR.md`'s live half and it needs
 * credentials. What this proves is the ORDER: base state, clone, marker,
 * record, integration, gate, report — and that a refusal reaches none of it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/**
 * An ACP agent that does the work described in its brief.
 *
 * The brief's `prompt` carries a tiny instruction language rather than prose,
 * so the positive control is deterministic instead of a language-model coin
 * toss. It commits, because ruling 56 keeps brigadier's count of git commands
 * inside a clone an agent has touched at zero and `integrateWave` fetches the
 * clone's `work` branch — an uncommitted change is not part of a result.
 *
 * `nocommit` in the brief makes it write the file and STOP THERE, which is the
 * negative control for exactly that sentence: the worker really did the work,
 * the bytes really are in the clone, and none of it is on the branch brigadier
 * fetches. Real vendors reach this state routinely, and the run used to report
 * it as two items integrated and exit 0.
 */
const AGENT_SOURCE = `
import { existsSync } from "node:fs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let nl = buffer.indexOf("\\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\\n");
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined || msg.method === undefined) continue;
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "planted", version: "0.21.13" }, agentCapabilities: {} } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", models: { availableModels: [{ modelId: "fake-1[low]" }, { modelId: "fake-1[medium]" }, { modelId: "fake-1[high]" }, { modelId: "fake-1[max]" }] } } });
    } else if (msg.method === "session/set_model") {
      process.stderr.write("SET_MODEL " + String(msg.params?.modelId) + "\\n");
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "session/prompt") {
      const brief = String(msg.params?.prompt?.[0]?.text ?? "");
      const one = (re) => re.exec(brief)?.[1];
      const id = one(/^id: (\\S+)$/m) ?? "unknown";
      const say = one(/say=(\\S+)/);
      const leak = one(/leak=(\\S+)/);
      if (say !== undefined || leak !== undefined) {
        const text = [say, leak === undefined ? undefined : process.env[leak]].filter(Boolean).join(" | ");
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      }
      const read = one(/read=(\\S+)/);
      const probe = one(/probe=(\\S+)/);
      const out = one(/out=(\\S+)/);
      let body = "";
      if (read !== undefined) body = (await Bun.file(read).text()).trim();
      if (probe !== undefined) body = existsSync(probe) ? "PRESENT" : "ABSENT";
      if (out !== undefined) {
        await Bun.write(out, id + ":" + body + "\\n");
        if (!/nocommit/.test(brief)) {
          Bun.spawnSync(["git", "add", "-A"], { cwd: process.cwd() });
          Bun.spawnSync(["git", "-c", "user.name=p", "-c", "user.email=p@e.invalid", "commit", "-q", "-m", "work " + id], { cwd: process.cwd() });
        }
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not implemented" } });
    }
  }
}
`;

/**
 * Ruling 61 refuses a run root inside a temp region, so the scratch tree lives
 * under `$HOME`. That is the product's rule applied to its own test rather than
 * worked around, and #41 is why: the Codex bridge builds its sandbox with the
 * temp roots writable BY DESIGN.
 */
const ROOT = mkdtempSync(join(homedir(), ".brigadier-queue-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

function makeWorld(name: string): { dir: string; repo: string; runs: string; bin: string } {
  const dir = join(ROOT, name);
  const repo = join(dir, "repo");
  const runs = join(dir, "runs");
  const bin = join(dir, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(runs, { recursive: true });
  mkdirSync(bin, { recursive: true });

  git(repo, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "base"]);

  const agent = join(dir, "agent.ts");
  writeFileSync(agent, AGENT_SOURCE);
  const script = join(bin, "qwen");
  writeFileSync(script, `#!/bin/sh\nexec ${process.execPath} ${agent} "$@"\n`);
  chmodSync(script, 0o755);
  return { dir, repo, runs, bin };
}

function brigadier(world: { bin: string }, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: {
      HOME: ROOT,
      USER: process.env["USER"] ?? "test",
      PATH: `${world.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NO_COLOR: "1",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function writePlan(dir: string, items: unknown[], name = "plan.json"): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ version: 1, items }, null, 2));
  return path;
}

// ---------------------------------------------------------------- the run

describe("a two-wave run, end to end", () => {
  const world = makeWorld("full");

  // Ruling 33 repairs ruling 7 by carrying the operator's uncommitted TRACKED
  // and UNTRACKED work into every clone; ruling 50 keeps gitignored content out
  // of the base commit entirely. All three placements are planted, because a
  // repository whose seeds were all committed would never notice a product that
  // dropped either.
  writeFileSync(join(world.repo, "tracked.seed"), "PLACEHOLDER-AT-HEAD\n");
  writeFileSync(join(world.repo, ".gitignore"), "hidden.seed\n");
  git(world.repo, ["add", "-A"]);
  git(world.repo, ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "seeds"]);
  writeFileSync(join(world.repo, "tracked.seed"), "tracked-value\n");
  writeFileSync(join(world.repo, "untracked.seed"), "untracked-value\n");
  writeFileSync(join(world.repo, "hidden.seed"), "hidden-value\n");

  const planPath = writePlan(world.dir, [
    { id: "tracked", kind: "write", paths: ["tracked.txt"], prompt: "read=tracked.seed out=tracked.txt" },
    { id: "untracked", kind: "write", paths: ["untracked.txt"], prompt: "read=untracked.seed out=untracked.txt" },
    { id: "ignored", kind: "write", paths: ["ignored.txt"], prompt: "probe=hidden.seed out=ignored.txt" },
    {
      id: "second",
      kind: "write",
      paths: ["second.txt"],
      dependsOn: ["tracked"],
      prompt: "read=tracked.txt out=second.txt",
    },
  ]);

  const before = git(world.repo, ["status", "--porcelain", "-uall"]);
  const beforeHead = git(world.repo, ["rev-parse", "HEAD"]);
  const result = brigadier(world, [
    "run",
    "--plan",
    planPath,
    "--repo",
    world.repo,
    "--run-root",
    world.runs,
    "--audience",
    "terminal",
  ]);
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const branch = `refs/heads/brigadier/${runId}`;
  const blob = (path: string) => git(world.repo, ["cat-file", "blob", `${branch}:${path}`]);

  test("the run completes and reports success", () => {
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    // Asserted on the FACT rather than on the headline's wording: this file
    // does not own `src/integrate/report.ts`, and a test that pins another
    // module's prose breaks on an improvement to it.
    expect(result.stdout).toContain("4 of 4 items landed");
  });

  test("the integration branch is real: fsck-clean, with one commit per item", () => {
    expect(git(world.repo, ["fsck", "--no-progress", "--connectivity-only", "--strict"])).toBe("");
    const subjects = git(world.repo, ["log", "--format=%s", branch]);
    for (const id of [1, 2, 3, 4]) expect(subjects).toContain(`integrate item ${id} of run ${runId}`);
  });

  test("ruling 33: the operator's uncommitted TRACKED work reached the clone", () => {
    // A clone of HEAD alone yields PLACEHOLDER-AT-HEAD, which is the exact
    // mechanism ruling 7 lost.
    expect(blob("tracked.txt")).toBe("tracked:tracked-value");
  });

  test("ruling 33: the operator's UNTRACKED work reached the clone", () => {
    expect(blob("untracked.txt")).toBe("untracked:untracked-value");
  });

  test("NEGATIVE CONTROL: ruling 50 — gitignored content did NOT", () => {
    // The control that keeps the two above from passing for the wrong reason: a
    // product that swept the whole working tree in would satisfy them and fail
    // this one.
    expect(blob("ignored.txt")).toBe("ignored:ABSENT");
  });

  test("ruling 54: wave 2 cloned from wave 1's integration commit, and saw its output", () => {
    // `second` read `tracked.txt`, which existed nowhere until wave 1 merged.
    expect(blob("second.txt")).toBe("second:tracked:tracked-value");
  });

  test("ruling 38: every spawned process carried the marker in its COMMAND LINE", () => {
    const ndjson = readFileSync(join(world.runs, "r", runId, "record.ndjson"), "utf8");
    const spawned = ndjson
      .split("\n")
      .filter((line) => line.includes('"process-spawned"'))
      .map((line) => JSON.parse(line) as { commandLine: string; item: number });
    expect(spawned).toHaveLength(4);
    for (const entry of spawned) {
      expect(entry.commandLine).toContain(`--brigadier-run=${runId}/${entry.item}`);
    }
  });

  test("NEGATIVE CONTROL: the marker is a COMMAND-LINE token, not an environment one", () => {
    // Ruling 38/57: an environment variable is invisible to a sweep reading
    // `ps`. If the marker were only in the environment this assertion would
    // pass while the one above failed, so both are needed.
    const ndjson = readFileSync(join(world.runs, "r", runId, "record.ndjson"), "utf8");
    expect(ndjson).not.toContain("BRIGADIER_WORKER=");
  });

  test("ruling 58: the full record is on disk and the report carries only a pointer", () => {
    const recordPath = join(world.runs, "r", runId, "record.json");
    expect(result.stdout).toContain(`run-record: ${recordPath}`);
    expect(existsSync(recordPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as { items: unknown[]; integrationRef: string };
    expect(parsed.items).toHaveLength(4);
    expect(parsed.integrationRef).toBe(branch);
    expect(result.stdout).not.toContain('"jsonrpc"');
  });

  test("the clones are gone once their work is in the operator's repository (ruling 63)", () => {
    for (const item of [1, 2, 3, 4]) expect(existsSync(join(world.runs, "r", runId, String(item)))).toBe(false);
  });

  test("the operator's repository was not disturbed (rulings 50, 51)", () => {
    expect(git(world.repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(world.repo, ["status", "--porcelain", "-uall"])).toBe(before);
  });
});

// ------------------------------------------------------------- the refusal

describe("a refused plan creates nothing (ruling 53)", () => {
  const world = makeWorld("refused");
  const planPath = writePlan(world.dir, [
    { id: "one", kind: "write", paths: ["shared.txt"], prompt: "out=shared.txt" },
    { id: "two", kind: "write", paths: ["shared.txt"], prompt: "out=shared.txt" },
  ]);

  const before = readdirSync(world.runs);
  const result = brigadier(world, ["run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs]);

  test("it exits non-zero and names the path that collides", () => {
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("shared.txt");
  });

  test("zero clones: nothing appeared under the run root", () => {
    expect(readdirSync(world.runs)).toEqual(before);
  });

  test("zero refs: the operator's repository is untouched", () => {
    expect(git(world.repo, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
  });

  test("NEGATIVE CONTROL: the same two items on disjoint paths DO create a run root", () => {
    // Without this, "nothing appeared" would also be satisfied by a binary that
    // never creates anything at all.
    const ok = writePlan(
      world.dir,
      [
        { id: "one", kind: "write", paths: ["one.txt"], prompt: "out=one.txt" },
        { id: "two", kind: "write", paths: ["two.txt"], prompt: "out=two.txt" },
      ],
      "ok.json",
    );
    const good = brigadier(world, ["run", "--plan", ok, "--repo", world.repo, "--run-root", world.runs]);
    expect(good.code).toBe(0);
    expect(readdirSync(world.runs)).toContain("r");
  });
});

// -------------------------------------------------------------- the effort

describe("ruling 29's third axis is recorded, and says what it IS", () => {
  const world = makeWorld("effort");

  // Ruling 69's per-machine override, which is the only way to point a BRIDGED
  // profile at something this test can plant: rulings 4 and 44 launch Codex
  // through `npx`, so a binary called `codex` on PATH is not Codex's ACP bridge
  // and brigadier is right not to treat it as one.
  const configHome = join(world.dir, "config");
  mkdirSync(join(configHome, "brigadier"), { recursive: true });
  writeFileSync(
    join(configHome, "brigadier", "bridges.json"),
    JSON.stringify([{ agent: "codex", command: join(world.bin, "qwen"), args: [] }]),
  );

  const planPath = writePlan(world.dir, [
    { id: "graded", kind: "write", paths: ["g.txt"], prompt: "out=g.txt", difficulty: "hard" },
  ]);
  // `--max-difficulty hard` so the declared `hard` survives ruling 67's clamp
  // and the derivation has somewhere to go. The paired control below runs the
  // same plan WITHOUT it, where the difficulty clamp cascades into the effort.
  const result = brigadier(
    world,
    [
      "run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs,
      "--max-difficulty", "hard", "--audience", "terminal",
    ],
    { XDG_CONFIG_HOME: configHome },
  );
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const parsed = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as {
    items: Array<{
      agent?: string;
      model?: string;
      effort?: string;
      effortRequested?: string;
      effortLever?: string;
      effortDisposition?: string;
      effortConfirmed?: boolean;
    }>;
  };
  const item = parsed.items[0];

  test("the run completed on the overridden bridge", () => {
    expect(result.code).toBe(0);
    expect(item?.agent).toBe("codex");
  });

  test("ruling 29: the triple is complete — agent, model AND effort", () => {
    expect(item?.agent).toBeDefined();
    expect(item?.model).toBeDefined();
    expect(item?.effort).toBeDefined();
  });

  test("ruling 31: effort is derived from (kind, difficulty), and `hard` derives `high`", () => {
    expect(item?.effortRequested).toBe("high");
  });

  test("ruling 40: it was asserted on the GRADED lever, with an id the agent listed", () => {
    expect(item?.effortLever).toBe("session/set_model");
    expect(item?.effortDisposition).toBe("accepted");
    expect(item?.effort).toContain("fake-1[high]");
    const transcript = readFileSync(join(world.runs, "r", runId, "transcripts", "full.log"), "utf8");
    expect(transcript).toContain("session/set_model");
    expect(transcript).toContain("fake-1[high]");
  });

  test("NEGATIVE CONTROL: ruling 67's clamp CASCADES — a clamped difficulty buys a cheaper effort", () => {
    // The same plan without `--max-difficulty hard`: `hard` clamps to `medium`,
    // and effort follows the difficulty ACTUALLY IN FORCE rather than the one
    // the plan asked for. Deriving from the declared value would spend at the
    // level brigadier had just said it was not spending at.
    const clamped = makeWorld("effort-clamped");
    mkdirSync(join(clamped.dir, "config", "brigadier"), { recursive: true });
    writeFileSync(
      join(clamped.dir, "config", "brigadier", "bridges.json"),
      JSON.stringify([{ agent: "codex", command: join(clamped.bin, "qwen"), args: [] }]),
    );
    const plan = writePlan(clamped.dir, [
      { id: "graded", kind: "write", paths: ["g.txt"], prompt: "out=g.txt", difficulty: "hard" },
    ]);
    const ran = brigadier(
      clamped,
      ["run", "--plan", plan, "--repo", clamped.repo, "--run-root", clamped.runs, "--audience", "terminal"],
      { XDG_CONFIG_HOME: join(clamped.dir, "config") },
    );
    expect(ran.code).toBe(0);
    const id = readdirSync(join(clamped.runs, "r"))[0] ?? "";
    const record = JSON.parse(readFileSync(join(clamped.runs, "r", id, "record.json"), "utf8")) as {
      items: Array<{ difficulty?: string; clampedTo?: string; effortRequested?: string; effort?: string }>;
    };
    expect(record.items[0]?.difficulty).toBe("hard");
    expect(record.items[0]?.clampedTo).toBe("medium");
    expect(record.items[0]?.effortRequested).toBe("medium");
    expect(record.items[0]?.effort).toContain("fake-1[medium]");
  });

  test("NEGATIVE CONTROL: ruling 30 — the `[max]` id the agent offered was never chosen", () => {
    // The agent listed one. Nothing filtered it out at the wire; it is simply
    // not a value brigadier can request.
    const transcript = readFileSync(join(world.runs, "r", runId, "transcripts", "full.log"), "utf8");
    expect(transcript).toContain("fake-1[max]");
    const sent = transcript.split("\n").filter((line) => line.includes("session/set_model"));
    expect(sent.every((line) => !line.includes("[max]"))).toBe(true);
  });

  test("#45: nothing claims the effort was confirmed", () => {
    expect(item?.effortConfirmed).toBe(false);
    expect(item?.effort).toContain("NOT confirmed");
    expect(result.stdout).toContain("NOT confirmed");
  });

  test("NEGATIVE CONTROL: a vendor with no measured lever asserts NOTHING and says so", () => {
    // Without this, "effort was set" would also be satisfied by a build that
    // printed a grade for every vendor whether or not it had a lever to set it
    // on — which is the shape #45 warns about.
    const plain = makeWorld("effort-nolever");
    const plainPlan = writePlan(plain.dir, [
      { id: "bare", kind: "write", paths: ["b.txt"], prompt: "out=b.txt", difficulty: "hard" },
    ]);
    const ran = brigadier(plain, [
      "run", "--plan", plainPlan, "--repo", plain.repo, "--run-root", plain.runs, "--audience", "terminal",
    ]);
    expect(ran.code).toBe(0);
    const id = readdirSync(join(plain.runs, "r"))[0] ?? "";
    const record = JSON.parse(readFileSync(join(plain.runs, "r", id, "record.json"), "utf8")) as {
      items: Array<{ agent?: string; effortLever?: string; effortDisposition?: string; effort?: string }>;
    };
    expect(record.items[0]?.agent).toBe("qwen");
    expect(record.items[0]?.effortLever).toBe("none measured");
    expect(record.items[0]?.effortDisposition).toBe("no-lever");
    expect(record.items[0]?.effort).toContain("not asserted");
    const transcript = readFileSync(join(plain.runs, "r", id, "transcripts", "full.log"), "utf8");
    expect(transcript).not.toContain("session/set_model");
  });
});

// -------------------------------------------------------------- the review

describe("ruling 32: a reviewer that produces no verdict never renders as a pass", () => {
  const world = makeWorld("review");
  const planPath = writePlan(world.dir, [
    { id: "reviewed", kind: "write", paths: ["r.txt"], prompt: "out=r.txt" },
  ]);
  const result = brigadier(world, [
    "run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--review", "--audience", "terminal",
  ]);
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const parsed = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as {
    review?: { crossVendor: boolean; sameVendorReason?: string };
    items: Array<{
      reviewerAttempts?: number;
      attempts?: number;
      checks: Array<{ name: string; outcome: string; blocking: boolean }>;
    }>;
  };

  test("this agent answers a review brief with prose, and prose is not a verdict", () => {
    // The planted agent knows nothing about reviewing: it reads `out=` out of
    // the brief, finds none, and stops with `end_turn`. #14 measured that
    // `end_turn` does NOT mean the task was done, so a run that read the stop
    // reason as approval would approve every diff any agent shrugged at.
    const review = parsed.items[0]?.checks.find((check) => check.name === "review");
    expect(review?.outcome).toBe("error");
    expect(review?.blocking).toBe(true);
    expect(result.code).toBe(1);
  });

  test("ruling 52: the re-run is charged to brigadier, not to the item's ladder", () => {
    expect(parsed.items[0]?.reviewerAttempts).toBe(2);
    expect(parsed.items[0]?.attempts).toBe(1);
  });

  test("ruling 32: with one vendor on PATH the record says SAME-VENDOR, and why", () => {
    // The failure this guards is a FIELD rather than a sentence: writing
    // `crossVendor: true` because two vendors resolved would be ruling 32
    // broken silently.
    expect(parsed.review?.crossVendor).toBe(false);
    expect(parsed.review?.sameVendorReason).toContain("only qwen is drivable");
  });

  test("NEGATIVE CONTROL: without --review there is no review check and the run succeeds", () => {
    // Without this, "review blocks" would also be satisfied by a binary that
    // blocks on everything.
    const plain = writePlan(world.dir, [{ id: "plain", kind: "write", paths: ["p.txt"], prompt: "out=p.txt" }], "plain.json");
    const ok = brigadier(world, [
      "run", "--plan", plain, "--repo", world.repo, "--run-root", join(world.dir, "runs2"), "--audience", "terminal",
    ]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).not.toContain("review:");
  });
});

// -------------------------------------------------------------- the secret

describe("ruling 65: one sink, after composition, every encoding", () => {
  const world = makeWorld("secret");
  // Full of characters the encodings disagree about, so `literal` and
  // `json-escaped` are genuinely different needles.
  const secret = 'sk-live-"a\\b"/c+d=';
  const decoy = 'decoy-"a\\b"/c+d=';
  const planPath = writePlan(world.dir, [
    { id: "leaker", kind: "write", paths: ["out.txt"], prompt: `say=${decoy} leak=BAR_SECRET out=out.txt` },
  ]);
  const result = brigadier(
    world,
    ["run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--secret-env", "BAR_SECRET", "--audience", "terminal"],
    { BAR_SECRET: secret },
  );
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const transcript = readFileSync(join(world.runs, "r", runId, "transcripts", "full.log"), "utf8");

  const encodings = (value: string) => [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
  ];

  test("the run completed, so there was something to redact", () => {
    expect(result.code).toBe(0);
    expect(transcript.length).toBeGreaterThan(0);
  });

  test("NEGATIVE CONTROL: the transcript really does hold JSON-ESCAPED agent text", () => {
    // Without this, "the secret's escaped form is absent" would be satisfied by
    // a transcript that holds no escaped text at all — which is exactly v1's
    // assertion passing on a file that still contained the secret.
    expect(transcript).toContain(JSON.stringify(decoy).slice(1, -1));
    expect(transcript).not.toContain(decoy);
  });

  test("no encoding of the granted secret survives in the transcript", () => {
    for (const form of encodings(secret)) expect(transcript).not.toContain(form);
    expect(transcript).toContain("[redacted]");
  });

  test("no encoding survives in the run record or on stdout either", () => {
    const json = readFileSync(join(world.runs, "r", runId, "record.json"), "utf8");
    const ndjson = readFileSync(join(world.runs, "r", runId, "record.ndjson"), "utf8");
    for (const form of encodings(secret)) {
      expect(json).not.toContain(form);
      expect(ndjson).not.toContain(form);
      expect(result.stdout).not.toContain(form);
    }
  });

  test("NEGATIVE CONTROL: a value that was NOT granted is not redacted", () => {
    // A sink that redacted everything would pass every assertion above and
    // destroy diagnostics. The standing rule: an inventoried value is a secret;
    // nothing else is.
    expect(transcript).toContain("decoy");
  });
});

/**
 * The hole `MINIMUM_SECRET_LENGTH` cuts, said out loud rather than left to be
 * discovered.
 *
 * A granted value under 8 characters IS delivered to the worker and is NOT
 * inventoried, so nothing redacts it out of anything. The floor stays —
 * redacting every occurrence of a three-character string destroys far more than
 * it protects — but an operator who granted a short value is owed the sentence,
 * and a product that silently half-honours `--secret-env` is worse than one that
 * refuses.
 */
describe("ruling 65: a grant that is too short to inventory is REPORTED", () => {
  const world = makeWorld("short-secret");
  const short = "abc";
  const planPath = writePlan(world.dir, [
    { id: "leaker", kind: "write", paths: ["out.txt"], prompt: "leak=BAR_SHORT out=out.txt" },
  ]);
  const result = brigadier(
    world,
    ["run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--secret-env", "BAR_SHORT", "--secret-env", "BAR_ABSENT", "--audience", "terminal"],
    { BAR_SHORT: short },
  );

  test("the operator is told, by NAME, on stderr", () => {
    expect(result.stderr).toContain("BAR_SHORT");
    expect(result.stderr).toContain("NOT redacted from anything");
    expect(result.stderr).toContain("shorter than 8 characters");
  });

  test("a name that is unset is reported too, and separately", () => {
    expect(result.stderr).toContain("BAR_ABSENT");
    expect(result.stderr).toContain("unset or empty in this environment");
  });

  test("and the warning is TRUE: the short value really does reach the transcript", () => {
    // The whole point of the sentence. If this ever stops being true the
    // sentence has become a lie, which is worse than either behaviour alone.
    const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
    const transcript = readFileSync(join(world.runs, "r", runId, "transcripts", "full.log"), "utf8");
    expect(transcript).toContain(short);
  });

  test("NEGATIVE CONTROL: a grant long enough to inventory produces no warning", () => {
    const quiet = makeWorld("long-secret");
    const plan = writePlan(quiet.dir, [
      { id: "leaker", kind: "write", paths: ["out.txt"], prompt: "leak=BAR_LONG out=out.txt" },
    ]);
    const ran = brigadier(
      quiet,
      ["run", "--plan", plan, "--repo", quiet.repo, "--run-root", quiet.runs, "--secret-env", "BAR_LONG", "--audience", "terminal"],
      { BAR_LONG: "long-enough-to-inventory" },
    );
    expect(ran.stderr).not.toContain("NOT redacted from anything");
    const id = readdirSync(join(quiet.runs, "r"))[0] ?? "";
    const transcript = readFileSync(join(quiet.runs, "r", id, "transcripts", "full.log"), "utf8");
    expect(transcript).not.toContain("long-enough-to-inventory");
    expect(transcript).toContain("[redacted]");
  });
});

// ---------------------------------------------------------- the deliverable

/**
 * Ruling 51's deliverable, and ruling 52's rule about what may never render as
 * a pass.
 *
 * MEASURED on 2026-08-18 against `git 2.50.1`, and this is the defect the whole
 * block exists for: two planted agents wrote their files, committed neither,
 * and brigadier printed *"2 of 2 items landed"*, marked both items
 * `integrated`, named `refs/heads/brigadier/<run-id>` as "the deliverable" and
 * exited 0 — with no such branch in the repository. `integrateWave` scores an
 * item that changed no tracked file `no-change` and PASSES it, which is right
 * for a `read-only` item and the exact opposite for a `write` one.
 *
 * Every assertion below is on ESCAPED BYTES (ruling 62b): the ref as
 * `git rev-parse` resolves it, the branch list as `git branch` prints it, the
 * blob as `git cat-file` reads it back, and the record's own bytes on disk.
 * Nothing here reads a flag the code returned.
 */
describe("a `write` item that committed nothing is not a landing (rulings 51, 52)", () => {
  const world = makeWorld("nocommit");
  const planPath = writePlan(world.dir, [
    { id: "silent", kind: "write", paths: ["silent.txt"], prompt: "nocommit out=silent.txt" },
  ]);
  const result = brigadier(world, [
    "run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal",
  ]);
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const branch = `refs/heads/brigadier/${runId}`;
  const record = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as {
    integrationRef: string;
    integrationSha?: string;
    base: { ref: string; sha: string };
    runChecks?: Array<{ name: string; outcome: string; blocking: boolean }>;
    items: Array<{
      status: string;
      clonePath?: string;
      commit?: string;
      baseRef?: string;
      baseSha?: string;
      checks: Array<{ name: string; outcome: string; blocking: boolean; qualifier?: string }>;
    }>;
  };

  test("the branch does not exist — `git rev-parse` and `git branch` both say so", () => {
    const proc = Bun.spawnSync(["git", "rev-parse", "--verify", "-q", `${branch}^{commit}`], {
      cwd: world.repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stdout.toString().trim()).toBe("");
    expect(git(world.repo, ["branch", "--list", "brigadier/*"])).toBe("");
  });

  test("the run exits non-zero and the headline does not claim a landing", () => {
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("NOTHING INTEGRATED");
    expect(result.stdout).toContain("NO INTEGRATION BRANCH");
    expect(result.stdout).not.toContain("1 of 1 items landed");
  });

  test("ruling 52: the item's integration check is a BLOCKING fail, in the record's bytes", () => {
    const check = record.items[0]?.checks.find((entry) => entry.name.startsWith("integrate item"));
    expect(check?.outcome).toBe("fail");
    expect(check?.blocking).toBe(true);
    expect(check?.qualifier).toBe("nothing committed");
    expect(record.items[0]?.status).not.toBe("integrated");
    // Ruling 70: the NDJSON is the flight recorder, and it must carry the same
    // verdict — a process killed after the wave leaves this and nothing else.
    const ndjson = readFileSync(join(world.runs, "r", runId, "record.ndjson"), "utf8");
    expect(ndjson).toContain('"check-settled"');
    expect(ndjson).toContain('"integrate item 1","outcome":"fail"');
  });

  test("ruling 51: the record does not claim a sha for a branch that is not there", () => {
    expect(record.integrationRef).toBe(branch);
    expect(record.integrationSha).toBeUndefined();
    const deliverable = record.runChecks?.find((check) => check.name === "integration branch");
    expect(deliverable?.outcome).toBe("fail");
    expect(deliverable?.blocking).toBe(true);
    expect(record.items[0]?.commit).toBeUndefined();
  });

  test("ruling 63: the clone is RETAINED, and the worker's bytes are still in it", () => {
    // The old rule deleted a clone whose fetched ref merely existed, and a
    // `no-change` item has one — so the only copy of everything the worker
    // wrote and did not commit was removed. Read the file back rather than
    // trusting the report's path.
    const clonePath = record.items[0]?.clonePath;
    expect(clonePath).toBeDefined();
    expect(existsSync(clonePath as string)).toBe(true);
    expect(readFileSync(join(clonePath as string, "silent.txt"), "utf8")).toBe("silent:\n");
    expect(result.stdout).toContain(`retained clone item 1: ${clonePath}`);
  });

  test("NEGATIVE CONTROL: the SAME plan with the same agent committing does land", () => {
    // Without this, every assertion above is also satisfied by a binary that
    // refuses everything. One token of the brief is the only difference.
    const good = makeWorld("nocommit-control");
    const plan = writePlan(good.dir, [
      { id: "silent", kind: "write", paths: ["silent.txt"], prompt: "out=silent.txt" },
    ]);
    const ran = brigadier(good, [
      "run", "--plan", plan, "--repo", good.repo, "--run-root", good.runs, "--audience", "terminal",
    ]);
    expect(ran.code).toBe(0);
    const id = readdirSync(join(good.runs, "r"))[0] ?? "";
    const ref = `refs/heads/brigadier/${id}`;
    const sha = git(good.repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(good.repo, ["branch", "--list", "brigadier/*"])).toContain(`brigadier/${id}`);
    expect(git(good.repo, ["cat-file", "blob", `${ref}:silent.txt`])).toBe("silent:");
    const parsed = JSON.parse(readFileSync(join(good.runs, "r", id, "record.json"), "utf8")) as {
      integrationSha?: string;
    };
    expect(parsed.integrationSha).toBe(sha);
  });

  test("NEGATIVE CONTROL: a plan of only read-only items publishes nothing AND succeeds", () => {
    // The other side: "no branch" must not block a run that was never going to
    // produce one. Ruling 49 never reads a read-only item's directory back at
    // all, so there is nothing to merge and nothing wrong.
    const quiet = makeWorld("readonly-only");
    const plan = writePlan(quiet.dir, [{ id: "look", kind: "read-only", paths: [], prompt: "say=looked" }]);
    const ran = brigadier(quiet, [
      "run", "--plan", plan, "--repo", quiet.repo, "--run-root", quiet.runs, "--audience", "terminal",
    ]);
    expect(ran.code).toBe(0);
    expect(git(quiet.repo, ["branch", "--list", "brigadier/*"])).toBe("");
    const id = readdirSync(join(quiet.runs, "r"))[0] ?? "";
    const parsed = JSON.parse(readFileSync(join(quiet.runs, "r", id, "record.json"), "utf8")) as {
      runChecks?: Array<{ name: string; outcome: string; qualifier?: string }>;
    };
    const deliverable = parsed.runChecks?.find((check) => check.name === "integration branch");
    expect(deliverable?.outcome).toBe("pass");
    expect(deliverable?.qualifier).toBe("read-only plan");
  });
});

// ------------------------------------------------------------- the base ref

/**
 * The contract change: both records now carry the commit an item's diff is
 * taken FROM.
 *
 * `itemRef` and `commit` are the right-hand side of `git diff <base>..<ref>`,
 * and until now the left-hand side was in neither record — so the diff ruling
 * 51 makes the ownership check and ruling 52 makes the reviewer's brief could
 * not be recomputed from the evidence, only by re-running the run. The
 * assertion is that the diff really re-derives: the paths git reports are the
 * paths the item declared.
 */
describe("an item's diff is re-derivable from the record alone (rulings 51, 52)", () => {
  const world = makeWorld("basederive");
  const planPath = writePlan(world.dir, [
    { id: "first", kind: "write", paths: ["first.txt"], prompt: "out=first.txt" },
    {
      id: "next",
      kind: "write",
      paths: ["next.txt"],
      dependsOn: ["first"],
      prompt: "read=first.txt out=next.txt",
    },
  ]);
  const result = brigadier(world, [
    "run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal",
  ]);
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const record = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as {
    base: { ref: string; sha: string };
    items: Array<{ id: string; itemRef?: string; baseRef?: string; baseSha?: string }>;
  };

  test("the run landed, so there are diffs to re-derive", () => {
    expect(result.code).toBe(0);
  });

  test("`git diff <baseSha>..<itemRef>` names exactly the path each item declared", () => {
    for (const [id, path] of [["first", "first.txt"], ["next", "next.txt"]] as const) {
      const item = record.items.find((entry) => entry.id === id);
      expect(item?.baseSha).toMatch(/^[0-9a-f]{40}$/);
      const paths = git(world.repo, ["diff", "--name-only", `${item?.baseSha}..${item?.itemRef}`]);
      expect(paths.split("\n").filter(Boolean)).toEqual([path]);
    }
  });

  test("ruling 54: wave 2's base is NOT wave 1's — the bases differ, and the second resolves", () => {
    // The reason this is per item rather than per run. If a single run-level
    // base were recorded, the assertion above would silently compare wave 2's
    // work against a commit it never saw.
    const first = record.items.find((entry) => entry.id === "first");
    const next = record.items.find((entry) => entry.id === "next");
    expect(first?.baseSha).toBe(record.base.sha);
    expect(next?.baseSha).not.toBe(record.base.sha);
    expect(next?.baseRef).toBe(`refs/heads/brigadier/${runId}`);
    expect(git(world.repo, ["cat-file", "-t", next?.baseSha ?? ""])).toBe("commit");
  });

  test("the NDJSON carries the same bases, so a killed run still has them (ruling 70)", () => {
    const ndjson = readFileSync(join(world.runs, "r", runId, "record.ndjson"), "utf8");
    const bases = ndjson
      .split("\n")
      .filter((line) => line.includes('"base-recorded"'))
      .map((line) => JSON.parse(line) as { wave: number; ref: string; sha: string });
    expect(bases.map((entry) => entry.wave)).toEqual([0, 1, 2]);
    expect(bases[0]?.sha).toBe(record.base.sha);
    expect(bases[2]?.sha).toBe(record.items.find((entry) => entry.id === "next")?.baseSha);
  });

  test("NEGATIVE CONTROL: the base is a commit the item did NOT write into", () => {
    // Without this, `baseSha` could be the item's own commit and every diff
    // above would come back empty and pass.
    const first = record.items.find((entry) => entry.id === "first");
    expect(git(world.repo, ["cat-file", "blob", `${first?.baseSha}:first.txt`])).toContain("first.txt");
    expect(git(world.repo, ["cat-file", "blob", `${first?.itemRef}:first.txt`])).toBe("first:");
  });
});

// ------------------------- a SINGLE item, and a run that lands nothing

/**
 * ONE item, end to end.
 *
 * Every other run in this file has at least two, and a fan-out hides a class of
 * defect that only a plan of one can reach: a batch loop that never enters, a
 * wave that publishes only when it has something to compare against, a ceiling
 * check evaluated before anything has spent. A single-item run is the shape a
 * first-time user actually types, and the assertions are on the object store —
 * `git rev-parse` for the deliverable and `git cat-file` for the bytes.
 */
describe("a single-item run integrates, and its branch resolves", () => {
  const world = makeWorld("single");
  writeFileSync(join(world.repo, "solo.seed"), "solo-value\n");
  const planPath = writePlan(world.dir, [
    { id: "solo", kind: "write", paths: ["solo.txt"], prompt: "read=solo.seed out=solo.txt" },
  ]);
  const result = brigadier(world, [
    "run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal",
  ]);
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const branch = `refs/heads/brigadier/${runId}`;

  test("the deliverable RESOLVES, and the item's bytes are in its tree", () => {
    expect(result.code).toBe(0);
    const sha = git(world.repo, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(world.repo, ["cat-file", "blob", `${branch}:solo.txt`])).toBe("solo:solo-value");
    expect(git(world.repo, ["ls-tree", "--name-only", "-r", branch]).split("\n")).toContain("solo.txt");
  });

  test("the record's integrationSha is what `git rev-parse` answered", () => {
    const record = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as {
      integrationSha?: string;
      items: Array<{ id: string; status: string; agent?: string }>;
    };
    expect(record.integrationSha).toBe(git(world.repo, ["rev-parse", `${branch}^{commit}`]));
    expect(record.items).toHaveLength(1);
    expect(record.items[0]?.status).toBe("integrated");
    // Ruling 29's triple, from the spawn rather than from the routing choice.
    expect(record.items[0]?.agent).toBe("qwen");
  });
});

/**
 * Ruling 52's invariant at the run level, and the defect it was measured
 * failing.
 *
 * MEASURED on 2026-08-18 against `git 2.50.1`: a single-item run whose worker
 * wrote a file it had not declared was rejected WHOLE by ruling 51's ownership
 * check, and the headline read *"NOTHING INTEGRATED — 0 of 1 items landed on
 * the integration branch; 1 retained; integration branch: fail."* — a status,
 * a consequence, and no mention of the check that stopped it. A reader had to
 * find the item's own line to learn that anything had been checked at all.
 *
 * Ruling 52's whole design is that absence is impossible: every blocking check's
 * slot is written before the check runs, holding `not-run`, so a crash leaves a
 * blocking value rather than an absent field. So a run that integrates nothing
 * has a blocking check by construction, and the line an operator reads first is
 * where it has to be named.
 */
describe("a run that integrates NOTHING always names the check that blocked it", () => {
  const world = makeWorld("nothing");
  writeFileSync(join(world.repo, "own.seed"), "own-value\n");
  // Declares one path and writes another: ruling 51 rejects the item whole, and
  // this is the ordinary way a real vendor produces a run that lands nothing.
  const planPath = writePlan(world.dir, [
    { id: "wanderer", kind: "write", paths: ["declared.txt"], prompt: "read=own.seed out=undeclared.txt" },
  ]);
  const result = brigadier(world, [
    "run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal",
  ]);
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";

  test("nothing reached the tree, and the branch does not resolve", () => {
    expect(result.code).toBe(1);
    expect(git(world.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/brigadier/${runId}^{commit}`])).toBe("");
    expect(result.stdout).toContain("NOTHING INTEGRATED");
  });

  test("the HEADLINE names the blocking check, not only the item's status", () => {
    // The line before the record pointer — the first thing an operator reads,
    // and the one part of the report ruling 58's cap never trims.
    const headline = result.stdout.split("\n").find((line) => line.includes("NOTHING INTEGRATED")) ?? "";
    expect(headline).toContain("blocked by integrate item N: fail");
    expect(headline).not.toContain("NO BLOCKING CHECK WAS NAMED");
  });

  test("the check itself is on the item's line, with the checker's own words", () => {
    const record = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as {
      items: Array<{ id: string; checks: Array<{ name: string; outcome: string; blocking: boolean }> }>;
    };
    const blocking = record.items[0]?.checks.filter((check) => check.blocking) ?? [];
    expect(blocking.map((check) => check.outcome)).toContain("fail");
    expect(result.stdout).toContain("wrote outside its declared paths");
  });

  test("NEGATIVE CONTROL: the same worker with the path DECLARED integrates", () => {
    // Without this, "nothing integrated and said why" would also be satisfied by
    // a build that integrates nothing ever.
    const ok = makeWorld("nothing-control");
    writeFileSync(join(ok.repo, "own.seed"), "own-value\n");
    const okPlan = writePlan(ok.dir, [
      { id: "wanderer", kind: "write", paths: ["undeclared.txt"], prompt: "read=own.seed out=undeclared.txt" },
    ]);
    const good = brigadier(ok, [
      "run", "--plan", okPlan, "--repo", ok.repo, "--run-root", ok.runs, "--audience", "terminal",
    ]);
    const okRunId = readdirSync(join(ok.runs, "r"))[0] ?? "";
    expect(good.code).toBe(0);
    expect(good.stdout).not.toContain("NOTHING INTEGRATED");
    expect(git(ok.repo, ["cat-file", "blob", `refs/heads/brigadier/${okRunId}:undeclared.txt`])).toBe("wanderer:own-value");
  });
});
