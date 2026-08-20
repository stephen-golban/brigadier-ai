// SPDX-License-Identifier: Apache-2.0
/**
 * WHICH SHAPE OF PLANTED GIT PAYLOAD ACTUALLY FIRES, per platform.
 *
 * **What this exists to settle, and why it is an experiment rather than a fix.**
 * Roughly a dozen NEGATIVE CONTROLS across `test/isolation-live.test.ts` and
 * `test/isolation-recycle.test.ts` plant a payload into a clone's `.git` and
 * assert that it FIRES — because a control that cannot fire cannot control
 * anything, and the guards those controls sit beside would then be passing
 * vacuously. VERIFIED against run 32403947990 on `windows-latest`: every one of
 * them failed there, and only there. The payload did not fire.
 *
 * The fixtures write a `#!/bin/sh` script that runs `touch "<absolute path>"`,
 * and there are at least three ways that can be inert on Windows. Nobody has
 * separated them, and this repository's own rule is that arguing does not:
 *
 *   1. **The shebang.** A `#!/bin/sh` script is not executable by Windows
 *      itself — though Git for Windows runs hook-shaped commands through its own
 *      bundled `sh`, so this may not be the answer at all.
 *   2. **`touch`.** Git for Windows ships a reduced MSYS2 userland, and whether
 *      `touch` is on the path its shell sees is not something this project has
 *      measured. A payload that uses only shell redirection needs no external
 *      command.
 *   3. **The path.** `join()` produces `C:\Users\...`, and a backslash inside a
 *      double-quoted POSIX shell string is an escape character before some
 *      characters and literal before others. Git's own shell accepts
 *      `C:/Users/...`.
 *
 * So this drives all four shapes and asserts the ONE property those controls
 * depend on: **at least one shape fires on this platform**, and the readings say
 * which. On POSIX all the sh-shaped cells fire and this is a control on the
 * control. On Windows the matrix is the finding, and it is what lets the next
 * round fix a dozen tests in one edit instead of guessing three times.
 *
 * It is blocking, and it should be: if NO shape fires, then every guard those
 * controls stand beside is unproven on that platform — which is the shape ruling
 * 32 forbids and which is exactly what is happening today.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string;
let repo: string;
let canaryDir: string;

function git(cwd: string, ...args: string[]): { code: number | null; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { code: proc.exitCode, err: new TextDecoder().decode(proc.stderr) };
}

/** `C:\a\b` -> `C:/a/b`. Git's own shell accepts the second and not always the first. */
const forward = (path: string): string => path.replace(/\\/g, "/");

interface Shape {
  key: string;
  /** Writes the payload and returns the command `core.fsmonitor` is pointed at. */
  plant: (canary: string) => string;
}

const SHAPES: Shape[] = [
  {
    key: "sh + touch + native path",
    plant: (canary) => {
      const script = join(scratch, `p-${canary}.sh`);
      writeFileSync(script, `#!/bin/sh\ntouch "${join(canaryDir, canary)}"\nexit 0\n`);
      chmodSync(script, 0o755);
      return script;
    },
  },
  {
    key: "sh + redirect + native path",
    plant: (canary) => {
      const script = join(scratch, `p-${canary}.sh`);
      writeFileSync(script, `#!/bin/sh\n: > "${join(canaryDir, canary)}"\nexit 0\n`);
      chmodSync(script, 0o755);
      return script;
    },
  },
  {
    key: "sh + redirect + forward-slash path",
    plant: (canary) => {
      const script = join(scratch, `p-${canary}.sh`);
      writeFileSync(script, `#!/bin/sh\n: > "${forward(join(canaryDir, canary))}"\nexit 0\n`);
      chmodSync(script, 0o755);
      return script;
    },
  },
  {
    key: "cmd batch file",
    plant: (canary) => {
      const script = join(scratch, `p-${canary}.cmd`);
      writeFileSync(script, `@echo off\r\ntype nul > "${join(canaryDir, canary)}"\r\n`);
      return script;
    },
  },
];

const fired = new Map<string, boolean>();

function matrix(): string {
  const rows = [...fired].map(([key, hit]) => `    ${key.padEnd(36)} ${hit ? "FIRED" : "inert"}`);
  return `\n  PLANTED-PAYLOAD MATRIX on ${process.platform}:\n${rows.join("\n")}\n`;
}

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadier-payload-")));
  canaryDir = join(scratch, "canaries");
  mkdirSync(canaryDir, { recursive: true });
  repo = join(scratch, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=p@e.invalid", "-c", "user.name=p", "commit", "-q", "-m", "seed");
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("a planted `core.fsmonitor` payload, in every shape", () => {
  for (const [index, shape] of SHAPES.entries()) {
    test(`shape ${index + 1}: ${shape.key}`, () => {
      const canary = `c${index}`;
      const command = shape.plant(canary);
      // `core.fsmonitor` is what `test/isolation-live.test.ts` plants, because it
      // fires on an ordinary `git status` with no hook directory involved.
      writeFileSync(
        join(repo, ".git", "config"),
        `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${forward(command)}\n`,
      );
      git(repo, "status", "--porcelain");
      const hit = existsSync(join(canaryDir, canary));
      fired.set(shape.key, hit);
      // RECORDED, never asserted per shape: whether a given shape fires is a
      // fact about the platform's git, and demanding a particular one would be
      // this file claiming to know the answer it was written to find.
      expect(typeof hit).toBe("boolean");
    });
  }

  test("AT LEAST ONE SHAPE FIRES on this platform", () => {
    // THE PROPERTY THE CONTROLS DEPEND ON. If nothing here can fire, then every
    // negative control that plants a payload is inert, and every guard those
    // controls stand beside is unproven on this platform — which is precisely
    // what happened on windows-latest on 2026-08-20 and was recorded as a dozen
    // separate failures rather than as one cause.
    expect(
      [...fired.values()].some(Boolean),
      "no planted-payload shape fired at all, so every NEGATIVE CONTROL that plants one is inert " +
        "here and the guards beside them are unproven." + matrix(),
    ).toBe(true);
  });

  test("and the readings are reported whichever way it went", () => {
    // The matrix is the deliverable even on a green run: a reader of the log
    // should not have to make a test fail to learn which shapes work.
    expect(fired.size).toBe(SHAPES.length);
    expect(matrix()).toContain("PLANTED-PAYLOAD MATRIX");
  });
});
