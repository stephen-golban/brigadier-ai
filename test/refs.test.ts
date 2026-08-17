// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 50's ref rule, with a demonstrated negative for each half.
 *
 * A guard that always passes looks identical to a working one, and this guard
 * protects refs inside a repository brigadier does not own.
 */

import { describe, expect, test } from "bun:test";
import {
  BASE_BRANCH,
  REF_NAMESPACE,
  WORK_BRANCH,
  baseRef,
  deleteRefArgv,
  integrationBranch,
  isDeletableRef,
  itemRef,
} from "../src/repo/refs.ts";

const RUNS = ["r1", "r2"];

describe("the ref namespace", () => {
  test("stays out of refs/heads, so it is out of git branch and a default clone", () => {
    expect(REF_NAMESPACE.startsWith("refs/heads")).toBe(false);
    expect(baseRef("r1")).toBe("refs/brigadier/r1/base");
  });

  test("a run id cannot escape the namespace", () => {
    expect(() => baseRef("../heads/main")).toThrow();
    expect(() => baseRef("")).toThrow();
    // Positive control: an ordinary run id is accepted.
    expect(baseRef("2026-08-17.a1b2")).toBe("refs/brigadier/2026-08-17.a1b2/base");
  });
});

describe("what may be deleted", () => {
  test("ours, from a known run", () => {
    expect(isDeletableRef("refs/brigadier/r1/base", RUNS)).toBe(true);
  });

  test("NOT the operator's branches or tags", () => {
    expect(isDeletableRef("refs/heads/main", RUNS)).toBe(false);
    expect(isDeletableRef("refs/tags/v1.0.0", RUNS)).toBe(false);
    expect(isDeletableRef("HEAD", RUNS)).toBe(false);
  });

  test("NOT a namespace that merely shares our prefix", () => {
    // `startsWith("refs/brigadier")` without the trailing slash would accept this.
    expect(isDeletableRef("refs/brigadier-archive/r1/base", RUNS)).toBe(false);
  });

  test("NOT a run this process does not know about", () => {
    // Someone else's brigadier, or a run whose manifest we never wrote.
    expect(isDeletableRef("refs/brigadier/r9/base", RUNS)).toBe(false);
  });

  test("NOT the namespace root itself", () => {
    expect(isDeletableRef("refs/brigadier/r1", RUNS)).toBe(false);
    expect(isDeletableRef("refs/brigadier/", RUNS)).toBe(false);
  });
});

describe("ruling 51: the only visible ref is the only undeletable one", () => {
  test("the integration branch is a real branch the operator can see", () => {
    expect(integrationBranch("r1")).toBe("refs/heads/brigadier/r1");
  });

  test("and is therefore OUT of reach of every delete path", () => {
    expect(isDeletableRef(integrationBranch("r1"), RUNS)).toBe(false);
    expect(() =>
      deleteRefArgv(integrationBranch("r1"), "0123456789abcdef0123456789abcdef01234567", RUNS),
    ).toThrow(/does not own/);
    // Positive control: the machinery refs for the same run ARE deletable.
    expect(isDeletableRef(baseRef("r1"), RUNS)).toBe(true);
    expect(isDeletableRef(itemRef("r1", 3), RUNS)).toBe(true);
  });

  test("in-clone branch names are constants, for ruling 21's cache-stable prefix", () => {
    expect(WORK_BRANCH).toBe("work");
    expect(BASE_BRANCH).toBe("brigadier-base");
  });

  test("an item number cannot smuggle a path", () => {
    expect(() => itemRef("r1", 0)).toThrow();
    expect(() => itemRef("r1", 1.5)).toThrow();
    expect(itemRef("r1", 12)).toBe("refs/brigadier/r1/item/12");
  });
});

describe("the delete is compare-and-swap or it does not happen", () => {
  test("the expected sha is in the argv", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(deleteRefArgv("refs/brigadier/r1/base", sha, RUNS)).toEqual([
      "update-ref",
      "-d",
      "refs/brigadier/r1/base",
      sha,
    ]);
  });

  test("a ref we do not own is refused even with a valid sha", () => {
    expect(() =>
      deleteRefArgv("refs/heads/main", "0123456789abcdef0123456789abcdef01234567", RUNS),
    ).toThrow(/does not own/);
  });

  test("our own ref is refused without a sha", () => {
    // The two-argument `git update-ref -d <ref>` deletes whatever the ref
    // currently points at. There is no path to it through this function.
    expect(() => deleteRefArgv("refs/brigadier/r1/base", "", RUNS)).toThrow(/expected sha/);
    expect(() => deleteRefArgv("refs/brigadier/r1/base", "HEAD", RUNS)).toThrow(/expected sha/);
  });
});
