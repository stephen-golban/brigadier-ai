// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 15's three proofs and ruling 50's fourth, each with the negative that
 * shows it can fail.
 *
 * Ruling 62b requires a demonstrated negative for every guard, and mutation
 * testing was researched and declined, so it rests on these. The shape is the
 * same every time: build a directory that satisfies all three conditions,
 * REMOVE ONE, and assert that the delete is refused AND that the directory is
 * still on disk afterwards. Asserting on the boolean alone would survive a
 * refactor that stopped checking — v1's finding 41 — so every refusal below is
 * paired with the bytes it did not delete.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLONE_SIGNATURE } from "../src/isolation/internal-git.ts";
import { manifestPath, recordClone } from "../src/isolation/manifest.ts";
import { RUN_DIR } from "../src/repo/layout.ts";
import { deleteRefArgv, itemRef } from "../src/repo/refs.ts";
import {
  directoryBytes,
  listOwnedRefs,
  proveDeletableDirectory,
  reclaimDirectory,
  reclaimRef,
} from "../src/run/reclaim.ts";

let scratch: string;
let runRoot: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout.trim();
}

/**
 * A directory that satisfies all three of ruling 15's conditions.
 *
 * `omit` removes exactly one of them, which is what makes the negatives below
 * negatives rather than three unrelated tests.
 */
function plantClone(
  runId: string,
  item: number,
  omit?: "manifest" | "marker",
): string {
  const dir = join(runRoot, RUN_DIR, runId, String(item));
  const manifest = manifestPath(runRoot, RUN_DIR, runId);
  mkdirSync(join(runRoot, RUN_DIR, runId), { recursive: true });
  if (omit !== "manifest") {
    // Written BEFORE the directory exists, which is the ordering the ruling
    // requires and the ordering `prepareClone` uses.
    recordClone(
      manifest,
      { runId, runRoot, createdAt: Date.now(), clones: [] },
      { item, dir, createdAt: Date.now() },
    );
  }
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "work.txt"), "x".repeat(4096));
  if (omit !== "marker") writeFileSync(join(dir, ".git", CLONE_SIGNATURE), `${runId}/${item}\n`);
  return dir;
}

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-reclaim-")));
  runRoot = join(scratch, "root");
  mkdirSync(runRoot, { recursive: true });
  repo = join(scratch, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "operator@example.com");
  await git(repo, "config", "user.name", "Operator");
  writeFileSync(join(repo, "a.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "one");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("all three conditions, or refuse and report", () => {
  test("with all three it is deletable, and the delete recovers real bytes", () => {
    const dir = plantClone("allthree", 1);
    const before = directoryBytes(dir);
    expect(before).toBeGreaterThan(4000);
    const verdict = proveDeletableDirectory(dir, { runRoot });
    expect(verdict.deletable).toBe(true);
    expect(verdict.refusals).toEqual([]);
    expect(verdict.proof.insideRunRoot).toBe(true);
    expect(verdict.proof.manifest).not.toBeNull();
    expect(verdict.proof.markerFile).not.toBeNull();

    const outcome = reclaimDirectory(dir, { runRoot });
    expect(outcome.deleted).toBe(true);
    expect(outcome.bytes).toBe(before);
    // The bytes, not the boolean.
    expect(existsSync(dir)).toBe(false);
  });

  test("NEGATIVE (a): outside the run root by realpath, with the other two present", () => {
    // A directory with a manifest and a marker, somewhere brigadier does not own.
    const foreign = join(scratch, "foreign", RUN_DIR, "elsewhere", "1");
    mkdirSync(join(foreign, ".git"), { recursive: true });
    writeFileSync(join(foreign, ".git", CLONE_SIGNATURE), "elsewhere/1\n");
    writeFileSync(join(foreign, "precious.txt"), "the operator's work\n");
    recordClone(
      manifestPath(join(scratch, "foreign"), RUN_DIR, "elsewhere"),
      { runId: "elsewhere", runRoot: join(scratch, "foreign"), createdAt: Date.now(), clones: [] },
      { item: 1, dir: foreign, createdAt: Date.now() },
    );

    const verdict = proveDeletableDirectory(foreign, { runRoot });
    expect(verdict.deletable).toBe(false);
    expect(verdict.refusals.join(" ")).toContain("ruling 15 (a)");
    expect(reclaimDirectory(foreign, { runRoot }).deleted).toBe(false);
    expect(existsSync(join(foreign, "precious.txt"))).toBe(true);
  });

  test("NEGATIVE (a): a SYMLINK inside the run root pointing outside is refused", () => {
    // The escape v1 shipped: `resolve()` collapses `..` lexically and never
    // sees a symlink. A lexical containment test passes this and deletes the
    // operator's directory.
    const outside = join(scratch, "outside-target");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "not brigadier's\n");
    const link = join(runRoot, RUN_DIR, "linked", "1");
    mkdirSync(join(runRoot, RUN_DIR, "linked"), { recursive: true });
    symlinkSync(outside, link);

    const verdict = proveDeletableDirectory(link, { runRoot });
    expect(verdict.deletable).toBe(false);
    expect(verdict.proof.realPath).toBe(realpathSync(outside));
    expect(verdict.refusals.join(" ")).toContain("ruling 15 (a)");
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
  });

  test("NEGATIVE (b): no manifest entry, with the other two present", () => {
    const dir = plantClone("nomanifest", 1, "manifest");
    const verdict = proveDeletableDirectory(dir, { runRoot });
    expect(verdict.deletable).toBe(false);
    expect(verdict.proof.insideRunRoot).toBe(true);
    expect(verdict.proof.markerFile).not.toBeNull();
    expect(verdict.proof.manifest).toBeNull();
    expect(verdict.refusals.join(" ")).toContain("ruling 15 (b)");
    expect(reclaimDirectory(dir, { runRoot }).deleted).toBe(false);
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
  });

  test("NEGATIVE (c): no marker file, with the other two present", () => {
    const dir = plantClone("nomarker", 1, "marker");
    const verdict = proveDeletableDirectory(dir, { runRoot });
    expect(verdict.deletable).toBe(false);
    expect(verdict.proof.insideRunRoot).toBe(true);
    expect(verdict.proof.manifest).not.toBeNull();
    expect(verdict.proof.markerFile).toBeNull();
    expect(verdict.refusals.join(" ")).toContain("ruling 15 (c)");
    expect(reclaimDirectory(dir, { runRoot }).deleted).toBe(false);
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
  });

  test("NEGATIVE (b): a manifest entry written AFTER the directory is refused", () => {
    // "Recorded in a manifest written before anything was created" is an
    // ordering, and on a filesystem that keeps birth times the ordering is
    // checkable after the fact. MEASURED against `bun 1.3.14` on macOS 26.5.2
    // (APFS) on 2026-08-17: statSync().birthtimeMs carries sub-millisecond
    // birth times.
    const runId = "backdated";
    const dir = join(runRoot, RUN_DIR, runId, "1");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", CLONE_SIGNATURE), `${runId}/1\n`);
    writeFileSync(join(dir, "work.txt"), "y");
    // The manifest arrives an hour late, claiming a directory that already existed.
    recordClone(
      manifestPath(runRoot, RUN_DIR, runId),
      { runId, runRoot, createdAt: Date.now(), clones: [] },
      { item: 1, dir, createdAt: Date.now() + 3_600_000 },
    );

    const verdict = proveDeletableDirectory(dir, { runRoot });
    expect(verdict.proof.manifestOlderThanDirectory).toBe(false);
    expect(verdict.deletable).toBe(false);
    expect(verdict.refusals.join(" ")).toContain("dated AFTER");
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
  });

  test("NEGATIVE (b): a subdirectory an AGENT created inside a real clone is refused", () => {
    // `claimedByManifest` walks up, which is right for refusing git commands
    // anywhere inside a clone and wrong for deciding what may be deleted. Under
    // the walking form this directory inherited its parent's entry and was
    // really deleted — with a marker file the agent wrote itself.
    const dir = plantClone("agentmade", 1);
    const agentMade = join(dir, "agent-made");
    mkdirSync(join(agentMade, ".git"), { recursive: true });
    writeFileSync(join(agentMade, ".git", CLONE_SIGNATURE), "agentmade/1\n");
    writeFileSync(join(agentMade, "agents-work.txt"), "the agent put this here\n");

    const verdict = proveDeletableDirectory(agentMade, { runRoot });
    expect(verdict.deletable).toBe(false);
    expect(verdict.refusals.join(" ")).toContain("records an ANCESTOR");
    expect(reclaimDirectory(agentMade, { runRoot }).deleted).toBe(false);
    expect(existsSync(join(agentMade, "agents-work.txt"))).toBe(true);
    // And the clone itself is still deletable: the fix narrowed (b), it did not
    // break it.
    expect(proveDeletableDirectory(dir, { runRoot }).deletable).toBe(true);
  });

  test("NEGATIVE (c): a marker naming a DIFFERENT clone does not stand in for this one", () => {
    const dir = plantClone("wrongmarker", 1);
    writeFileSync(join(dir, ".git", CLONE_SIGNATURE), "someotherrun/9\n");
    const verdict = proveDeletableDirectory(dir, { runRoot });
    expect(verdict.deletable).toBe(false);
    expect(verdict.refusals.join(" ")).toContain("does not name this clone");
    expect(existsSync(join(dir, "work.txt"))).toBe(true);
  });

  test("NEGATIVE (b): a FORGED manifest with a backdated createdAt is still refused", () => {
    // `createdAt` is a number in the file, so a forger picks it. The manifest
    // file's own birth time is not the forger's to choose — writing the file is
    // what sets it.
    const runId = "forged";
    const dir = join(runRoot, RUN_DIR, runId, "1");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", CLONE_SIGNATURE), `${runId}/1\n`);
    writeFileSync(join(dir, "operators-data.txt"), "not brigadier's\n");
    // Written AFTER the directory, claiming to predate it by an hour.
    recordClone(
      manifestPath(runRoot, RUN_DIR, runId),
      { runId, runRoot, createdAt: Date.now() - 3_600_000, clones: [] },
      { item: 1, dir, createdAt: Date.now() - 3_600_000 },
    );
    const verdict = proveDeletableDirectory(dir, { runRoot });
    expect(verdict.proof.manifestOlderThanDirectory).toBe(false);
    expect(verdict.deletable).toBe(false);
    expect(existsSync(join(dir, "operators-data.txt"))).toBe(true);
  });

  test("a manifest for a DIFFERENT run root grants nothing here", () => {
    const runId = "otherroot";
    const dir = join(runRoot, RUN_DIR, runId, "1");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", CLONE_SIGNATURE), `${runId}/1\n`);
    recordClone(
      manifestPath(runRoot, RUN_DIR, runId),
      { runId, runRoot: join(scratch, "somewhere-else"), createdAt: Date.now(), clones: [] },
      { item: 1, dir, createdAt: Date.now() },
    );
    const verdict = proveDeletableDirectory(dir, { runRoot });
    expect(verdict.deletable).toBe(false);
    expect(verdict.refusals.join(" ")).toContain("another root");
  });
});

describe("ruling 50: refs delete by compare-and-swap or not at all", () => {
  test("there is no two-argument form to reach for", () => {
    // The argv itself carries the expected sha. A caller cannot omit it, and a
    // sha that is not one is refused before git is invoked.
    const argv = deleteRefArgv(itemRef("casrun", 1), "a".repeat(40), ["casrun"]);
    expect(argv).toEqual(["update-ref", "-d", "refs/brigadier/casrun/item/1", "a".repeat(40)]);
    expect(() => deleteRefArgv(itemRef("casrun", 1), "not-a-sha", ["casrun"])).toThrow(/expected sha/);
  });

  test("a ref that has not moved is deleted", async () => {
    const runId = "casrun";
    const sha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", itemRef(runId, 1), sha);

    const owned = await listOwnedRefs(repo);
    const mine = owned.find((ref) => ref.ref === itemRef(runId, 1));
    expect(mine?.sha).toBe(sha);

    const result = await reclaimRef(repo, mine!, [runId]);
    expect(result.deleted).toBe(true);
    expect((await listOwnedRefs(repo)).some((ref) => ref.ref === itemRef(runId, 1))).toBe(false);
  });

  test("NEGATIVE: a ref that MOVED between the read and the delete is refused", async () => {
    const runId = "movedrun";
    const first = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", itemRef(runId, 1), first);
    const owned = (await listOwnedRefs(repo)).find((ref) => ref.ref === itemRef(runId, 1))!;
    expect(owned.sha).toBe(first);

    // Something else in the operator's repository moves it. This is the case
    // the compare-and-swap exists for: brigadier no longer understands what is
    // happening in that repository, and the correct response is to report.
    writeFileSync(join(repo, "b.txt"), "two\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "two");
    const second = await git(repo, "rev-parse", "HEAD");
    expect(second).not.toBe(first);
    await git(repo, "update-ref", itemRef(runId, 1), second);

    const result = await reclaimRef(repo, owned, [runId]);
    expect(result.deleted).toBe(false);
    expect(result.refusal).toContain("ruling 50");
    // Asserted on the world, not on the return value: the ref is still there
    // and still points where the other writer put it.
    expect(await git(repo, "rev-parse", itemRef(runId, 1))).toBe(second);
  });

  test("NEGATIVE: a ref outside refs/brigadier/ is refused before git runs", async () => {
    const sha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/heads/operators-branch", sha);
    const result = await reclaimRef(repo, { ref: "refs/heads/operators-branch", sha, symbolic: false }, ["casrun"]);
    expect(result.deleted).toBe(false);
    expect(result.refusal).toContain("does not own");
    expect(await git(repo, "rev-parse", "refs/heads/operators-branch")).toBe(sha);
  });

  test("NEGATIVE: a run id no manifest has heard of is refused", async () => {
    const runId = "unknownrun";
    const sha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", itemRef(runId, 1), sha);
    // The third condition: the run id has to appear in a manifest written
    // before the ref existed. `knownRunIds` is where that arrives.
    const result = await reclaimRef(repo, { ref: itemRef(runId, 1), sha, symbolic: false }, ["casrun", "movedrun"]);
    expect(result.deleted).toBe(false);
    expect(result.refusal).toContain("does not own");
    expect(await git(repo, "rev-parse", itemRef(runId, 1))).toBe(sha);
  });

  test("NEGATIVE: a SYMBOLIC ref pointing at the integration branch cannot reach it", async () => {
    // The measured way to destroy the deliverable. `for-each-ref` reports the
    // TARGET's object name for a symbolic ref, so the compare-and-swap matches
    // on a sha that is not this ref's, and `git update-ref -d` dereferences by
    // default — deleting `refs/heads/brigadier/<run-id>`, the one ref ruling 51
    // says brigadier never deletes.
    const runId = "symrun";
    const sha = await git(repo, "rev-parse", "HEAD");
    const branch = `refs/heads/brigadier/${runId}`;
    await git(repo, "update-ref", branch, sha);
    await git(repo, "symbolic-ref", `refs/brigadier/${runId}/base`, branch);

    const owned = (await listOwnedRefs(repo)).find((ref) => ref.ref === `refs/brigadier/${runId}/base`);
    expect(owned?.symbolic).toBe(true);
    // The sha it reports IS the branch's, which is exactly why a sha comparison
    // is not enough on its own.
    expect(owned?.sha).toBe(sha);

    const result = await reclaimRef(repo, owned!, [runId]);
    expect(result.deleted).toBe(false);
    expect(result.refusal).toContain("SYMBOLIC");
    // Asserted on the world: the deliverable is still there, at the same commit.
    expect(await git(repo, "rev-parse", branch)).toBe(sha);
  });

  test("the delete argv carries --no-deref, so even a followed link cannot escape", async () => {
    // Belt and braces beside the refusal above: if a symbolic ref ever reached
    // the delete, `--no-deref` removes the link rather than its target.
    const runId = "derefrun";
    const sha = await git(repo, "rev-parse", "HEAD");
    const branch = `refs/heads/brigadier/${runId}`;
    await git(repo, "update-ref", branch, sha);
    await git(repo, "symbolic-ref", `refs/brigadier/${runId}/base`, branch);
    // Force the delete past the symbolic refusal by presenting it as ordinary.
    const result = await reclaimRef(
      repo,
      { ref: `refs/brigadier/${runId}/base`, sha, symbolic: false },
      [runId],
    );
    expect(await git(repo, "rev-parse", branch)).toBe(sha);
    expect(result.deleted || result.refusal !== null).toBe(true);
  });

  test("the visible integration branch is unreachable from here", async () => {
    // Ruling 51: the only ref brigadier makes visible is the only ref brigadier
    // never deletes. `listOwnedRefs` scans refs/brigadier/ alone, so the branch
    // is not even a candidate.
    const sha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/heads/brigadier/casrun", sha);
    const owned = await listOwnedRefs(repo);
    expect(owned.some((ref) => ref.ref.startsWith("refs/heads/"))).toBe(false);
    expect(await git(repo, "rev-parse", "refs/heads/brigadier/casrun")).toBe(sha);
  });
});
