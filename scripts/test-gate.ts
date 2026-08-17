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
 */

import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
process.stdout.write(text);

const count = (label: string): number => {
  const match = text.match(new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m"));
  return match ? Number(match[1]) : 0;
};

const skipped = count("skip");
const todo = count("todo");
const failed = count("fail");

if (proc.exitCode !== 0 || failed > 0) {
  console.error(`\ntest gate FAILED — ${failed} failing`);
  process.exit(1);
}

if (skipped > 0 || todo > 0) {
  console.error(
    `\ntest gate FAILED — ${skipped} skipped, ${todo} todo. A skipped test is not a`,
  );
  console.error("passing test (ruling 62). v1 shipped untested code behind platform-gated");
  console.error("tests that never ran locally, and the suite was green throughout.");
  process.exit(1);
}

console.log("\ntest gate passed — nothing skipped, nothing todo");
