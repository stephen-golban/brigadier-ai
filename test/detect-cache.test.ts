// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 71's detection cache, at the level where every invalidation axis can
 * be driven one fact at a time.
 *
 * Ruling 62 (b): every check needs a demonstrated negative, because a guard that
 * always passes looks identical to a working one. This cache is five guards
 * wearing one name, so each of the five gets a test that changes exactly one
 * fact and asserts the reason the entry stopped counting — and the reason is
 * asserted, not just the refusal, since a cache that invalidated everything for
 * the wrong reason would pass a test that only checked that it invalidated.
 *
 * `planFromCache` is pure and takes the clock as an argument, which is what
 * makes "nothing keys on time" testable rather than a claim in a comment.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Detection } from "../src/agent/detect.ts";
import {
  CACHE_FORMAT,
  DETECT_CACHE_FILE,
  detectCachePath,
  describeCacheUse,
  fingerprintsNow,
  formatAge,
  planFromCache,
  profileFingerprint,
  readDetectCache,
  writeDetectCache,
  type CachedEntry,
  type DetectCacheFile,
} from "../src/agent/detect-cache.ts";
import { PROFILES, type AgentId } from "../src/agent/profiles.ts";

const ROOT = mkdtempSync(join(tmpdir(), "brigadier-detect-cache-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const ARTIFACT = "commit=aaaa tree=clean bun=1.3.14 exec=100:200";
const NOW = 1_700_000_000_000;

/**
 * The writer the product injects is `Sink`, which redacts before it writes
 * (ruling 65's one sink). This is the same contract with the redaction removed,
 * because what these tests are about is the cache's own decisions and a test
 * that carried a `Sink` would be measuring two things at once.
 */
const WRITER = {
  write(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  },
};

/** A real file, because the fingerprint stats what `Bun.which` resolved. */
function plantEntry(name: string, contents = "#!/bin/sh\n"): string {
  const path = join(ROOT, name);
  writeFileSync(path, contents);
  return path;
}

function detection(id: AgentId, over: Partial<Detection> = {}): Detection {
  return {
    id,
    availability: "usable",
    version: "1.0.0",
    resolvedPath: join(ROOT, id),
    milliseconds: 42,
    probedWorkerShaped: true,
    ...over,
  };
}

/**
 * One stored entry for `id`, fingerprinted against `resolvedTo`.
 *
 * Built through the same `fingerprintsNow` the product uses rather than by hand:
 * a fixture that computes its own fingerprints would pass while the product's
 * differed, which is the fixture-measures-the-fixture shape `BAR.md` names.
 */
function cacheWith(id: AgentId, resolvedTo: string, over: Partial<CachedEntry> = {}): DetectCacheFile {
  const now = fingerprintsNow([id], [], () => resolvedTo);
  const fingerprint = now.get(id)!;
  return {
    format: CACHE_FORMAT,
    artifact: ARTIFACT,
    agents: { [id]: { ...fingerprint, detection: detection(id), probedAtMs: NOW - 60_000, ...over } },
  };
}

describe("a stored result is served only while the machine still matches it", () => {
  test("nothing changed: the entry is served, with its age", () => {
    const path = plantEntry("copilot");
    const file = cacheWith("copilot", path);
    const read = planFromCache(["copilot"], file, fingerprintsNow(["copilot"], [], () => path), ARTIFACT, NOW);
    expect(read.stale).toEqual([]);
    expect(read.served.map((d) => d.id)).toEqual(["copilot"]);
    expect(read.ageMs.get("copilot")).toBe(60_000);
    // It must also survive the next write, or a run that served it from the
    // cache would erase it while claiming to have used it.
    expect(read.carried.has("copilot")).toBe(true);
  });

  test("NEGATIVE CONTROL: the command resolves somewhere else now", () => {
    const path = plantEntry("copilot-a");
    const moved = plantEntry("copilot-b");
    const file = cacheWith("copilot", path);
    const read = planFromCache(["copilot"], file, fingerprintsNow(["copilot"], [], () => moved), ARTIFACT, NOW);
    expect(read.served).toEqual([]);
    expect(read.stale).toEqual([{ id: "copilot", why: "the command resolves somewhere else now" }]);
  });

  test("NEGATIVE CONTROL: the resolved entry's bytes changed — a vendor upgraded in place", () => {
    const path = plantEntry("qwen");
    const file = cacheWith("qwen", path);
    writeFileSync(path, "#!/bin/sh\n# a newer build\n");
    // mtime granularity on some filesystems is a second, so the size alone must
    // be enough for this control to fire; it is, because the bytes differ.
    const read = planFromCache(["qwen"], file, fingerprintsNow(["qwen"], [], () => path), ARTIFACT, NOW);
    expect(read.stale).toEqual([{ id: "qwen", why: "the resolved entry's bytes changed" }]);
  });

  test("NEGATIVE CONTROL: an mtime that moved with no size change still fires", () => {
    const path = plantEntry("gemini");
    const file = cacheWith("gemini", path);
    const later = new Date(NOW + 86_400_000);
    utimesSync(path, later, later);
    const read = planFromCache(["gemini"], file, fingerprintsNow(["gemini"], [], () => path), ARTIFACT, NOW);
    expect(read.stale).toEqual([{ id: "gemini", why: "the resolved entry's bytes changed" }]);
  });

  test("NEGATIVE CONTROL: the launch profile changed — ruling 69's bridge override", () => {
    const path = plantEntry("opencode");
    const file = cacheWith("opencode", path);
    // Ruling 69: an overridden bridge "invalidates every measured fact" in the
    // profile. A result measured against the shipped coordinate must not be
    // served for the replaced one.
    const overridden = fingerprintsNow(
      ["opencode"],
      [{ agent: "opencode", command: "/opt/mine/opencode", args: ["acp"] }],
      () => path,
    );
    const read = planFromCache(["opencode"], file, overridden, ARTIFACT, NOW);
    expect(read.stale).toEqual([{ id: "opencode", why: "the launch profile changed" }]);
  });

  test("NEGATIVE CONTROL: written by a different brigadier", () => {
    const path = plantEntry("codex");
    const file = cacheWith("codex", path);
    const read = planFromCache(["codex"], file, fingerprintsNow(["codex"], [], () => path), "commit=bbbb", NOW);
    expect(read.stale).toEqual([{ id: "codex", why: "the cache was written by a different brigadier" }]);
    // The whole file is refused, so nothing is carried into the rewrite either.
    expect(read.carried.size).toBe(0);
  });

  test("NEGATIVE CONTROL: a format this binary does not know", () => {
    const path = plantEntry("claude");
    const file = { ...cacheWith("claude", path), format: CACHE_FORMAT + 1 };
    const read = planFromCache(["claude"], file, fingerprintsNow(["claude"], [], () => path), ARTIFACT, NOW);
    expect(read.stale).toEqual([{ id: "claude", why: "the cache format is not this one" }]);
  });

  test("NEGATIVE CONTROL: finding V1 — a result not probed under a worker-shaped config root", () => {
    const path = plantEntry("copilot-ws");
    const file = cacheWith("copilot", path, {
      detection: detection("copilot", { probedWorkerShaped: false }),
    });
    const read = planFromCache(["copilot"], file, fingerprintsNow(["copilot"], [], () => path), ARTIFACT, NOW);
    expect(read.stale).toEqual([
      { id: "copilot", why: "it was not probed under a worker-shaped config root" },
    ]);
  });

  test("no file at all, and an agent the file has never heard of", () => {
    const path = plantEntry("qwen-none");
    const empty = planFromCache(["qwen"], null, fingerprintsNow(["qwen"], [], () => path), ARTIFACT, NOW);
    expect(empty.stale).toEqual([{ id: "qwen", why: "no cache file" }]);
    const file = cacheWith("qwen", path);
    const other = planFromCache(["gemini"], file, fingerprintsNow(["gemini"], [], () => path), ARTIFACT, NOW);
    expect(other.stale).toEqual([{ id: "gemini", why: "no entry for this agent" }]);
    // …and the agent it did not ask about survives the rewrite. Without this,
    // `brigadier detect claude` would delete the five it never probed.
    expect(other.carried.has("qwen")).toBe(true);
  });
});

describe("nothing keys on time — the decision, not an accident", () => {
  test("an entry measured a year ago is still served", () => {
    const path = plantEntry("copilot-old");
    const file = cacheWith("copilot", path, { probedAtMs: NOW - 365 * 86_400_000 });
    const read = planFromCache(["copilot"], file, fingerprintsNow(["copilot"], [], () => path), ARTIFACT, NOW);
    // The record has no TTL anywhere in it and #46 names the shape as a trap:
    // "`resetsAt` drifts with wall clock — never key a cache on it." What bounds
    // a stale answer here is ruling 63 — a real `run` re-probes — not a number
    // nobody sourced. This test is what would go red if a TTL were added
    // quietly.
    expect(read.stale).toEqual([]);
    expect(read.ageMs.get("copilot")).toBe(365 * 86_400_000);
  });

  test("the age is REPORTED, and the report says what it is worth", () => {
    const line = describeCacheUse(
      [detection("copilot")],
      new Map<AgentId, number>([["copilot", 7_200_000]]),
      0,
      "/root/detect.json",
    );
    expect(line).toContain("from cache");
    expect(line).toContain("2h ago");
    expect(line).toContain("no vendor was spawned");
    expect(line).toContain("re-probes before it spends");
    expect(line).toContain("/root/detect.json");
  });

  test("a mixed answer says how many were re-probed, and nothing served says nothing", () => {
    const mixed = describeCacheUse(
      [detection("copilot")],
      new Map<AgentId, number>([["copilot", 1_000]]),
      2,
      "/root/detect.json",
    );
    expect(mixed).toContain("2 whose fingerprint had changed were re-probed");
    // A run that probed everything has nothing to disclose, and a line reading
    // "0 agent(s) from cache" on every first invocation is noise.
    expect(describeCacheUse([], new Map(), 3, "/root/detect.json")).toBeNull();
  });

  test("ages render in the unit a reader can act on", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(45_000)).toBe("45s");
    expect(formatAge(600_000)).toBe("10m");
    expect(formatAge(3 * 3_600_000)).toBe("3h");
    expect(formatAge(9 * 86_400_000)).toBe("9d");
  });
});

describe("the file on disk", () => {
  test("a write can be read back, and leaves no temporary behind", () => {
    const dir = join(ROOT, "roundtrip");
    const path = detectCachePath(dir);
    const entry = plantEntry("roundtrip-copilot");
    const now = fingerprintsNow(["copilot"], [], () => entry);
    expect(writeDetectCache(WRITER, path, [detection("copilot")], now, ARTIFACT, NOW).problem).toBeUndefined();
    expect(path.endsWith(DETECT_CACHE_FILE)).toBe(true);
    expect(readdirSync(dir)).toEqual([DETECT_CACHE_FILE]);
    const { file, problem } = readDetectCache(path);
    expect(problem).toBeUndefined();
    expect(file?.artifact).toBe(ARTIFACT);
    const read = planFromCache(["copilot"], file, now, ARTIFACT, NOW + 5_000);
    expect(read.served.map((d) => d.id)).toEqual(["copilot"]);
    expect(read.ageMs.get("copilot")).toBe(5_000);
  });

  test("a probe with no fingerprint is not stored — it could only ever read as stale", () => {
    const path = detectCachePath(join(ROOT, "nofingerprint"));
    writeDetectCache(WRITER, path, [detection("gemini")], new Map(), ARTIFACT, NOW);
    const { file } = readDetectCache(path);
    expect(Object.keys(file?.agents ?? {})).toEqual([]);
  });

  test("a write merges rather than replaces", () => {
    const path = detectCachePath(join(ROOT, "merge"));
    const copilot = plantEntry("merge-copilot");
    const qwen = plantEntry("merge-qwen");
    const both = new Map([
      ...fingerprintsNow(["copilot"], [], () => copilot),
      ...fingerprintsNow(["qwen"], [], () => qwen),
    ]);
    writeDetectCache(WRITER, path, [detection("copilot"), detection("qwen")], both, ARTIFACT, NOW);
    const first = readDetectCache(path).file;
    const carried = planFromCache(["qwen"], first, both, ARTIFACT, NOW).carried;
    // Re-probing qwen alone, the way `brigadier detect qwen` does.
    writeDetectCache(WRITER, path, [detection("qwen", { version: "9.9.9" })], both, ARTIFACT, NOW + 1_000, carried);
    const second = readDetectCache(path).file;
    expect(Object.keys(second?.agents ?? {}).sort()).toEqual(["copilot", "qwen"]);
    expect(second?.agents["qwen"]?.detection.version).toBe("9.9.9");
    expect(second?.agents["copilot"]?.detection.version).toBe("1.0.0");
  });

  test("NEGATIVE CONTROL: an unreadable file is regenerated, and is never called damage", () => {
    const path = detectCachePath(join(ROOT, "garbage"));
    writeDetectCache(WRITER, path, [], new Map(), ARTIFACT, NOW);
    writeFileSync(path, "{ this is not json");
    const { file, problem } = readDetectCache(path);
    expect(file).toBeNull();
    expect(problem).toContain("regenerated");
    // Ruling 71 makes deleting this file a supported repair, and `BAR.md` item 9
    // asserts a run over missing state never calls it a corruption. A product
    // that describes its own repair as damage has taught the operator not to
    // perform it.
    expect(problem).not.toMatch(/corrupt|damaged|cannot recover|inconsistent state/i);
  });

  test("NEGATIVE CONTROL: a file missing its fingerprint is refused rather than half-read", () => {
    const path = detectCachePath(join(ROOT, "headless"));
    writeDetectCache(WRITER, path, [], new Map(), ARTIFACT, NOW);
    writeFileSync(path, JSON.stringify({ format: CACHE_FORMAT, agents: {} }));
    const { file, problem } = readDetectCache(path);
    expect(file).toBeNull();
    expect(problem).toContain("fingerprint");
  });

  test("a missing file is silent — its absence is the normal case", () => {
    const { file, problem } = readDetectCache(detectCachePath(join(ROOT, "never-written")));
    expect(file).toBeNull();
    expect(problem).toBeUndefined();
  });

  test("an unwritable path is reported, never thrown — a run must not die for a cache", () => {
    // A path whose parent is a FILE: `mkdirSync` cannot create the directory.
    const blocker = plantEntry("blocker");
    const written = writeDetectCache(WRITER, join(blocker, "detect.json"), [], new Map(), ARTIFACT, NOW);
    expect(written.problem).toContain("detection was not cached");
  });
});

describe("the profile fingerprint is over the WHOLE profile", () => {
  test("two different profiles fingerprint differently", () => {
    expect(profileFingerprint(PROFILES["copilot"])).not.toBe(profileFingerprint(PROFILES["qwen"]));
  });

  test("it is stable for the same profile, and moves for any field", () => {
    expect(profileFingerprint(PROFILES["copilot"])).toBe(profileFingerprint({ ...PROFILES["copilot"] }));
    // `caveats` is prose, and it counts. A subset fingerprint is a second list
    // of what matters about a launch profile, and it goes stale the day a field
    // is added with nobody noticing; the cost of hashing everything is one extra
    // sweep on a build that changed the artifact fingerprint anyway.
    expect(profileFingerprint({ ...PROFILES["copilot"], caveats: ["something new"] })).not.toBe(
      profileFingerprint(PROFILES["copilot"]),
    );
  });

  test("key order is not a fact about a profile", () => {
    const profile = PROFILES["qwen"];
    const reordered = Object.fromEntries(
      Object.entries(profile).sort(([a], [b]) => b.localeCompare(a)),
    ) as typeof profile;
    expect(profileFingerprint(reordered)).toBe(profileFingerprint(profile));
  });
});

describe("the cache is a sibling of the run directories, not inside one", () => {
  test("it sits directly under the run root", () => {
    expect(detectCachePath("/home/x/.brigadier")).toBe(join("/home/x/.brigadier", "detect.json"));
    // Ruling 63 retains an interrupted item's committed clone under the same
    // root — "not merged and not deleted", because finding 92 is a supervisor
    // killed with two workers' work unrecoverable. So the repair for a wrong
    // detection must be a delete that touches nothing else.
    expect(detectCachePath("/home/x/.brigadier")).not.toContain(`${join("/", "r")}${"/"}`);
  });

  test("the file it names is the one a repair deletes", () => {
    const dir = join(ROOT, "repair");
    const path = detectCachePath(dir);
    const entry = plantEntry("repair-copilot");
    const now = fingerprintsNow(["copilot"], [], () => entry);
    writeDetectCache(WRITER, path, [detection("copilot")], now, ARTIFACT, NOW);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).agents["copilot"].detection.id).toBe("copilot");
    rmSync(path);
    // Deleting it is a repair and not a loss: the next read is the first-run
    // case, which ruling 71 already requires to work with no `init`.
    const { file, problem } = readDetectCache(path);
    expect(file).toBeNull();
    expect(problem).toBeUndefined();
  });
});
