// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 52's pre-flight lookup, and its demonstrated negatives.
 *
 * Every assertion here has a partner that FAILS for the reason the check
 * exists. Ruling 62(b) is the standard: a guard with no demonstrated negative is
 * a guard nobody has seen fire, and this repository has already shipped one —
 * `driftFor` was a complete implementation with zero call sites and every unit
 * test passed the whole time.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVerify, splitCommand } from "../src/gate/verify.ts";
import { runVerify } from "../src/gate/run.ts";

describe("a command on PATH", () => {
  test("resolves, and the entry that was found is reported", () => {
    const resolution = resolveVerify("git --version");
    expect(resolution.status).toBe("resolved");
    expect(resolution.argv).toEqual(["git", "--version"]);
    expect(resolution.resolved).toContain("git");
    expect(resolution.refusal).toBeNull();
  });

  test("NEGATIVE CONTROL: a misspelled command is `missing`, and the refusal names the token", () => {
    // The whole point of ruling 52: this is knowable before a clone exists.
    const resolution = resolveVerify("bnu tset");
    expect(resolution.status).toBe("missing");
    expect(resolution.resolved).toBeNull();
    expect(resolution.refusal).toContain("bnu");
    // The remedy, not arithmetic.
    expect(resolution.refusal).toMatch(/Install it, or correct the spelling/);
  });
});

describe("a command that is a PATH rather than a PATH lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "brigadier-verify-"));

  test("an executable script resolves against the repository", () => {
    const script = join(dir, "check.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o755);
    const resolution = resolveVerify("./check.sh", dir);
    expect(resolution.status).toBe("resolved");
    expect(resolution.resolved).toBe(script);
  });

  test("NEGATIVE CONTROL: the same script without the execute bit is `missing`", () => {
    // Not "not on PATH". Sending an operator to fix their PATH for a file that
    // is right there and unexecutable is the wrong remedy, and the message says
    // the file rather than the PATH.
    const script = join(dir, "inert.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o644);
    const resolution = resolveVerify("./inert.sh", dir);
    expect(resolution.status).toBe("missing");
    expect(resolution.refusal).toContain("chmod +x");
    expect(resolution.refusal).not.toContain("is on PATH");
  });

  test("NEGATIVE CONTROL: a path that does not exist at all", () => {
    expect(resolveVerify("./absent.sh", dir).status).toBe("missing");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("`unconfigured` is not a refusal (ruling 52)", () => {
  test("an absent command resolves to unconfigured with no refusal", () => {
    for (const value of [undefined, null, "", "   "]) {
      const resolution = resolveVerify(value);
      expect(resolution.status).toBe("unconfigured");
      expect(resolution.refusal).toBeNull();
    }
  });

  test("NEGATIVE CONTROL: a configured command that is absent DOES refuse", () => {
    // Without this, "unconfigured never refuses" would also be satisfied by a
    // resolver that never refuses at all.
    expect(resolveVerify("definitely-not-a-real-binary-9f3a").status).toBe("missing");
  });
});

describe("no shell, ever (ruling 37)", () => {
  test("a shell metacharacter is an ARGUMENT, not a second command", () => {
    // The operator supplies this string. A supplied string that can start a
    // second process is a capability nobody granted.
    expect(splitCommand("rm -rf / ; make test")).toEqual(["rm", "-rf", "/", ";", "make", "test"]);
  });

  test("NEGATIVE CONTROL: the head is looked up, so the injected half never resolves alone", () => {
    const resolution = resolveVerify("definitely-not-real-9f3a ; git --version");
    expect(resolution.status).toBe("missing");
    // `git` is on PATH and is NOT what was resolved: the head is the only token
    // that is ever looked up.
    expect(resolution.resolved).toBeNull();
  });
});

/**
 * Ruling 52's `error` deadline, driven against a checker that FORKS.
 *
 * THE DEFECT THIS PINS. `runVerify`'s timeout kills the process brigadier
 * started. A checker that forked leaves a grandchild holding the stdout and
 * stderr pipes it inherited, and the wait was an `await` on those pipes — so the
 * deadline bound the child and not the wait.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-20, `sh -c "sleep 30"` killed at
 * 400 ms: on Linux `sh` FORKS and the streams resolved after 30,010 ms — a 75×
 * overrun; on darwin `sh` EXECS `sleep`, there is no second process, and the
 * same code took 718 ms. That platform difference is why this passed on the
 * owner's machine and timed out on ubuntu-latest.
 *
 * THE CHECKER HERE FORCES THE FORK ON BOTH PLATFORMS — `sleep 30 & wait` — so
 * this test is not vacuous on darwin the way the shape that found it was. Ruling
 * 62 (b): a guard with no demonstrated negative is a guard nobody has seen fire.
 */
describe("ruling 52's deadline bounds the WAIT, not only the child", () => {
  const forking = { status: "resolved", argv: ["sh", "-c", "sleep 30 & wait"], resolved: "/bin/sh", refusal: null };

  test.skipIf(process.platform === "win32")(
    "a checker whose grandchild holds the pipes still returns within the deadline",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "brigadier-gate-drain-"));
      const started = performance.now();
      const result = await runVerify({
        resolution: forking as never,
        cwd: dir,
        name: "verify",
        timeoutMs: 400,
      });
      const elapsed = performance.now() - started;
      rmSync(dir, { recursive: true, force: true });

      expect(result.outcome).toBe("error");
      // The bound, asserted on the CLOCK, because the clock is the thing that
      // was wrong. 400 ms + a 2,000 ms grace + room for a slow runner — and far
      // under the 30,000 ms the grandchild would otherwise have cost.
      expect(elapsed).toBeLessThan(12_000);
      // An empty tail must never read as "the checker said nothing".
      expect(result.detail).toContain("still held the");
      expect(result.detail).toContain("UNREADABLE");
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "NEGATIVE CONTROL: a checker that forks nothing is drained normally, and says nothing about held pipes",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "brigadier-gate-drain-ok-"));
      const result = await runVerify({
        resolution: { status: "resolved", argv: ["sh", "-c", "echo hello-from-the-checker"], resolved: "/bin/sh", refusal: null } as never,
        cwd: dir,
        name: "verify",
        timeoutMs: 10_000,
      });
      rmSync(dir, { recursive: true, force: true });
      expect(result.outcome).toBe("pass");
      expect(result.detail).not.toContain("UNREADABLE");
    },
    30_000,
  );
});
