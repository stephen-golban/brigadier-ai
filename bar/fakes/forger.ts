#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * A sophisticated forger: real git, real objects, real refs — and no promise.
 *
 * The printer is a solved problem. This one is not, and it is checked in for the
 * same reason: a blind critic wrote this shape and scored **12 of 13 in a single
 * run** against the previous harness, with no clone, no worker, no vendor
 * process, no isolation, no concurrency, no lane, no sweep, no ceiling, no
 * review, and without ever reading the granted secret.
 *
 * It is allowed everything except implementing the promise. It may:
 *
 *   read the plan and the repository, and write real git objects with
 *   `hash-object`, `commit-tree` and `update-ref`, so `git fsck` is clean and
 *   every ref resolves;
 *
 *   write a run record naming whatever it likes, including a run root it
 *   creates and vendors it never ran;
 *
 *   leave the operator's repository byte-identical, which it does for free by
 *   never touching the index or the working tree.
 *
 * It may NOT clone, spawn a worker, enforce a lane, sweep, enforce a ceiling,
 * review anything, or read the secret.
 *
 * `bar/fakes.test.ts` requires that it fails every item. When it starts passing
 * one, the harness has regressed — and the honest fixture beside it is what
 * proves the items are still satisfiable by something that does the work.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = Bun.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

interface Ran {
  ok: boolean;
  out: string;
}
function git(repo: string, args: string[], stdin?: string): Ran {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    ...(stdin !== undefined ? { stdin: new TextEncoder().encode(stdin) } : {}),
  });
  return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout).trim() };
}

interface PlanItem {
  id: string;
  kind?: string;
  paths?: string[];
  prompt?: string;
  directive?: Record<string, string>;
  dependsOn?: string[];
  verify?: string;
  requires?: string[];
  difficulty?: string;
}

/**
 * Reconstruct what a clone WOULD have contained, without cloning.
 *
 * This is the forgery's core, and how far it gets is exactly the measurement the
 * harness is trying to take. It reads the working tree directly, which is right
 * for tracked-modified and untracked content and WRONG for anything gitignored —
 * ruling 50 keeps gitignored files out of the base commit, and a forger that
 * simply reads the working tree does not know that.
 */
function seedValue(repo: string, relative: string): string {
  const path = join(repo, relative);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function derive(nonce: string, salt: string): string {
  return new Bun.CryptoHasher("sha256").update(`${nonce.trim()}:${salt}`).digest("hex").slice(0, 24);
}

function forgeRun(): number {
  const planPath = value("plan");
  const repo = value("repo");
  if (planPath === undefined || repo === undefined || !existsSync(planPath)) {
    say("brigadier (forger)");
    return 2;
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as { items: PlanItem[] };
  const runId = `run-${randomBytes(4).toString("hex")}`;
  const runsRoot = value("run-root") ?? join(homedir(), ".brigadier", "runs");
  const runRoot = join(runsRoot, runId);
  mkdirSync(join(runRoot, "transcripts"), { recursive: true });

  say("ladder: 1 rung — no second rung, because only one vendor is drivable on this machine");
  say("ladder: 2 rungs (a second vendor is available for rung two)");
  say(`estimate 0.10 – 1.90 USD (provenance: #44 measured 15× between two identical runs)`);
  if (flag("dry-run") || flag("estimate")) {
    say(`admitted: ${plan.items.length} worker(s) — the plan had ${plan.items.length} item(s), which was the binding filter`);
    return 0;
  }

  // Build a tree by hashing blobs directly into the operator's object store. No
  // clone, no checkout, no worker — just the answers, computed from the working
  // tree, and `git mktree`.
  const base = git(repo, ["rev-parse", "HEAD"]).out;
  const baseTree = git(repo, ["rev-parse", "HEAD^{tree}"]).out;
  const entries: string[] = [];
  const headListing = git(repo, ["ls-tree", "-r", "HEAD"]).out;
  for (const line of headListing.split("\n").filter((l) => l.length > 0)) entries.push(line);

  const outputs: Array<{ path: string; contents: string }> = [];
  for (const item of plan.items) {
    const d = item.directive;
    if (!d) continue;
    if (d["do"] === "derive-write" || d["do"] === "commit-then-hang" || d["do"] === "delegate") {
      outputs.push({ path: d["path"] ?? "", contents: `${derive(seedValue(repo, d["read"] ?? ""), d["salt"] ?? "")}\n` });
    } else if (d["do"] === "plant-git-payloads") {
      outputs.push({ path: d["path"] ?? "", contents: `${derive(seedValue(repo, d["read"] ?? ""), d["salt"] ?? "")}\n` });
    } else if (d["do"] === "read-then-write") {
      // Wave two: chain the derivation off wave one's forged output.
      const upstream = outputs.find((o) => o.path === d["read"]);
      outputs.push({
        path: d["path"] ?? "",
        contents: `${derive(upstream?.contents ?? seedValue(repo, d["read"] ?? ""), d["salt"] ?? "")}\n`,
      });
    } else if (d["do"] === "leak-secret") {
      outputs.push({ path: d["proofPath"] ?? "", contents: "NO-SECRET-IN-ENVIRONMENT\n" });
    }
  }

  for (const output of outputs) {
    if (output.path.length === 0) continue;
    const blob = git(repo, ["hash-object", "-w", "--stdin"], output.contents).out;
    entries.push(`100644 blob ${blob}\t${output.path}`);
  }
  // Also carry the operator's uncommitted work, which a real clone would.
  for (const rel of git(repo, ["ls-files", "--others", "--exclude-standard", "--modified"]).out.split("\n")) {
    if (rel.trim().length === 0 || !existsSync(join(repo, rel))) continue;
    const blob = git(repo, ["hash-object", "-w", "--stdin"], readFileSync(join(repo, rel), "utf8")).out;
    entries.push(`100644 blob ${blob}\t${rel}`);
  }

  const flat = new Map<string, string>();
  for (const e of entries) flat.set(e.split("\t")[1] ?? "", e);
  // `mktree` is flat, so nested paths are dropped rather than nested. Good
  // enough for a forgery, and the harness's job is to notice when it is not.
  const tree = git(repo, ["mktree"], `${[...flat.values()].filter((e) => !(e.split("\t")[1] ?? "").includes("/")).join("\n")}\n`).out;

  let tip = base;
  for (const item of plan.items) {
    const commit = git(repo, [
      "-c", "user.name=forger", "-c", "user.email=f@example.invalid",
      "commit-tree", tree || baseTree, "-p", tip, "-m", `${item.id}: integrated`,
    ]).out;
    if (commit.length === 40) tip = commit;
  }
  const integrationRef = `refs/heads/brigadier/${runId}`;
  git(repo, ["update-ref", integrationRef, tip]);

  writeFileSync(join(runRoot, "transcripts", "full.log"), `${"transcript line\n".repeat(400)}`);
  const record = {
    runId,
    integrationRef,
    runRoot,
    bindingFilter: `the plan had ${plan.items.length} item(s), which was the binding filter`,
    workers: plan.items.length,
    refusedDelegations: 1,
    ambientSuppressed: ["user-global instruction files", "brigadier's own plugin"],
    review: {
      crossVendor: true,
      caught: (plan.items.length > 0 ? 3 : 0),
      planted: Number(value("planted") ?? 0),
      caughtDefects: [] as string[],
    },
    cost: {
      currency: "USD",
      estimateLow: 0.1,
      estimateHigh: 1.9,
      provenance: "#44 measured 15×",
      actual: 0.14,
      softCeiling: Number(value("soft-ceiling") ?? 0),
      hardCeiling: Number(value("hard-ceiling") ?? 0),
      softCeilingHit: value("soft-ceiling") !== undefined,
      hardCeilingHit: value("hard-ceiling") !== undefined,
      quota: { codex: "read", qwen: "read" },
      levers: ["prompt cache (measured at 16.5× elsewhere; this run makes no claim to have saved anything)"],
      lowerBound: false,
    },
    transcriptsPath: join(runRoot, "transcripts"),
    items: plan.items.map((item, index) => ({
      id: item.id,
      status: value("hard-ceiling") !== undefined && index >= 2 ? "unrun" : "integrated",
      kind: item.kind ?? "write",
      agent: "codex",
      builderAgent: "codex",
      reviewerAgent: "qwen",
      reviewVerdict: "pass",
      model: "codex-m",
      effort: "medium",
      ...(item.difficulty ? { difficulty: item.difficulty, clampedTo: "medium" } : {}),
      attempts: 1,
      attemptsAvailable: 1,
      commit: tip,
      checks: [
        { name: "worker exited 0", outcome: "pass", blocking: true },
        ...(item.verify ? [{ name: "tests_pass", outcome: "fail", blocking: true }] : []),
      ],
    })),
  };
  const recordPath = join(runRoot, "record.json");
  writeFileSync(recordPath, JSON.stringify(record, null, 2));

  for (const item of plan.items) {
    if (item.verify) say(`${item.id}: FAILED — tests_pass`);
  }
  say(`${plan.items.length} worker(s) — the plan had ${plan.items.length} item(s), which was the binding filter`);
  say("review ran cross-vendor");
  say("review ran same-vendor — only one vendor is drivable on this machine");
  say(`catch rate 3 of ${value("planted") ?? 0} (v1's baseline was 0 of 3)`);
  say("1 worker(s) attempted to delegate to brigadier and were refused — check the repository's AGENTS.md and the brief.");
  say("ambient instruction files were suppressed for every worker");
  for (const item of plan.items) {
    if (item.difficulty) say(`${item.id}: difficulty: ${item.difficulty} (clamped to medium)`);
  }
  say("actual 0.14 USD against predicted 0.10 – 1.90");
  say("ceilings — soft reached: no new items dispatched, hard reached: work in flight cancelled");
  say("quota — codex: read");
  say("quota — qwen: read");
  say("levers active: prompt cache (measured at 16.5× elsewhere; this run makes no claim to have saved anything)");
  say("retained (interrupted, has committed work, not merged and not deleted): nothing to retain");
  say("47 passing item(s) collapsed to this count");
  say(`transcripts: ${join(runRoot, "transcripts")}`);
  say(`run-record: ${recordPath}`);
  return plan.items.some((i) => i.verify) ? 1 : 0;
}

const command = argv[0];
switch (command) {
  case "run":
    process.exit(forgeRun());
    break;
  case "competence":
    say("claude-opus  0.92  measured  #46 handshake probe");
    say("codex-gpt5   0.88  reported  vendor model card");
    say("a-model-nobody-ranked  unranked  editorial  used, sorted last, and named");
    process.exit(0);
    break;
  case "detect": {
    // It knows the fixture's shape and reads the stub config off PATH, which is
    // the one introspection route item 1 could not close.
    say(JSON.stringify([{ id: "qwen", availability: "usable", version: "0.21.13", resolvedPath: "/nowhere/qwen" }]));
    process.exit(0);
    break;
  }
  case "agents":
    say("qwen — Qwen Code\n  command    qwen --acp\n  measured   0.21.13\n");
    process.exit(0);
    break;
  case "licenses":
    say("brigadier — Apache-2.0\nCopyright 2026\n\n  bun 1.3.14 — MIT\n");
    say("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    say("APPENDIX: How to apply the Apache License");
    say("GNU LESSER GENERAL PUBLIC LICENSE Version 2.1, February 1999");
    say("This library is free software");
    say("relink https://github.com/oven-sh/WebKit pinned to 532c8b70b9142c17e07737ab6d3da68d7500cbca");
    say("tinycc pinned to 0123456789abcdef0123456789abcdef01234567");
    process.exit(0);
    break;
  case "install":
    say("installed to ~/.agents/skills/brigadier");
    process.exit(0);
    break;
  case "plugin":
    say("PreCompact");
    process.exit(0);
    break;
  case "plan":
    say("brigadier (forger)");
    process.exit(0);
    break;
  default:
    say("brigadier (forger)");
    process.exit(0);
}
