// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 66's cost model: what a run spent, and the two ceilings that act on
 * it.
 *
 * THE DEFECT. `cost.actual`, `softCeilingHit` and `hardCeilingHit` existed in
 * the record type and were written nowhere. The ceilings were command-line
 * flags that reached `ExecuteOptions` and were then read by nothing at all, so
 * `--hard-ceiling` was a number an operator could set and a run that ignored
 * it. Ruling 66's own ordering is what makes that the serious half: **the
 * ceiling is the primary control and the estimate is not.** #44 measured
 * 427,723 against 28,245 bytes on two IDENTICAL Codex runs — 15× on identical
 * input — and published tooling puts real cost at 3–5× naive estimates, so no
 * prediction is load-bearing enough to be the thing that stops a run. Only a
 * number measured while the run happens is, and there was none.
 *
 * WHERE THE NUMBER COMES FROM, and the trap it avoids: bytes counted as they
 * cross the channel, never `usage_update`. The drive measured `used`
 * PLATEAUING FOR FIVE TURNS while history was rewritten — the field MASKS
 * compaction — so a ceiling driven off it reports a run's most expensive turns
 * as its cheapest and holds open at exactly the moment it should close. The
 * planted agent below emits a known volume of real ACP traffic, which is why
 * the ceilings here fire on arithmetic rather than on a fixture's say-so.
 *
 * THE TWO CEILINGS ARE TWO MECHANISMS, and every assertion keeps them apart:
 *
 *   soft   stops NEW items being dispatched; in-flight items finish
 *   hard    cancels work ALREADY RUNNING
 *
 * MEASURED against `git 2.50.1` and `bun 1.3.14` on 2026-08-18.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { itemCeilingReserve, tokensFromBytes } from "../src/queue/estimate.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/**
 * A builder that emits a KNOWN VOLUME of agent→client traffic before it
 * commits.
 *
 * The chunks come first and the commit comes last, deliberately: a worker
 * cancelled mid-turn must leave nothing on its `work` branch, so "did the
 * ceiling actually stop work" is answerable from the object store rather than
 * from a status word.
 */
const AGENT_SOURCE = `
const config = JSON.parse(await Bun.file(Bun.argv[2]).text());
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
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: config.id, version: "1.0.0" }, agentCapabilities: {} } });
    } else if (msg.method === "session/new") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1" } });
    } else if (msg.method === "session/set_mode" || msg.method === "session/set_model") {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "session/prompt") {
      const brief = String(msg.params?.prompt?.[0]?.text ?? "");
      const out = /out=(\\S+)/.exec(brief)?.[1];
      const filler = "x".repeat(config.chunkBytes);
      for (let i = 0; i < config.chunks; i++) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: filler } } } });
        await Bun.sleep(5);
      }
      if (out !== undefined) {
        await Bun.write(out, "written by " + config.id + "\\n");
        Bun.spawnSync(["git", "add", "-A"], { cwd: process.cwd() });
        Bun.spawnSync(["git", "-c", "user.name=p", "-c", "user.email=p@e.invalid", "commit", "-q", "-m", "work"], { cwd: process.cwd() });
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not implemented" } });
    }
  }
}
`;

/** 20 chunks of 5,000 bytes: ~100 KB of real traffic per item, on the wire. */
const CHUNKS = 20;
const CHUNK_BYTES = 5_000;
/** The floor for one item, from the fixture's own arithmetic rather than from a guess. */
const PER_ITEM_TOKENS = tokensFromBytes(CHUNKS * CHUNK_BYTES);

/** Ruling 61 refuses a run root inside a temp region, so the scratch tree is under `$HOME`. */
const ROOT = mkdtempSync(join(homedir(), ".brigadier-ceiling-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

interface World {
  dir: string;
  repo: string;
  runs: string;
  bin: string;
}

function makeWorld(name: string): World {
  const dir = join(ROOT, name);
  const repo = join(dir, "repo");
  const runs = join(dir, "runs");
  const bin = join(dir, "bin");
  for (const path of [repo, runs, bin]) mkdirSync(path, { recursive: true });

  git(repo, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "base"]);

  const agent = join(dir, "agent.ts");
  writeFileSync(agent, AGENT_SOURCE);
  const config = join(dir, "qwen.json");
  writeFileSync(config, JSON.stringify({ id: "qwen", chunks: CHUNKS, chunkBytes: CHUNK_BYTES }));
  const script = join(bin, "qwen");
  writeFileSync(script, `#!/bin/sh\nexec ${process.execPath} ${agent} ${config} "$@"\n`);
  chmodSync(script, 0o755);
  return { dir, repo, runs, bin };
}

function brigadier(world: World, args: string[]) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: {
      HOME: ROOT,
      USER: process.env["USER"] ?? "test",
      PATH: `${world.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

interface RecordShape {
  cost?: {
    currency: string;
    estimateLow: number;
    estimateHigh: number;
    actual?: number;
    softCeiling?: number;
    hardCeiling?: number;
    softCeilingHit?: boolean;
    hardCeilingHit?: boolean;
    quota: Record<string, string>;
    levers: string[];
    lowerBound: boolean;
  };
  items: Array<{ id: string; status: string; checks: Array<{ name: string; outcome: string; qualifier?: string }> }>;
}

function runOf(world: World): { runId: string; record: RecordShape; branch: string } {
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const record = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as RecordShape;
  return { runId, record, branch: `refs/heads/brigadier/${runId}` };
}

function planFile(world: World): string {
  const path = join(world.dir, "plan.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      items: [1, 2, 3].map((n) => ({
        id: `item${n}`,
        kind: "write",
        paths: [`item${n}.txt`],
        prompt: `out=item${n}.txt`,
      })),
    }),
  );
  return path;
}

/** Files actually in the branch's tree. The object store, not a report. */
function tree(world: World, branch: string): string[] {
  const listed = git(world.repo, ["ls-tree", "--name-only", "-r", branch]);
  return listed === "" ? [] : listed.split("\n");
}

function commits(world: World, branch: string): number {
  const count = git(world.repo, ["rev-list", "--count", branch]);
  return Number(count) || 0;
}

// ------------------------------------------------------ the control run

/**
 * The same plan, the same fixture, no ceilings. Everything below is measured
 * against this: "fewer commits than plan items" needs the number of commits a
 * run that was NOT stopped produces, or it is an assertion about nothing.
 */
const control = makeWorld("no-ceiling");
const controlResult = brigadier(control, [
  "run", "--plan", planFile(control), "--repo", control.repo, "--run-root", control.runs,
  "--workers", "1", "--audience", "terminal",
]);
const controlRun = runOf(control);
const controlCommits = commits(control, controlRun.branch);

describe("NEGATIVE CONTROL: with no ceilings, all three items land and neither ceiling fired", () => {
  test("three items in the tree, and a cost the run actually measured", () => {
    expect(controlResult.code).toBe(0);
    expect(tree(control, controlRun.branch).sort()).toEqual(["README.md", "item1.txt", "item2.txt", "item3.txt"]);
    expect(controlCommits).toBeGreaterThan(3);
    // `actual` is the field that was written nowhere. It is a measurement now,
    // and it is at least the traffic the fixture is known to have emitted.
    expect(controlRun.record.cost?.actual ?? 0).toBeGreaterThanOrEqual(3 * PER_ITEM_TOKENS);
  });

  test("neither ceiling fired, and neither line is printed", () => {
    expect(controlRun.record.cost?.softCeilingHit).toBe(false);
    expect(controlRun.record.cost?.hardCeilingHit).toBe(false);
    expect(controlResult.stdout).not.toContain("HARD CEILING FIRED");
    expect(controlResult.stdout).not.toContain("soft ceiling reached");
  });

  test("ruling 13's quota is per vendor, never absent and never optimistic", () => {
    expect(controlRun.record.cost?.quota).toEqual({ qwen: "unreadable" });
    expect(controlRun.record.cost?.lowerBound).toBe(false);
  });

  test("ruling 70: levers are named as levers, with the disclaimer in the same block", () => {
    expect((controlRun.record.cost?.levers ?? []).length).toBeGreaterThan(0);
    expect(controlResult.stdout).toContain("lever active:");
    expect(controlResult.stdout).toContain("makes no claim to have saved anything");
    // The sentence ruling 70 forbids, in the shape a reader would skim it in.
    expect(controlResult.stdout).not.toMatch(/saved\s+16\.5/);
  });
});

// --------------------------------------------- the hard ceiling stops work

describe("ruling 66: the HARD ceiling cancels work already running", () => {
  const world = makeWorld("hard");
  // Sized from the fixture: one item fits under it, the second crosses it
  // mid-turn — which is the only place a hard ceiling differs from a soft one.
  const hard = Math.floor(PER_ITEM_TOKENS * 1.45);
  const result = brigadier(world, [
    "run", "--plan", planFile(world), "--repo", world.repo, "--run-root", world.runs,
    "--workers", "1", "--hard-ceiling", String(hard), "--audience", "terminal",
  ]);
  const { record, branch } = runOf(world);

  test("FEWER COMMITS THAN PLAN ITEMS, against the control's count", () => {
    expect(commits(world, branch)).toBeLessThan(controlCommits);
    expect(tree(world, branch)).toContain("item1.txt");
    expect(tree(world, branch)).not.toContain("item2.txt");
    expect(tree(world, branch)).not.toContain("item3.txt");
    expect(result.code).toBe(1);
  });

  test("the item in flight is `cancelled`, not `failed` — brigadier stopped it", () => {
    // Different words for different remedies: `failed` sends an operator to
    // look for a defect in work that was stopped on purpose.
    expect(record.items.find((item) => item.id === "item2")?.status).toBe("cancelled");
    // And the item that was never reached says WHICH ceiling stopped it.
    const third = record.items.find((item) => item.id === "item3");
    expect(third?.status).toBe("unrun");
    expect(third?.checks[0]?.qualifier).toBe("ceiling stopped dispatch");
  });

  test("the report NAMES the ceiling that fired, and does not claim the other one", () => {
    expect(record.cost?.hardCeilingHit).toBe(true);
    expect(record.cost?.hardCeiling).toBe(hard);
    expect(result.stdout).toContain("HARD CEILING FIRED");
    expect(result.stdout).not.toContain("soft ceiling reached");
  });
});

// ------------------------- the soft ceiling stops dispatch and nothing else

describe("ruling 66: the SOFT ceiling stops NEW items and lets the in-flight one finish", () => {
  const world = makeWorld("soft");
  // Crossed part-way through the FIRST item, so "did the in-flight item
  // finish?" is a real question rather than one that never came up.
  const soft = Math.floor(PER_ITEM_TOKENS * 0.6);
  const hard = soft + itemCeilingReserve() * 2;
  const result = brigadier(world, [
    "run", "--plan", planFile(world), "--repo", world.repo, "--run-root", world.runs,
    "--workers", "1", "--soft-ceiling", String(soft), "--hard-ceiling", String(hard), "--audience", "terminal",
  ]);
  const { record, branch } = runOf(world);

  test("the in-flight item COMPLETED and its bytes are on the branch", () => {
    // This is the assertion that separates soft from hard. A soft ceiling that
    // killed the item it was in the middle of would be a hard ceiling with a
    // gentler name.
    expect(tree(world, branch)).toContain("item1.txt");
    expect(record.items.find((item) => item.id === "item1")?.status).toBe("integrated");
  });

  test("and no further item was DISPATCHED", () => {
    expect(tree(world, branch)).not.toContain("item2.txt");
    for (const id of ["item2", "item3"]) {
      const item = record.items.find((entry) => entry.id === id);
      expect(item?.status).toBe("unrun");
      expect(item?.checks[0]?.qualifier).toBe("ceiling stopped dispatch");
    }
  });

  test("the SOFT ceiling is named, and the hard one is reported as NOT hit", () => {
    expect(record.cost?.softCeilingHit).toBe(true);
    expect(record.cost?.hardCeilingHit).toBe(false);
    expect(result.stdout).toContain("soft ceiling reached");
    expect(result.stdout).not.toContain("HARD CEILING FIRED");
    expect(result.code).toBe(1);
  });
});

// ------------- the gap between them, refused before anything is created

describe("ruling 66: a gap too narrow for one in-flight item is refused BEFORE anything is spent", () => {
  const world = makeWorld("gap");
  const result = brigadier(world, [
    "run", "--plan", planFile(world), "--repo", world.repo, "--run-root", world.runs,
    "--workers", "1", "--soft-ceiling", "1000", "--hard-ceiling", "1001", "--audience", "terminal",
  ]);

  test("it names the arithmetic and the remedy, and creates nothing", () => {
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("soft ceiling stops NEW items");
    expect(result.stderr).toContain("Remedy: raise --hard-ceiling above");
    expect(result.stderr).toContain("nothing was started.");
    expect(readdirSync(world.runs)).toEqual([]);
  });

  test("NEGATIVE CONTROL: a wide enough gap is not refused", () => {
    // Without this the refusal above would also pass on a build that refuses
    // every pair of ceilings.
    const wide = makeWorld("gap-ok");
    const ok = brigadier(wide, [
      "run", "--plan", planFile(wide), "--repo", wide.repo, "--run-root", wide.runs,
      "--workers", "1", "--soft-ceiling", "1000", "--hard-ceiling", String(1000 + itemCeilingReserve() * 2),
      "--dry-run",
    ]);
    expect(ok.code).toBe(0);
    expect(ok.stderr).not.toContain("Remedy: raise --hard-ceiling above");
  });
});
