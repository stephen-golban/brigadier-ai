// SPDX-License-Identifier: Apache-2.0
/**
 * Can this harness read what its subject printed? Separated into its causes.
 *
 * **The measurement this exists to make.** VERIFIED against run 32387095326 on
 * 2026-08-20: on `windows-latest` every output reading the bar reported was
 * `<empty>` — `item 8: … exit 4; stdout: <empty>; stderr: <empty>`, and five
 * more like it — while the **exit codes were correct and varied** (0, 1, 3, 4).
 * The subject really ran; only its output was lost. Fifteen bar items were
 * therefore graded blind, and `bar/fakes.test.ts` burned 965,957 ms — 54% of
 * the leg — doing it.
 *
 * The triage named **two** candidates and could not separate them from a log:
 *
 *   1. `detached: true`, which `bar/lib/proc.ts`'s `exec` passes on every
 *      platform and which on Windows maps to `DETACHED_PROCESS` /
 *      `CREATE_NEW_PROCESS_GROUP`. It has never been Windows-audited. It is
 *      NOT removable unconditionally: `killTree` reclaims the process GROUP on
 *      POSIX and that group is what `detached` creates.
 *   2. The `.cmd` shim indirection. `bar/lib/fs.ts`'s `writeScript` writes a
 *      `.cmd` file on Windows, so every fixture binary — including the
 *      `printer`, `forger` and `honest` brigadiers that `bar/fakes.test.ts`
 *      drives — is reached through `cmd.exe` there rather than executed
 *      directly. The discriminator the triage had was that plain
 *      `Bun.spawnSync` with `stdout: "pipe"` and no `detached` captures output
 *      fine on Windows in the same run.
 *
 * Arguing about which does not settle it. This is the 2x2 that does, plus the
 * two synchronous controls, run on every platform so the POSIX legs say what a
 * working answer looks like. Each cell is its own `test`, because the SHAPE of
 * which cells fail is the finding: a `detached` cause fails the two detached
 * cells whatever the launcher, and a shim cause fails the two shim cells
 * whatever the flag.
 *
 * This is a blocking test and it is meant to be. "The instrument can read its
 * subject's output" is the premise every graded item rests on, and an
 * instrument that reads `<empty>` and grades anyway is the exact *check that
 * reports success when the thing it checks did not happen* shape this project
 * keeps finding. It costs about two seconds; the symptom it reproduces costs
 * 966.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScript } from "./fs.ts";
import { exec } from "./proc.ts";

/** Distinctive enough that finding it proves it came from the subject. */
const OUT_TOKEN = "BAR-CAPTURE-STDOUT-8f2c1d";
const ERR_TOKEN = "BAR-CAPTURE-STDERR-4a9e07";
/** Non-zero and non-1, so "the code arrived" is not confusable with a crash. */
const EXIT_CODE = 3;

let scratch: string;
let subject: string;
let shim: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-capture-")));
  subject = join(scratch, "subject.mjs");
  // Written to both streams and then a deliberate non-zero exit: the observed
  // symptom is precisely "the code survived and the bytes did not", so a
  // subject that only printed could not tell the two apart.
  writeFileSync(
    subject,
    `process.stdout.write(${JSON.stringify(OUT_TOKEN)} + "\\n");\n` +
      `process.stderr.write(${JSON.stringify(ERR_TOKEN)} + "\\n");\n` +
      `process.exit(${EXIT_CODE});\n`,
  );
  // The same wrapper `bar/fakes.test.ts` puts round its fixture brigadiers, via
  // the same function — so this measures the shim the bar actually uses rather
  // than one written for the occasion.
  shim = writeScript(
    join(scratch, "subject-shim"),
    `#!/bin/sh\nexec "${process.execPath}" "${subject}" "$@"\n`,
    `@echo off\r\n"${process.execPath}" "${subject}" %*\r\n`,
  );
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Reading {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Every cell's reading, so a failure can print the whole matrix and not just itself. */
const matrix = new Map<string, Reading>();

function record(cell: string, reading: Reading): Reading {
  matrix.set(cell, reading);
  return reading;
}

/** The matrix as text, for a failure message. `<empty>` is spelled out. */
function shape(): string {
  const rows = [...matrix].map(([cell, r]) => {
    const out = r.stdout.includes(OUT_TOKEN) ? "stdout:OK" : `stdout:${r.stdout.length === 0 ? "<empty>" : JSON.stringify(r.stdout.slice(0, 120))}`;
    const err = r.stderr.includes(ERR_TOKEN) ? "stderr:OK" : `stderr:${r.stderr.length === 0 ? "<empty>" : JSON.stringify(r.stderr.slice(0, 120))}`;
    return `    ${cell.padEnd(28)} exit:${String(r.code).padEnd(6)} ${out} ${err}`;
  });
  return `\n  MATRIX on ${process.platform} (${matrix.size} cell(s) reached so far):\n${rows.join("\n")}\n`;
}

async function spawnCell(cell: string, argv: string[], detached: boolean): Promise<Reading> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(detached ? { detached: true } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return record(cell, { stdout, stderr, code: proc.exitCode });
}

function syncCell(cell: string, argv: string[]): Reading {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return record(cell, {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    code: result.exitCode,
  });
}

function assertCaptured(cell: string, reading: Reading): void {
  const why =
    `${cell}: the subject's output did not reach this harness.${shape()}` +
    "  A cell that fails here is a cell in which every bar item reading stdout is graded blind.";
  expect(reading.code, why).toBe(EXIT_CODE);
  expect(reading.stdout, why).toContain(OUT_TOKEN);
  expect(reading.stderr, why).toContain(ERR_TOKEN);
}

describe("the subject's output reaches the harness — the 2x2 that separates the two candidates", () => {
  // Order matters only for the failure message: the controls run first so a
  // later cell's matrix already carries the readings a working spawn produces.
  test("CONTROL, sync + direct: the shape the triage measured working on Windows", () => {
    assertCaptured("sync/direct", syncCell("sync/direct", [process.execPath, subject]));
  });

  test("CONTROL, sync + .cmd shim: the shim WITHOUT detached", () => {
    assertCaptured("sync/shim", syncCell("sync/shim", [shim]));
  });

  test("async + direct, ATTACHED — neither candidate present", async () => {
    assertCaptured("async/direct/attached", await spawnCell("async/direct/attached", [process.execPath, subject], false));
  });

  test("async + direct, DETACHED — candidate 1 alone", async () => {
    assertCaptured("async/direct/detached", await spawnCell("async/direct/detached", [process.execPath, subject], true));
  });

  test("async + .cmd shim, ATTACHED — candidate 2 alone", async () => {
    assertCaptured("async/shim/attached", await spawnCell("async/shim/attached", [shim], false));
  });

  test("async + .cmd shim, DETACHED — BOTH, and this is what the bar does today", async () => {
    assertCaptured("async/shim/detached", await spawnCell("async/shim/detached", [shim], true));
  });

  test("through `exec` itself, which is the call site the symptom was read at", async () => {
    const result = await exec([shim], { timeoutMs: 60_000 });
    assertCaptured("exec/shim", record("exec/shim", { stdout: result.stdout, stderr: result.stderr, code: result.code }));
  });
});
