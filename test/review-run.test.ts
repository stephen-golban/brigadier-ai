// SPDX-License-Identifier: Apache-2.0
/**
 * `brigadier run --review`, driven as a process against planted ACP agents.
 *
 * MEASURED against `git 2.50.1` and `bun 1.3.14` on 2026-08-18: before this,
 * `brigadier run --review` exited 1 on every machine, one-vendor or not — the
 * flag opened a check slot, settled it `not-run`, and blocked the run. That was
 * an honest rendering of an unbuilt check and it was also a flag the usage
 * advertised and the product could not honour.
 *
 * Nothing in this file imports a predicate from `src/` to decide whether a
 * review worked. `chooseReviewer` and `parseVerdict` have their own unit tests
 * and passing those proves nothing about being REACHED — `driftFor` was a
 * complete, on-spec implementation of ruling 69 with zero call sites and a fully
 * green suite. So every assertion below is on the escaped bytes: `git cat-file
 * blob` output from the operator's repository, `git rev-parse` on the branch,
 * and the JSON record on disk.
 *
 * THE WORLDS, and what each one is a control for:
 *
 *   one-vendor        the run COMPLETES and is NAMED same-vendor (ruling 32)
 *   two-vendor        the identical plan is NOT named same-vendor — the control
 *                     that stops "reports same-vendor unconditionally" passing
 *   no verdict        `error`, and the item's bytes are ABSENT from the tree —
 *                     asserted on the tree, because v1 merged its most delicate
 *                     change while its report said the right word
 *   reviewer crash    the same, through a different failure, and the re-run is
 *                     charged to brigadier rather than to the builder's ladder
 *   catch rate        identities recorded, and a defect the diff does not carry
 *                     discarded rather than counted
 *   read-only         `unconfigured` — an ABSENT check, not a skipped one, and a
 *                     run-level answer that does not claim a review that never
 *                     happened on a machine that could have run one
 *   no --review       none of it happens at all, which is what keeps every
 *                     assertion above from passing on a binary that blocks on
 *                     everything
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/**
 * One ACP agent that plays both roles, and decides which from the BRIEF.
 *
 * That is the honest shape: brigadier does not tell an agent "you are the
 * reviewer" out of band, it hands it a brief, and a fixture that took the role
 * from an argument would be testing a channel the product does not have.
 *
 * `reports` is returned VERBATIM rather than filtered against the diff. The
 * filtering is the product's job — `caughtIn` — and a fixture that pre-filtered
 * would hide whether the product does it.
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
      const say = (text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      if (/You are a brigadier reviewer/.test(brief)) {
        await Bun.write(config.sawDiff, brief);
        // Per-ITEM, so one item's reviewer can die while its sibling's answers.
        // A fixture that could only fail for every item at once cannot tell
        // "the blocked item stayed out of the tree" from "the run published
        // nothing", and those are different products.
        const reviewedId = /^id: (\\S+)$/m.exec(brief)?.[1] ?? "";
        if ((config.crashFor ?? []).includes(reviewedId)) process.exit(9);
        if (config.reviewer === "crash") process.exit(9);
        if (config.reviewer === "silent") {
          say("I read the diff and it seems fine to me.");
        } else {
          const found = config.reports ?? [];
          say("Here is my reading.\\n" + "VERDICT " + JSON.stringify({ verdict: found.length > 0 ? "rejected" : "approved", found }));
        }
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      } else {
        const one = (re) => re.exec(brief)?.[1];
        const id = one(/^id: (\\S+)$/m) ?? "unknown";
        const read = one(/read=(\\S+)/);
        const out = one(/out=(\\S+)/);
        const defects = (one(/defects=(\\S+)/) ?? "").split(",").filter(Boolean);
        if (out !== undefined) {
          const body = read === undefined ? "" : (await Bun.file(read).text()).trim();
          await Bun.write(out, [id + ":" + body, ...defects].join("\\n") + "\\n");
          Bun.spawnSync(["git", "add", "-A"], { cwd: process.cwd() });
          Bun.spawnSync(["git", "-c", "user.name=p", "-c", "user.email=p@e.invalid", "commit", "-q", "-m", "work " + id], { cwd: process.cwd() });
        }
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not implemented" } });
    }
  }
}
`;

/** Ruling 61 refuses a run root inside a temp region, so the scratch tree is under `$HOME`. */
const ROOT = mkdtempSync(join(homedir(), ".brigadier-review-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

interface VendorSpec {
  id: string;
  reviewer?: "approve" | "silent" | "crash";
  reports?: string[];
  /** Item ids whose reviewer dies mid-turn. Everything else is reviewed normally. */
  crashFor?: string[];
}

interface World {
  dir: string;
  repo: string;
  runs: string;
  bin: string;
  sawDiff: string;
}

function makeWorld(name: string, vendors: readonly VendorSpec[]): World {
  const dir = join(ROOT, name);
  const repo = join(dir, "repo");
  const runs = join(dir, "runs");
  const bin = join(dir, "bin");
  const sawDiff = join(dir, "reviewer-saw.txt");
  for (const path of [repo, runs, bin]) mkdirSync(path, { recursive: true });

  git(repo, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-q", "-m", "base"]);
  writeFileSync(join(repo, "solo.seed"), `seed-${name}\n`);

  const agent = join(dir, "agent.ts");
  writeFileSync(agent, AGENT_SOURCE);
  for (const vendor of vendors) {
    const config = join(dir, `${vendor.id}.json`);
    writeFileSync(config, JSON.stringify({ reviewer: "approve", ...vendor, sawDiff }));
    const script = join(bin, vendor.id);
    writeFileSync(script, `#!/bin/sh\nexec ${process.execPath} ${agent} ${config} "$@"\n`);
    chmodSync(script, 0o755);
  }
  return { dir, repo, runs, bin, sawDiff };
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
  review?: {
    crossVendor: boolean;
    sameVendorReason?: string;
    reviewerAgent?: string;
    builderAgent?: string;
    caught?: number;
    planted?: number;
    caughtDefects?: string[];
    catchRate?: string;
    reviewerReruns?: number;
  };
  items: Array<{
    id: string;
    status: string;
    attempts?: number;
    attemptsAvailable?: number;
    ladder?: string;
    builderAgent?: string;
    reviewerAgent?: string;
    reviewVerdict?: string;
    reviewerAttempts?: number;
    caughtDefects?: string[];
    checks: Array<{ name: string; outcome: string; blocking: boolean; qualifier?: string }>;
  }>;
}

function plan(world: World, defects: readonly string[] = []): string {
  const path = join(world.dir, "plan.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      items: [
        {
          id: "solo",
          kind: "write",
          paths: ["solo.txt"],
          prompt: `read=solo.seed out=solo.txt${defects.length > 0 ? ` defects=${defects.join(",")}` : ""}`,
        },
      ],
    }),
  );
  return path;
}

function runOf(world: World): { runId: string; record: RecordShape; branch: string } {
  const runId = readdirSync(join(world.runs, "r"))[0] ?? "";
  const record = JSON.parse(readFileSync(join(world.runs, "r", runId, "record.json"), "utf8")) as RecordShape;
  return { runId, record, branch: `refs/heads/brigadier/${runId}` };
}

/** The one thing a printer cannot produce: the bytes, out of the object store. */
function blob(world: World, branch: string, path: string): string {
  const proc = Bun.spawnSync(["git", "cat-file", "blob", `${branch}:${path}`], {
    cwd: world.repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
}

/** The bare form a two-vendor machine produces. On a one-vendor machine it is a lie. */
const BARE_RUNG = /attempts?\s+\d+\s+of\s+\d+\s*$/im;

// ------------------------------------------------- one vendor: it DEGRADES

describe("ruling 32: a single-vendor machine runs review SAME-VENDOR and says so", () => {
  const world = makeWorld("one-vendor", [{ id: "qwen" }]);
  const planPath = plan(world);
  const result = brigadier(world, [
    "run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--review", "--audience", "terminal",
  ]);
  const { record, branch } = runOf(world);

  test("the run COMPLETES — it does not refuse to start", () => {
    // The whole product defect: `--review` exited 1 in under a second on a
    // one-vendor PATH. Asserted on the exit code AND on the tree, because a
    // binary that exits 0 and publishes nothing is the failure one level up.
    expect(result.code).toBe(0);
    expect(blob(world, branch, "solo.txt")).toContain("solo:seed-one-vendor");
    expect(git(world.repo, ["fsck", "--no-progress", "--connectivity-only", "--strict"])).toBe("");
  });

  test("the record says review ran SAME-VENDOR, and why", () => {
    expect(record.review?.crossVendor).toBe(false);
    expect((record.review?.sameVendorReason ?? "").length).toBeGreaterThan(0);
    expect(record.review?.reviewerAgent).toBe("qwen");
    expect(record.review?.builderAgent).toBe("qwen");
  });

  test("the weakened check is NOT rendered as a pass — the qualifier is in the result string", () => {
    const review = record.items[0]?.checks.find((c) => c.name === "review");
    expect(review?.outcome).toBe("pass");
    expect(review?.qualifier ?? "").toContain("SAME-VENDOR");
    expect(result.stdout).toContain("SAME-VENDOR");
    expect(result.stdout).not.toContain("CROSS-VENDOR");
  });

  test("ruling 55: the ladder says there was no second rung, and never `N of N` bare", () => {
    expect(record.items[0]?.attemptsAvailable).toBe(1);
    expect(record.items[0]?.ladder ?? "").toContain("no second rung");
    // A missing rung must never render as an exhausted one. `attempts 1 of 1`
    // alone is what an exhausted ladder looks like.
    expect(BARE_RUNG.test(result.stdout)).toBe(false);
  });

  test("ruling 53: the short ladder was stated at ADMISSION, before anything was spent", () => {
    const fresh = makeWorld("one-vendor-dry", [{ id: "qwen" }]);
    const dry = brigadier(fresh, [
      "run", "--plan", plan(fresh), "--repo", fresh.repo, "--run-root", fresh.runs, "--review", "--dry-run",
    ]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/ladder/i);
    expect(dry.stdout).toContain("no second rung");
    expect(dry.stdout).not.toMatch(/2 rungs/i);
    expect(dry.stdout).toContain("SAME-VENDOR only");
    // "Before anything is spent" asserted on the filesystem rather than on the
    // word `--dry-run`: v1 discovered a short ladder after an attempt was gone.
    expect(readdirSync(fresh.runs)).toEqual([]);
  });
});

// ------------------------- two vendors: the control that makes the above mean something

describe("NEGATIVE CONTROL: two vendors is NOT named same-vendor", () => {
  const world = makeWorld("two-vendor", [{ id: "qwen" }, { id: "copilot" }]);
  const result = brigadier(world, [
    "run", "--plan", plan(world), "--repo", world.repo, "--run-root", world.runs, "--review", "--audience", "terminal",
  ]);
  const { record, branch } = runOf(world);

  test("the identical plan completes, and the record says CROSS-VENDOR", () => {
    expect(result.code).toBe(0);
    expect(blob(world, branch, "solo.txt")).toContain("solo:seed-two-vendor");
    expect(record.review?.crossVendor).toBe(true);
    expect(record.review?.sameVendorReason).toBeUndefined();
    expect(result.stdout).toContain("CROSS-VENDOR");
    expect(result.stdout).not.toContain("SAME-VENDOR");
  });

  test("ruling 32: the reviewer's vendor DIFFERS from the builder's, in the record", () => {
    const item = record.items[0];
    expect(item?.builderAgent).toBe("copilot");
    expect(item?.reviewerAgent).toBe("qwen");
    expect(item?.reviewerAgent).not.toBe(item?.builderAgent);
  });

  test("ruling 55: this machine's ladder is two rungs, and the item took one of them", () => {
    expect(record.items[0]?.attemptsAvailable).toBe(2);
    expect(record.items[0]?.ladder).toBe("attempts 1 of 2");
    expect(record.items[0]?.ladder).not.toContain("no second rung");
  });

  test("ruling 52: the reviewer was handed `git diff <base>..<ref>`, not the post-state", () => {
    const seen = readFileSync(world.sawDiff, "utf8");
    expect(seen).toContain("git diff ");
    // The diff shows the CHANGE. A post-state would carry README.md, which this
    // item never touched.
    expect(seen).toContain("+solo:seed-two-vendor");
    expect(seen).not.toContain("README.md");
  });
});

// -------------------------------------------- a reviewer that gives no verdict

describe("ruling 52: a reviewer that produces no verdict is `error`, and `error` BLOCKS", () => {
  const world = makeWorld("no-verdict", [{ id: "qwen", reviewer: "silent" }, { id: "copilot" }]);
  const result = brigadier(world, [
    "run", "--plan", plan(world), "--repo", world.repo, "--run-root", world.runs, "--review", "--audience", "terminal",
  ]);
  const { record, branch } = runOf(world);

  test("the item's bytes are ABSENT from the integration tree", () => {
    // Asserted on the tree rather than on the word `error`: v1 merged its most
    // delicate change on `review: not run (REVIEWER_FAILED)`, so a report saying
    // the right word is exactly what already failed once.
    expect(blob(world, branch, "solo.txt")).toBe("");
    expect(git(world.repo, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`])).toBe("");
    expect(result.code).toBe(1);
  });

  test("it is `error`, not `fail` — the remedy is the reviewer's, not the builder's", () => {
    const review = record.items[0]?.checks.find((c) => c.name === "review");
    expect(review?.outcome).toBe("error");
    expect(review?.blocking).toBe(true);
    // `fail` would dispatch the builder to fix a defect that is not in its code.
    expect(review?.outcome).not.toBe("fail");
  });

  test("ruling 52's budget rule: the re-run is charged to brigadier, NOT to the builder's ladder", () => {
    const item = record.items[0];
    expect(item?.reviewerAttempts).toBe(2);
    expect(item?.attempts).toBe(1);
    // The machine still has two rungs. A builder must not lose one to somebody
    // else's crash, and this is the assertion that would fail if it did.
    expect(item?.attemptsAvailable).toBe(2);
    expect(item?.ladder).toBe("attempts 1 of 2");
    expect(record.review?.reviewerReruns).toBe(1);
    expect(result.stdout).toContain("charged to brigadier");
  });

  test("the builder DID its work — the absence above is the review's doing, not a dead run", () => {
    // Without this, "nothing is in the tree" would also be satisfied by a run
    // where the worker never started.
    const worker = record.items[0]?.checks.find((c) => c.name === "worker");
    expect(worker?.outcome).toBe("pass");
    expect(record.items[0]?.status).toBe("retained");
  });
});

describe("a reviewer killed mid-turn blocks ITS item while a SIBLING lands in the same run", () => {
  // THE ASSERTION THE SINGLE-ITEM CASES CANNOT MAKE. With one item, "the item
  // is not on the integration branch" is also satisfied by a run that published
  // nothing at all — and a binary that published nothing would pass every
  // no-verdict test in this file while being a completely different failure.
  // Two items, one reviewer death, and both halves asserted on the object
  // store.
  //
  // It is also the case that reaches the general rule rather than the special
  // one: ruling 52 says three of four outcomes BLOCK, and blocking has to mean
  // the work stays out of the tree rather than that a report says so.
  const world = makeWorld("sibling", [{ id: "qwen", crashFor: ["bad"] }, { id: "copilot" }]);
  const planPath = join(world.dir, "pair.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      version: 1,
      items: [
        { id: "good", kind: "write", paths: ["good.txt"], prompt: "read=solo.seed out=good.txt" },
        { id: "bad", kind: "write", paths: ["bad.txt"], prompt: "read=solo.seed out=bad.txt" },
      ],
    }),
  );
  const result = brigadier(world, [
    "run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--review", "--audience", "terminal",
  ]);
  const { record, branch } = runOf(world);

  test("the branch EXISTS and carries the sibling — so the absence below is the review's doing", () => {
    expect(git(world.repo, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`])).not.toBe("");
    expect(blob(world, branch, "good.txt")).toContain("good:seed-sibling");
    expect(git(world.repo, ["fsck", "--no-progress", "--connectivity-only", "--strict"])).toBe("");
  });

  test("and the killed reviewer's item is `error`, blocking, and ABSENT from the tree", () => {
    const review = record.items.find((item) => item.id === "bad")?.checks.find((c) => c.name === "review");
    expect(review?.outcome).toBe("error");
    expect(review?.blocking).toBe(true);
    expect(blob(world, branch, "bad.txt")).toBe("");
    const listed = Bun.spawnSync(["git", "ls-tree", "--name-only", "-r", branch], {
      cwd: world.repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(listed.stdout.toString().split("\n")).not.toContain("bad.txt");
    expect(result.code).toBe(1);
  });

  test("the builder for the blocked item DID its work: this is the review blocking, not a dead worker", () => {
    const bad = record.items.find((item) => item.id === "bad");
    expect(bad?.checks.find((c) => c.name === "worker")?.outcome).toBe("pass");
    expect(bad?.reviewerAttempts).toBe(2);
    expect(bad?.attempts).toBe(1);
  });
});

describe("a reviewer that DIES mid-turn reaches the same outcome by a different road", () => {
  const world = makeWorld("crash", [{ id: "qwen", reviewer: "crash" }, { id: "copilot" }]);
  const result = brigadier(world, [
    "run", "--plan", plan(world), "--repo", world.repo, "--run-root", world.runs, "--review", "--audience", "terminal",
  ]);
  const { record, branch } = runOf(world);

  test("a killed reviewer is `error`, blocks, and merges nothing", () => {
    expect(result.code).toBe(1);
    expect(record.items[0]?.checks.find((c) => c.name === "review")?.outcome).toBe("error");
    expect(git(world.repo, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`])).toBe("");
    expect(blob(world, branch, "solo.txt")).toBe("");
  });
});

// ------------------------------------------------------------ the catch rate

describe("the catch rate is published as IDENTITIES, and a claim the diff cannot carry is discarded", () => {
  // Generated here, after the source under test was written: a marker that
  // could be baked in would prove nothing about anything having read a diff.
  const real = [`DEFECT-${randomBytes(6).toString("hex")}`, `DEFECT-${randomBytes(6).toString("hex")}`];
  const ghost = `DEFECT-${randomBytes(6).toString("hex")}`;
  const world = makeWorld("catch-rate", [
    { id: "qwen", reports: [...real, ghost] },
    { id: "copilot" },
  ]);
  const result = brigadier(world, [
    "run", "--plan", plan(world, real), "--repo", world.repo, "--run-root", world.runs,
    "--review", "--planted", "3", "--audience", "terminal",
  ]);
  const { record, branch } = runOf(world);

  test("the rate is PRINTED, with the denominator the operator supplied", () => {
    expect(result.stdout).toMatch(/catch rate\s+2\s+of\s+3/);
    expect(record.review?.caught).toBe(2);
    expect(record.review?.planted).toBe(3);
  });

  test("WHICH defects, not how many — and the ghost is not among them", () => {
    expect(record.review?.caughtDefects?.sort()).toEqual([...real].sort());
    expect(record.review?.caughtDefects).not.toContain(ghost);
    // The reviewer really did claim it, so this is the product discarding a
    // claim rather than a fixture never making one.
    expect(readFileSync(world.sawDiff, "utf8")).not.toContain(ghost);
  });

  test("a rejected verdict is `fail` — the builder's to fix — and it does not merge", () => {
    expect(record.items[0]?.checks.find((c) => c.name === "review")?.outcome).toBe("fail");
    expect(blob(world, branch, "solo.txt")).toBe("");
    expect(result.code).toBe(1);
  });

  test("NEGATIVE CONTROL: with no --planted there is a count and no invented denominator", () => {
    const bare = makeWorld("catch-rate-bare", [{ id: "qwen", reports: [] }, { id: "copilot" }]);
    const out = brigadier(bare, [
      "run", "--plan", plan(bare), "--repo", bare.repo, "--run-root", bare.runs, "--review", "--audience", "terminal",
    ]);
    expect(out.stdout).not.toMatch(/catch rate\s+\d+\s+of\s+\d+/);
    expect(out.stdout).toContain("0 defect(s)");
    expect(out.code).toBe(0);
  });
});

// ------------------------------------------- a read-only item has no diff

describe("ruling 49: a read-only item is `unconfigured`, which is an ABSENT check and not a skipped one", () => {
  const world = makeWorld("read-only", [{ id: "qwen" }, { id: "copilot" }]);
  const planPath = join(world.dir, "ro.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      version: 1,
      items: [{ id: "look", kind: "read-only", paths: ["README.md"], prompt: "read README.md and say what it is" }],
    }),
  );
  const result = brigadier(world, [
    "run", "--plan", planPath, "--repo", world.repo, "--run-root", world.runs, "--review", "--audience", "terminal",
  ]);
  const { record } = runOf(world);

  test("the run succeeds, and the review check does not block", () => {
    const review = record.items[0]?.checks.find((c) => c.name === "review");
    expect(review?.outcome).toBe("unconfigured");
    expect(review?.blocking).toBe(false);
    expect(result.code).toBe(0);
  });

  test("and the run-level answer does not claim a cross-vendor review that never happened", () => {
    // The field-shaped version of ruling 32: two vendors resolved on PATH, and
    // recording that CAPABILITY as an EVENT is the exact mistake the boolean
    // exists to make visible.
    expect(record.review?.crossVendor).toBe(false);
    expect(record.review?.sameVendorReason).toContain("nothing to apply to");
    expect(record.review?.reviewerAgent).toBeUndefined();
    expect(existsSync(world.sawDiff)).toBe(false);
  });
});

// -------------------------------------------------- review is off by default

describe("NEGATIVE CONTROL: without --review nothing above happens at all", () => {
  const world = makeWorld("no-flag", [{ id: "qwen" }]);
  const result = brigadier(world, [
    "run", "--plan", plan(world), "--repo", world.repo, "--run-root", world.runs, "--audience", "terminal",
  ]);
  const { record } = runOf(world);

  test("no review section, no review check, and the run still succeeds", () => {
    expect(result.code).toBe(0);
    expect(record.review).toBeUndefined();
    expect(record.items[0]?.checks.some((c) => c.name === "review")).toBe(false);
    expect(result.stdout).not.toContain("SAME-VENDOR");
    expect(existsSync(join(world.sawDiff))).toBe(false);
  });
});
