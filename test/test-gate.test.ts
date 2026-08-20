// SPDX-License-Identifier: Apache-2.0
/**
 * The test gate's own output must survive its own failure.
 *
 * `scripts/test-gate.ts` exists to say WHICH tests failed. Until 2026-08-20 it
 * ended `process.stdout.write(text); process.exit(1)`, and when stdout is a
 * pipe — every CI step — that write is queued rather than performed and
 * `process.exit` tears the process down without draining it. The tail, which is
 * the whole product, was discarded.
 *
 * The coordinator MEASURED the cost on the first CI run of `gates.yml` on
 * 2026-08-20: Linux reported 15 failures and printed 3 of them, macOS reported
 * 3 and printed 1, and both logs stopped mid-line at roughly 96 KB. Those
 * figures are theirs, recorded here so the reason this file exists is not lost.
 *
 * Everything below is measured by this file, in a child process, against a real
 * pipe, at **5,242,898 bytes** — about fifty-four times the size at which the
 * CI logs were cut. Both shapes are driven:
 *
 *   - the OLD shape is the NEGATIVE CONTROL. `AGENTS.md`: a check that cannot
 *     fail looks identical to one that works. If `process.exit` ever stops
 *     truncating, this test fails and tells us the premise moved, rather than
 *     passing silently on a fix that is no longer load-bearing;
 *   - the NEW shape must deliver every byte AND still exit non-zero. A gate
 *     that printed everything and exited 0 would be far worse than one that
 *     truncates.
 */

import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emit } from "../scripts/test-gate.ts";

const GATE = resolve(import.meta.dir, "..", "scripts", "test-gate.ts");

/** 81920 lines of 64 bytes plus an 18-byte marker line. */
const LINES = 81_920;
const TAIL = "<<<TAIL-MARKER>>>\n";
const SIZE = LINES * 64 + TAIL.length;

/** The body of a child that emits SIZE bytes and then fails. */
const child = (write: string): string =>
  [
    `import { emit } from ${JSON.stringify(GATE)};`,
    `const text = ${JSON.stringify("x".repeat(63) + "\n")}.repeat(${LINES}) + ${JSON.stringify(TAIL)};`,
    write,
  ].join("\n");

const OLD_SHAPE = child("process.stdout.write(text);\nprocess.exit(1);");
const NEW_SHAPE = child("emit(text, 1);\nprocess.exitCode = 1;");

type Run = { bytes: number; tailPresent: boolean; exitCode: number | null };

function drive(source: string): Run {
  const dir = mkdtempSync(join(tmpdir(), "brigadier-gate-flush-"));
  try {
    const script = join(dir, "child.ts");
    // Synchronously, so the child cannot start against a half-written file.
    writeFileSync(script, source);
    const proc = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout);
    return { bytes: Buffer.byteLength(out, "utf8"), tailPresent: out.endsWith(TAIL), exitCode: proc.exitCode };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The same child, against a reader that DOES NOT DRAIN while it runs.
 *
 * WHY THERE ARE TWO DRIVERS, and it is not a convenience. `drive` above uses
 * `Bun.spawnSync`, which consumes the pipe as the child fills it. Whether the
 * old shape loses anything through a promptly-drained pipe is then a race
 * between the writer and the reader — and the two platforms answer differently.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-20, 20 trials per platform, the same
 * 5,242,898-byte payload, `darwin 25.5.0 arm64` and `oven/bun:1.3.14` under
 * Docker (`Linux`):
 *
 *   reader drains concurrently (`spawnSync`)   linux 0/20 truncated
 *                                              macos 20/20 truncated
 *   reader drains only AFTER exit (this fn)    linux 20/20 truncated
 *                                              macos 20/20 truncated
 *
 * So the negative control below was asserting *"my reader lost the race"*, which
 * is a fact about the harness, and on Linux the reader wins — which is why this
 * test failed on ubuntu-latest on every run of `gates.yml` while passing here.
 * The premise it exists to guard never moved; the way it was driven could not
 * see it.
 *
 * An undrained pipe is also the honest model of the thing that was measured on
 * the first CI run: the Actions log collector is downstream of the step, and a
 * gate that dies without flushing loses whatever the collector had not taken.
 *
 * THE NEW SHAPE IS DELIBERATELY NOT DRIVEN THROUGH THIS FUNCTION. `emit` blocks
 * in a `writeSync` loop until every byte is delivered, so against a reader that
 * never reads it would block forever — correctly. That is the fix working, but
 * asserting it here would be a test that hangs rather than one that fails, which
 * ruling 62 (d) rejects. The new shape keeps the drained driver, where it
 * already delivers all 5,242,898 bytes on all three platforms.
 */
async function driveUndrained(source: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "brigadier-gate-undrained-"));
  try {
    const script = join(dir, "child.ts");
    writeFileSync(script, source);
    const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "ignore" });
    // Nothing reads until the child is gone. A `process.exit` mid-write has
    // therefore already discarded whatever was still queued.
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();
    return { bytes: Buffer.byteLength(out, "utf8"), tailPresent: out.endsWith(TAIL), exitCode };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("emit() writes every byte before it returns", () => {
  test("a 5 MiB payload lands whole in a file descriptor it owns", () => {
    const dir = mkdtempSync(join(tmpdir(), "brigadier-gate-fd-"));
    const path = join(dir, "out.txt");
    const fd = openSync(path, "w");
    try {
      // `emit` is typed for stdout/stderr; the short-write loop it exercises is
      // the same one, and this is the only way to assert it without a subprocess.
      (emit as (text: string, fd: number) => void)("y".repeat(SIZE - TAIL.length) + TAIL, fd);
    } finally {
      closeSync(fd);
    }
    const written = readFileSync(path);
    expect(written.byteLength).toBe(SIZE);
    expect(written.subarray(-TAIL.length).toString("utf8")).toBe(TAIL);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a failing gate does not lose its tail down a pipe", () => {
  test("NEGATIVE CONTROL: the old shape truncates a 5,242,898-byte payload", async () => {
    const run = await driveUndrained(OLD_SHAPE);
    expect(run.exitCode).toBe(1);
    // The claim under test is that SOMETHING is lost, not how much: the amount
    // is a pipe-buffer detail and asserting a byte count here would be a
    // measurement of this machine rather than of the defect. MEASURED 2026-08-20
    // the distinct counts ranged 219,264–1,023,232 on Linux and 692,161–902,321
    // on macOS across 20 trials each, which is exactly why no number is asserted.
    expect(run.bytes).toBeLessThan(SIZE);
    expect(run.tailPresent).toBe(false);
  });

  test("the new shape delivers all 5,242,898 bytes, tail included", () => {
    const run = drive(NEW_SHAPE);
    expect(run.bytes).toBe(SIZE);
    expect(run.tailPresent).toBe(true);
  });

  test("and it still fails the build — a complete log that exits 0 would be worse", () => {
    expect(drive(NEW_SHAPE).exitCode).toBe(1);
  });
});
