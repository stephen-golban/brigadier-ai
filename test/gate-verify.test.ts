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
