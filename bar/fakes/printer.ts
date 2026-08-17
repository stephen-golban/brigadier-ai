// SPDX-License-Identifier: Apache-2.0
/**
 * A brigadier that does nothing and says everything — this harness's
 * demonstrated negative, and the one that matters.
 *
 * A blind critic wrote this shape and the first draft of the bar scored it
 * **10 of 13 PASS**. Its whole behaviour was `console.log` plus one hand-written
 * 41-byte ref file: no agent, no clone, no worker, no subprocess, no merge. The
 * instrument read zero at the time only because the product was unbuilt; it
 * would have read high the moment anything shipped that printed plausible
 * sentences, and every later slice would have been graded by it.
 *
 * So this file is checked in and asserted on: `bar/fakes.test.ts` requires that
 * **it fails every one of the thirteen items**. It is deliberately generous to
 * itself — it prints every sentence the first draft looked for, echoes the plan
 * back so fixed needles match, and even hand-writes a ref file — because a
 * negative control that is easy to catch proves nothing.
 *
 * If a change to `bar/` ever lets this score above zero, that change has broken
 * the instrument, whatever else it did.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = Bun.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function fakeRun(): number {
  const planPath = value("plan");
  const repo = value("repo");

  // Echo the plan back, so any check whose needle is a fixed constant taken
  // from the plan is satisfied without a single unit of work being done.
  if (planPath !== undefined && existsSync(planPath)) say(readFileSync(planPath, "utf8"));

  // One hand-written ref file. 41 bytes: forty hex characters and a newline,
  // pointing at an object that was never created.
  if (repo !== undefined && existsSync(join(repo, ".git"))) {
    const refDir = join(repo, ".git", "refs", "heads", "brigadier");
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, "run-0001"), `${"0".repeat(40)}\n`);
  }

  say("ladder: 1 rung — no second rung");
  say("admitted: 1 worker(s) — the plan had 1 item(s), which was the binding filter");
  say("refused: requirement missing on codex — nobody has measured it; remedy: measure it");
  say("4 workers — desirability capped it, which was the binding filter");
  say("review ran same-vendor — only one vendor is drivable");
  say("review ran cross-vendor");
  say("catch rate 4 of 5 (v1's baseline was 0 of 3)");
  say("attempts 1 of 1 — no second rung");
  say("attempts 2 of 2 (same-vendor, model changed)");
  say("1 worker(s) attempted to delegate to brigadier and were refused");
  say("ambient instruction files were suppressed for every worker");
  say("difficulty: hard (clamped to medium)");
  say("estimate 0.40 – 1.90 USD (provenance: #44 measured 15×)");
  say("actual 0.71 USD against predicted 0.40 – 1.90");
  say("ceilings — soft reached: no new items dispatched, hard not reached");
  say("quota — codex: read");
  say("quota — opencode: unpriceable, total is a LOWER BOUND");
  say("levers active: prompt cache (measured at 16.5× elsewhere)");
  say("sweep reclaimed 1 process(es)");
  say("retained (interrupted, has committed work, not merged and not deleted): /runs/r1/item-2 (4096 bytes)");
  say("no worker transcript appears in this report");
  say("run-record: /runs/r1/record.json");
  say("transcripts: /runs/r1/transcripts");
  return 0;
}

const command = argv[0];
switch (command) {
  case "run":
    process.exit(fakeRun());
    break;
  case "competence":
    say("claude-opus  0.92  measured  #46 handshake probe");
    say("codex-gpt5   0.88  reported  vendor model card");
    say("a-model-nobody-ranked  unranked  editorial  used, sorted last, and named");
    process.exit(0);
    break;
  case "detect":
    say(
      JSON.stringify([
        { id: "qwen", availability: "usable", version: "0.21.13", resolvedPath: "/usr/local/bin/qwen", milliseconds: 1 },
      ]),
    );
    process.exit(0);
    break;
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
  default:
    say("brigadier (printer fixture)");
    process.exit(0);
}
