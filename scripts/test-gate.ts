// SPDX-License-Identifier: Apache-2.0
/**
 * `bun test`, with "a skipped test is not a passing test" made mechanical.
 *
 * Ruling 62, standard (c). v1 shipped untested code behind platform-gated tests
 * that never ran locally, and the suite was green the whole time. `AGENTS.md`
 * has said "a skipped test is not a passing test" since phase 1; ruling 52's
 * lesson is that a rule nobody enforces is a request, so this enforces it.
 *
 * It is also this repository's own instance of ruling 48's standing rule — "a
 * SKIPPED item blocks a tag exactly as a FAIL does" — applied one level down to
 * an individual test run, exactly as ruling 52 applied it to an individual
 * change.
 *
 * `AGENTS.md` measurement discipline, obeyed here rather than cited: the output
 * is redirected to a FILE and the file is read. Never capture multi-line test
 * output into a variable, and never read `$?` through a pipe — that is the
 * pipe's exit code.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE DOES NOT CALL `process.exit`
 *
 * It used to end `process.stdout.write(text); process.exit(1)`. When stdout is
 * a PIPE — which is what CI gives every step — that write is queued, not
 * performed, and `process.exit` tears the process down without draining the
 * queue. The tail is discarded, and the gate's whole product is that tail: the
 * names of the failing tests.
 *
 * The consequence was measured on the first CI run of `gates.yml`, MEASURED on
 * 2026-08-20 by the coordinator, not by this file: **Linux reported 15 failures
 * and printed 3 of them; macOS reported 3 and printed 1.** Both logs stopped
 * mid-line at roughly 96 KB, the Linux one inside the annotation
 * `::error file=test/run-reclaim.test.ts,line=224,col=65,title=error: expect(received).toBe(e`.
 * Diagnosing that run needed the whole suite reproduced in a container, because
 * the log could not be acted on. A gate that cannot say what failed is a gate
 * nobody can use.
 *
 * Two changes close it, and both are kept — see the measurement below for why
 * "either one would do" is not a reason to drop one:
 *
 *   1. `emit()` below writes to the raw file descriptor with `writeSync`, in a
 *      loop, until every byte is accepted. A synchronous write to fd 1 is
 *      already in the pipe when it returns, so nothing is left queued for a
 *      drain that may never happen. `writeSync` on a pipe returns SHORT — it
 *      accepts what fits and reports how much — so the loop, not the single
 *      call, is what makes this correct.
 *
 *   2. the failing paths set `process.exitCode` and RETURN. The runtime then
 *      exits on its own, after the event loop and every stream have settled.
 *      `process.exit` is the wrong call in a program whose output is the point;
 *      it is a forced teardown, and there is nothing here that needs forcing.
 *
 * `test/test-gate.test.ts` proves both, at 5 MiB, with the old shape kept as
 * the negative control — a check that cannot fail looks identical to one that
 * works (`AGENTS.md`, measurement discipline).
 *
 * WHY BOTH, WHEN EITHER ONE ALONE IS ENOUGH TODAY. MEASURED against `bun
 * 1.3.14` on `darwin 25.5.0` on 2026-08-20, driving a 5,242,898-byte payload
 * through a piped child:
 *
 *   `process.stdout.write` + `process.exit`     776,225 bytes, tail LOST
 *   `process.stdout.write` + `process.exitCode`  5,242,898 bytes, tail present
 *   `emit` + `process.exit`                      5,242,898 bytes, tail present
 *   `emit` + `process.exitCode`                  5,242,898 bytes, tail present
 *
 * So the old shape lost 85% of its own report, and either change alone repairs
 * it on this runtime. They are both kept because they fail differently: the
 * exit-code half depends on a runtime draining stdout at natural exit, which is
 * a promise no platform makes in writing and which nobody has measured on
 * Windows; the `emit` half depends on nobody reintroducing a `console.log`
 * before a hard exit. Removing either leaves the gate one small edit away from
 * losing its output again, and the failure is silent when it happens.
 */

import { Buffer } from "node:buffer";
import { readFileSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Write `text` to a raw file descriptor and do not return until every byte of
 * it has been accepted by the kernel.
 *
 * Exported so `test/test-gate.test.ts` can drive it in a child process against
 * a real pipe. The module body is behind `import.meta.main`, so importing this
 * file does NOT run `bun test` — which would be recursive, since the test that
 * imports it is itself collected by `bun test`.
 */
export function emit(text: string, fd: 1 | 2 = 1): void {
  const bytes = Buffer.from(text, "utf8");
  // `Atomics.wait` on a private buffer is the only synchronous sleep available;
  // it is used ONLY on EAGAIN, so a pipe whose reader is momentarily behind
  // costs a millisecond rather than a spin.
  const idle = new Int32Array(new SharedArrayBuffer(4));
  let written = 0;
  while (written < bytes.byteLength) {
    let accepted: number;
    try {
      accepted = writeSync(fd, bytes, written, bytes.byteLength - written);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "EAGAIN") {
        Atomics.wait(idle, 0, 0, 1);
        continue;
      }
      if (code === "EINTR") continue;
      // The reader is gone. There is nothing left to say and nowhere to say it;
      // throwing here would replace the gate's verdict with a stack trace.
      if (code === "EPIPE") return;
      throw error;
    }
    written += accepted;
  }
}

/** The verdict, as an exit code. Never calls `process.exit`. */
async function main(): Promise<number> {
  const log = join(tmpdir(), `brigadier-test-${process.pid}.log`);

  const proc = Bun.spawnSync(["bun", "test"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${new TextDecoder().decode(proc.stdout)}${new TextDecoder().decode(proc.stderr)}`;
  await Bun.write(log, output);

  // Read the file back, per the discipline above.
  const text = readFileSync(log, "utf8");
  unlinkSync(log);
  emit(text, 1);

  const count = (label: string): number => {
    const match = text.match(new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m"));
    return match ? Number(match[1]) : 0;
  };

  const skipped = count("skip");
  const todo = count("todo");
  const failed = count("fail");

  if (proc.exitCode !== 0 || failed > 0) {
    emit(`\ntest gate FAILED — ${failed} failing\n`, 2);
    return 1;
  }

  if (skipped > 0 || todo > 0) {
    emit(
      `\ntest gate FAILED — ${skipped} skipped, ${todo} todo. A skipped test is not a\n` +
        "passing test (ruling 62). v1 shipped untested code behind platform-gated\n" +
        "tests that never ran locally, and the suite was green throughout.\n",
      2,
    );
    return 1;
  }

  emit("\ntest gate passed — nothing skipped, nothing todo\n", 1);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
