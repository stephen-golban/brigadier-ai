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
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
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
        Bun.spawnSync(["git", "add", "-A"], { cwd: process.cwd() });
        Bun.spawnSync(["git", "-c", "user.name=p", "-c", "user.email=p@e.invalid", "commit", "-q", "-m", "work " + id], { cwd: process.cwd() });
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

// -------------------------------------------------------------- the review

describe("ruling 32: an unbuilt check never renders as a pass", () => {
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
    items: Array<{ checks: Array<{ name: string; outcome: string; blocking: boolean }> }>;
  };

  test("--review yields a BLOCKING review check, and the run cannot succeed", () => {
    const review = parsed.items[0]?.checks.find((check) => check.name === "review");
    expect(review?.outcome).toBe("not-run");
    expect(review?.blocking).toBe(true);
    expect(result.code).toBe(1);
  });

  test("the record does not claim a review that never ran", () => {
    // The failure this guards is a FIELD rather than a sentence: writing
    // `crossVendor: true` because two vendors resolved would be ruling 32
    // broken silently.
    expect(parsed.review?.crossVendor).toBe(false);
    expect(parsed.review?.sameVendorReason).toContain("not implemented in this build");
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
