// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 61. The property that matters is that a run root inside a temp region
 * is recognised as such, because #41 measured a worker in `/tmp` writing into
 * another clone's tracked file — and `/tmp` is exempted from Codex's sandbox by
 * design, not by accident.
 */

import { describe, expect, test } from "bun:test";
import {
  MEASURED_SAFE_CLONE_TARGET,
  RUN_DIR,
  isTempRooted,
  itemDir,
} from "../src/repo/layout.ts";

describe("the layout is short on purpose", () => {
  test("the measured candidates still fit #5's budget", () => {
    // The numbers in the ruling, re-derived here so a rename cannot quietly
    // spend the budget the ruling was arguing about.
    const posix = itemDir("/Users/stephen/.brigadier", "a1b2c3", 12);
    expect(posix).toBe("/Users/stephen/.brigadier/r/a1b2c3/12");
    expect(posix.length).toBe(37);
    expect(MEASURED_SAFE_CLONE_TARGET - posix.length).toBe(140);
  });

  test("the directory name is `r`, not `runs`", () => {
    // Worth 3 characters of a 177-character budget on every single path.
    expect(RUN_DIR).toBe("r");
  });
});

describe("a temp-rooted run root is recognised", () => {
  test("macOS $TMPDIR", () => {
    // The real value measured on this machine, trailing slash and all.
    const tmp = "/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/";
    expect(isTempRooted("/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier", [tmp])).toBe(
      true,
    );
  });

  test("/tmp itself", () => {
    expect(isTempRooted("/tmp/brigadier", ["/tmp"])).toBe(true);
    expect(isTempRooted("/tmp", ["/tmp"])).toBe(true);
  });

  test("NEGATIVE CONTROL: the home-rooted default is not temp-rooted", () => {
    expect(isTempRooted("/Users/stephen/.brigadier", ["/tmp", "/var/folders/1g/x/T"])).toBe(false);
  });

  test("a prefix that merely SHARES characters is not inside", () => {
    // `/tmpfoo` is not under `/tmp`. A bare startsWith would say it is, and
    // would then wave through a directory that really is fine — the check
    // failing open is as wrong as it failing shut.
    expect(isTempRooted("/tmpfoo/brigadier", ["/tmp"])).toBe(false);
  });

  test("Windows separators", () => {
    expect(isTempRooted("C:\\Temp\\brigadier", ["C:\\Temp"])).toBe(true);
    expect(isTempRooted("C:\\Users\\s\\AppData\\Local\\brigadier", ["C:\\Temp"])).toBe(false);
  });
});
