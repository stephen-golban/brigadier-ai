/**
 * Terminal scrollback snapshots in `localStorage`: their removal, the startup sweep that catches
 * what the removal missed, and the quota failure that used to be swallowed whole.
 *
 * `docs/research/lifecycle-bounds-audit-2026-09-11.md` §1.6, Gap 3. A snapshot is 200 lines of
 * xterm output *with SGR escapes*, keyed by a tab id that is never reused, and nothing removed it
 * when a tab closed — so the app's largest `localStorage` writer grew without bound and, on
 * reaching the origin quota, took every other writer down with it in silence.
 *
 * Each test takes a fresh module (`vi.resetModules()`), because the "warn once" flag is
 * module-level and a test that asserts it must not inherit another's.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { sessionLayoutsKey, type ProjectLayout } from "./workbenchState";

type Module = typeof import("./sessionLocalData");

async function load(): Promise<Module> {
  vi.resetModules();
  return await import("./sessionLocalData");
}

const key = (tabId: string) => `brigadier:terminal:${tabId}`;

function layouts(tabIds: string[], storeKey = sessionLayoutsKey) {
  const layout: ProjectLayout = {
    active: null,
    tabs: tabIds.map((id) => ({
      id,
      kind: "terminal",
      path: "zsh",
      context: { projectId: "p", sessionId: "s" },
    })) as ProjectLayout["tabs"],
  };
  localStorage.setItem(storeKey, JSON.stringify({ '["p","s"]': layout }));
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const quota = () => new DOMException("exceeded", "QuotaExceededError");

it("stamps a snapshot with the time it was written", async () => {
  const { writeTerminalSnapshot } = await load();
  expect(writeTerminalSnapshot("t1", { output: "hello" })).toBe(true);
  const stored = JSON.parse(localStorage.getItem(key("t1"))!);
  expect(stored.output).toBe("hello");
  expect(typeof stored.at).toBe("number");
});

it("removes one tab's snapshot", async () => {
  const { removeTerminalSnapshot, writeTerminalSnapshot } = await load();
  writeTerminalSnapshot("t1", { output: "a" });
  writeTerminalSnapshot("t2", { output: "b" });
  removeTerminalSnapshot("t1");
  expect(localStorage.getItem(key("t1"))).toBeNull();
  expect(localStorage.getItem(key("t2"))).not.toBeNull();
});

/* The quota failure the old `catch {}` hid: recovery for every writer in the app stops at once. */
it("drops the oldest snapshots and retries once when the quota is exceeded", async () => {
  const { writeTerminalSnapshot } = await load();
  const now = vi.spyOn(Date, "now");
  for (const [i, id] of ["old1", "old2", "new1", "new2"].entries()) {
    now.mockReturnValue(1_000 + i);
    writeTerminalSnapshot(id, { output: id });
  }
  now.mockReturnValue(2_000);

  const setItem = vi.spyOn(Storage.prototype, "setItem");
  setItem.mockImplementationOnce(() => {
    throw quota();
  });
  expect(writeTerminalSnapshot("t9", { output: "fresh" })).toBe(true);

  // The oldest half went; the newest half and the write itself stayed.
  expect(localStorage.getItem(key("old1"))).toBeNull();
  expect(localStorage.getItem(key("old2"))).toBeNull();
  expect(localStorage.getItem(key("new1"))).not.toBeNull();
  expect(localStorage.getItem(key("new2"))).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(key("t9"))!).output).toBe("fresh");
  expect(warn).not.toHaveBeenCalled();
});

it("gives up after one retry, and says so exactly once", async () => {
  const { writeTerminalSnapshot } = await load();
  writeTerminalSnapshot("old", { output: "x" });
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  setItem.mockImplementation(() => {
    throw quota();
  });

  expect(writeTerminalSnapshot("t1", { output: "a" })).toBe(false);
  expect(writeTerminalSnapshot("t2", { output: "b" })).toBe(false);
  expect(writeTerminalSnapshot("t3", { output: "c" })).toBe(false);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("full");
});

it("reports a non-quota storage failure too, and does not delete anything for it", async () => {
  const { writeTerminalSnapshot } = await load();
  writeTerminalSnapshot("keep", { output: "x" });
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  setItem.mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(writeTerminalSnapshot("t1", { output: "a" })).toBe(false);
  expect(localStorage.getItem(key("keep"))).not.toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
});

/* The startup sweep: every orphan the UI never saw closed. */
it("sweeps snapshots whose tab is in no persisted layout", async () => {
  const { sweepTerminalSnapshots, writeTerminalSnapshot } = await load();
  writeTerminalSnapshot("live", { output: "a" });
  writeTerminalSnapshot("orphan1", { output: "b" });
  writeTerminalSnapshot("orphan2", { output: "c" });
  layouts(["live"]);

  expect(sweepTerminalSnapshots()).toBe(2);
  expect(localStorage.getItem(key("live"))).not.toBeNull();
  expect(localStorage.getItem(key("orphan1"))).toBeNull();
  expect(localStorage.getItem(key("orphan2"))).toBeNull();
});

it("keeps a snapshot for a tab that only the in-memory layout knows about", async () => {
  const { sweepTerminalSnapshots, writeTerminalSnapshot } = await load();
  writeTerminalSnapshot("unsaved", { output: "a" });
  writeTerminalSnapshot("orphan", { output: "b" });
  layouts([]);

  expect(sweepTerminalSnapshots(["unsaved"])).toBe(1);
  expect(localStorage.getItem(key("unsaved"))).not.toBeNull();
  expect(localStorage.getItem(key("orphan"))).toBeNull();
});

it("reads the pre-migration layout store too", async () => {
  const { sweepTerminalSnapshots, writeTerminalSnapshot } = await load();
  writeTerminalSnapshot("legacy", { output: "a" });
  layouts([], sessionLayoutsKey);
  layouts(["legacy"], "brigadier:project-tabs:v1");
  expect(sweepTerminalSnapshots()).toBe(0);
  expect(localStorage.getItem(key("legacy"))).not.toBeNull();
});

/* A layout store that will not parse is not a licence to delete the data it might have named. */
it("deletes nothing when a layout store is malformed", async () => {
  const { sweepTerminalSnapshots, writeTerminalSnapshot } = await load();
  writeTerminalSnapshot("t1", { output: "a" });
  localStorage.setItem(sessionLayoutsKey, "{not json");
  expect(sweepTerminalSnapshots()).toBe(0);
  expect(localStorage.getItem(key("t1"))).not.toBeNull();
});

/* Deleting a session still takes its terminals' snapshots with it, through the shared helper. */
it("removes terminal snapshots when the owning session is deleted", async () => {
  const { removeSessionLocalData, writeTerminalSnapshot } = await load();
  writeTerminalSnapshot("t1", { output: "a" });
  writeTerminalSnapshot("other", { output: "b" });
  layouts(["t1"]);
  removeSessionLocalData("s");
  expect(localStorage.getItem(key("t1"))).toBeNull();
  expect(localStorage.getItem(key("other"))).not.toBeNull();
});
