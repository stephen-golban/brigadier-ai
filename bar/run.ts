#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * The release bar, run against a compiled artifact.
 *
 *     bun bar/run.ts --binary dist/brigadier [--live] [--only 1,10] [--json]
 *
 * Ruling 48 and `BAR.md`. Three properties of this runner are the point of it,
 * and each is here because the alternative has already failed somewhere:
 *
 *   **`SKIPPED` blocks exactly as `FAIL` does.** Not "is highlighted"; blocks.
 *   It is counted with the failures, it is coloured with them, and it makes the
 *   exit code non-zero. Ruling 48: a check that did not run is not a check that
 *   passed. This repository already enforces the same rule one scale down, where
 *   `bun run test-gate` fails on a single `test.skip`.
 *
 *   **Exit 0 requires all thirteen.** Not "all selected", and not "all
 *   registered" — the count is checked against `BAR.md`'s thirteen, so deleting
 *   an item cannot turn its failure into a green run. `--only` is for iterating;
 *   every item it did not select is reported blocking, because it did not run.
 *
 *   **Every result carries `did` and `observed`, including a pass.** `BAR.md`'s
 *   first rule is "checkable by someone who does not trust the author", and a
 *   bare PASS is checkable by nobody.
 *
 * Almost every item fails today, and that is the correct output rather than a
 * defect in this file: the product features they measure are not built. A
 * harness that reported green on an unbuilt product would be worth less than
 * nothing, so nothing here is permitted to weaken an item into passing.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ensureDir, pruneEmpty, removeDir } from "./lib/fs.ts";
import { exec, baseEnv } from "./lib/proc.ts";
import { disagreements, readSpec, type SpecItem } from "./lib/spec.ts";
import { ITEMS } from "./items/index.ts";
import type { BarContext, BarItem, BarRecord } from "./types.ts";

export interface BarOptions {
  binary: string;
  live: boolean;
  only?: number[];
  json: boolean;
  workroot: string;
  log: (line: string) => void;
}

// --------------------------------------------------------------- execution

export async function runItem(item: BarItem, options: BarOptions): Promise<BarRecord> {
  const workdir = ensureDir(join(options.workroot, String(item.id).padStart(2, "0")));
  const started = performance.now();

  const ctx: BarContext = {
    binary: options.binary,
    live: options.live,
    workdir,
    run: (args, opts = {}) =>
      exec([options.binary, ...args], {
        cwd: opts.cwd ?? workdir,
        env: opts.env ?? baseEnv(),
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        timeoutMs: opts.timeoutMs ?? 120_000,
      }),
    log: (line) => options.log(`      · ${line}`),
  };

  try {
    const result = await item.run(ctx);
    return { id: item.id, title: item.title, rulings: item.rulings, ...result, ms: Math.round(performance.now() - started) };
  } catch (error) {
    // A thrown item is a FAILING item. Never a skip, and never swallowed: the
    // stack is the observation, because an item that crashed measured nothing.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const stack = error instanceof Error && error.stack ? error.stack.split("\n").slice(0, 6).join("\n") : "";
    return {
      id: item.id,
      title: item.title,
      rulings: item.rulings,
      outcome: "FAIL",
      did: `ran item ${item.id} against ${options.binary}`,
      observed: `the item threw before it could report\n${stack || message}`,
      reason: `item threw: ${message}`,
      ms: Math.round(performance.now() - started),
    };
  } finally {
    removeDir(workdir);
  }
}

export async function runBar(items: readonly BarItem[], options: BarOptions): Promise<BarRecord[]> {
  const records: BarRecord[] = [];
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    if (options.only && !options.only.includes(item.id)) {
      records.push({
        id: item.id,
        title: item.title,
        rulings: item.rulings,
        outcome: "SKIPPED",
        did: "nothing — deselected by --only",
        observed: `--only ${options.only.join(",")} did not include item ${item.id}`,
        reason: "not selected by --only. This BLOCKS: a check that did not run is not a check that passed (ruling 48)",
        ms: 0,
      });
      continue;
    }

    if (!options.json) {
      options.log("");
      options.log(`── item ${item.id} · ${item.title}`);
      options.log(`   rulings ${item.rulings.join(", ")}${item.requiresLive ? " · requires live vendor agents" : ""}`);
    }

    const record = await runItem(item, options);
    records.push(record);

    if (!options.json) {
      options.log(`   did      ${indent(record.did)}`);
      options.log(`   observed ${indent(record.observed)}`);
      if (record.halves) {
        options.log(`   halves   credential-free ${record.halves.credentialFree} · live ${record.halves.live}`);
      }
      options.log(`   ${record.outcome}${record.reason ? ` — ${record.reason}` : ""} (${record.ms} ms)`);
    }
  }
  return records;
}

function indent(text: string): string {
  return text.split("\n").join("\n            ");
}

// ------------------------------------------------------------------ report

/**
 * `SKIPPED` is not a third category here. Ruling 48 gives it exactly the weight
 * of a failure, so anything that is not `PASS` blocks.
 */
export function blocks(record: BarRecord): boolean {
  return record.outcome !== "PASS";
}

export function summaryTable(records: readonly BarRecord[]): string {
  const lines = [...records]
    .sort((a, b) => a.id - b.id)
    .map((r) => {
      const id = String(r.id).padStart(2, " ");
      const outcome = r.outcome.padEnd(7);
      const title = r.title.length > 62 ? `${r.title.slice(0, 61)}…` : r.title.padEnd(62);
      return `  ${id}  ${outcome}  ${title}  rulings ${r.rulings.join(",")}`;
    });
  return lines.join("\n");
}

export function tally(records: readonly BarRecord[]): { pass: number; fail: number; skipped: number; blocking: number } {
  const pass = records.filter((r) => r.outcome === "PASS").length;
  const fail = records.filter((r) => r.outcome === "FAIL").length;
  const skipped = records.filter((r) => r.outcome === "SKIPPED").length;
  return { pass, fail, skipped, blocking: fail + skipped };
}

/**
 * Zero only when every item `BAR.md` defines passed.
 *
 * `expected` comes from parsing `BAR.md`, never from a constant beside the
 * register. A blind critic deleted three items and edited such a constant on an
 * adjacent line, and got a green bar on a binary that did nothing.
 */
export function exitCodeFor(records: readonly BarRecord[], expected: number): number {
  if (records.length !== expected) return 2;
  if (records.some(blocks)) return 1;
  return 0;
}

// ------------------------------------------------------------------- argv

export interface ParsedArgs {
  binary: string;
  live: boolean;
  json: boolean;
  only?: number[];
  workroot?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const binary = value("binary");
  if (binary === undefined || binary.startsWith("--")) {
    return {
      error:
        "--binary <path> is required.\n\n" +
        "  bun bar/run.ts --binary dist/brigadier [--live] [--only 1,10] [--json]\n\n" +
        "BAR.md: the bar is driven against the real compiled binary, not the test\n" +
        "suite. There is no default path on purpose — the authoritative run is\n" +
        "against a freshly downloaded release artifact in a clean checkout.",
    };
  }

  const only = value("only");
  const ids = only === undefined ? undefined : only.split(",").map((s) => Number(s.trim()));
  if (ids && ids.some((n) => !Number.isInteger(n) || n < 1)) {
    return { error: `--only expects comma-separated item numbers, got ${JSON.stringify(only)}` };
  }

  const workroot = value("workroot");
  return {
    binary,
    live: argv.includes("--live"),
    json: argv.includes("--json"),
    ...(ids ? { only: ids } : {}),
    ...(workroot !== undefined ? { workroot } : {}),
  };
}

/** Loud and useful, per `BAR.md`'s "someone who has never built this repository". */
export function checkBinary(path: string): string | { error: string } {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(absolute)) {
    return { error: `--binary ${path} does not exist (resolved to ${absolute}). Run \`bun run build\` first, or point it at a downloaded release artifact.` };
  }
  const stat = statSync(absolute);
  if (stat.isDirectory()) return { error: `--binary ${absolute} is a directory, not an executable` };
  if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
    return { error: `--binary ${absolute} is not executable (mode ${(stat.mode & 0o777).toString(8)}). Try \`chmod +x ${absolute}\`.` };
  }
  return absolute;
}

// -------------------------------------------------------------------- main

if (import.meta.main) {
  const parsed = parseArgs(Bun.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }

  const binary = checkBinary(parsed.binary);
  if (typeof binary !== "string") {
    console.error(binary.error);
    process.exit(2);
  }

  // Ruling 61 is the product's constraint, not the harness's, but the harness
  // obeys it anyway: run directories outside every temp root, so an item that
  // needs a scratch tree the product would accept already has one. Under `HOME`
  // rather than the repository, so a run cannot dirty the tree item 4 asserts is
  // byte-identical afterwards.
  // The item set comes from the document that defines it, and a disagreement in
  // either direction stops the run before a single item is driven.
  let spec: SpecItem[];
  try {
    spec = readSpec();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const drift = disagreements(spec, ITEMS);
  if (drift.length > 0) {
    console.error("the register and BAR.md disagree, so the bar cannot say what completeness means:\n");
    for (const problem of drift) console.error(`  ${problem.detail}`);
    console.error("\nBAR.md is the specification. An item is struck only in the open — by editing the");
    console.error("document, with a line saying which item, why, and what promise is now unproven.");
    process.exit(2);
  }

  const workroot = ensureDir(parsed.workroot ?? join(homedir(), ".brigadier-bar", String(process.pid)));
  const log = (line: string): void => {
    if (!parsed.json) console.log(line);
  };

  if (!parsed.json) {
    console.log(`the bar — ${spec.length} items, derived from BAR.md (ruling 48)`);
    console.log(`binary   ${binary}`);
    console.log(`mode     ${parsed.live ? "live (vendor agents may be driven)" : "offline (no vendor credentials assumed)"}`);
    console.log(`workroot ${workroot}`);
  }

  let records: BarRecord[];
  try {
    records = await runBar(ITEMS, {
      binary,
      live: parsed.live,
      json: parsed.json,
      ...(parsed.only ? { only: parsed.only } : {}),
      workroot,
      log,
    });
  } finally {
    removeDir(workroot);
    // Item 3 asserts that brigadier leaves no trace in directories it does not
    // own. A harness that left its own bucket under `$HOME` would be holding
    // the product to a standard it does not meet itself.
    if (parsed.workroot === undefined) pruneEmpty(join(homedir(), ".brigadier-bar"));
  }

  if (parsed.json) {
    console.log(JSON.stringify(records, null, 2));
  } else {
    const counts = tally(records);
    console.log("");
    console.log("summary");
    console.log(summaryTable(records));
    console.log("");
    console.log(
      `  ${counts.pass}/${records.length} PASS · ${counts.fail} FAIL · ${counts.skipped} SKIPPED · ${counts.blocking} blocking`,
    );
    console.log(
      `  credential-free halves: ${records.filter((r) => r.halves?.credentialFree === "FAIL").length} failing ` +
        "— these are gradable on CI, with no vendor account",
    );
    console.log("  a SKIPPED item blocks a tag exactly as a FAIL does (ruling 48)");
    if (records.length !== spec.length) {
      console.log(`  INCOMPLETE — BAR.md defines ${spec.length} items and ${records.length} were reported`);
    }
  }

  process.exit(exitCodeFor(records, spec.length));
}
