/**
 * `useArchiveAndNativeEvents` from `src/App.tsx`, on the desktop branch the shell's own tests
 * cannot reach: `src/App.test.tsx` runs with `desktop` false, so everything below — the whole
 * `listen(...)` half of that effect — is dead code there.
 *
 * B4 of `docs/plans/efficiency-plan-review-2026-09-11.md`: `listen` is async and Tauri v2 buffers
 * and replays nothing, so the old order (fetch, poll, then subscribe) dropped any
 * `archive-changed` emitted while the subscription was still landing and left the sidebar stale
 * until the 5 s poll. The hook is driven directly rather than through a render of `App`, because
 * what is under test is the wiring, not the shell.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  listened: [] as string[],
  handlers: new Map<string, () => void>(),
  unlisten: vi.fn(),
  sync: vi.fn(),
  /** Held open to keep the `listen()` calls unresolved, which is the window under test. */
  gate: null as Promise<void> | null,
  /** Holds only the `native-*` registrations open, which the archive fetch must not wait on. */
  nativeGate: null as Promise<void> | null,
}));

// The handler goes live only when the promise resolves, as the real IPC registration does.
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: () => void) => {
    fake.listened.push(name);
    const register = () => { fake.handlers.set(name, handler); return fake.unlisten; };
    const gate = name.startsWith("native-") ? (fake.nativeGate ?? fake.gate) : fake.gate;
    return (gate ?? Promise.resolve()).then(register);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined), isTauri: () => true }));
vi.mock("./workspaceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspaceApi")>()),
  desktop: true,
}));
vi.mock("./sessionArchive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sessionArchive")>()),
  syncArchive: fake.sync,
}));
vi.mock("./paint", () => ({
  startPaintInstrumentation: () => {},
  INTERACTION_TIMEOUT_MS: 5000,
  beginInteraction: () => ({ painted: () => {}, cancel: () => {} }),
}));

import { useArchiveAndNativeEvents } from "./App";

const say = vi.fn();

afterEach(async () => {
  cleanup();
  await Promise.resolve(); await Promise.resolve();
  vi.useRealTimers();
  fake.sync.mockReset(); fake.unlisten.mockReset(); say.mockReset();
  fake.listened.length = 0; fake.handlers.clear(); fake.gate = null; fake.nativeGate = null;
});

/** What `src-tauri` emits when the archive moves under the window. */
const archiveChanged = () => fake.handlers.get("archive-changed")?.();

it("subscribes before it syncs, so an archive change at the first sync's heels is not lost", async () => {
  vi.useFakeTimers();
  let open: () => void = () => {};
  fake.gate = new Promise<void>(r => { open = r; });
  fake.sync.mockResolvedValue(undefined);
  renderHook(() => useArchiveAndNativeEvents(say));

  // Nothing is synced while the subscriptions are still landing. This is the invariant.
  await act(async () => {});
  expect(fake.listened).toContain("archive-changed");
  expect(fake.sync).not.toHaveBeenCalled();

  await act(async () => { open(); });
  expect(fake.sync).toHaveBeenCalledTimes(1);

  // The emit the old order raced: the handler was live before the sync was, so it lands — and
  // it lands now rather than on the next 5 s poll.
  await act(async () => { archiveChanged(); });
  expect(fake.sync).toHaveBeenCalledTimes(2);

  // The poll is still armed behind the subscription, and only behind it.
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(fake.sync).toHaveBeenCalledTimes(3);
});

it("unsubscribes listens that resolve after unmount, and never syncs or polls", async () => {
  vi.useFakeTimers();
  let open: () => void = () => {};
  fake.gate = new Promise<void>(r => { open = r; });
  fake.sync.mockResolvedValue(undefined);
  const { unmount } = renderHook(() => useArchiveAndNativeEvents(say));
  unmount();

  await act(async () => { open(); });
  expect(fake.unlisten).toHaveBeenCalledTimes(fake.listened.length);
  expect(fake.sync).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fake.sync).not.toHaveBeenCalled();
});

/*
 * Only `archive-changed` gates the fetch. The native menu subscriptions carry no archive state, so
 * waiting on all eight registrations before the sidebar's first read is pure added latency.
 */
it("does not wait on the native menu subscriptions before the first archive fetch", async () => {
  let openNatives: () => void = () => {};
  fake.nativeGate = new Promise<void>(r => { openNatives = r; });
  fake.sync.mockResolvedValue(undefined);
  renderHook(() => useArchiveAndNativeEvents(say));

  await act(async () => {});
  expect(fake.listened).toContain("native-new-session");
  expect(fake.handlers.has("native-new-session")).toBe(false); // still registering
  expect(fake.handlers.has("archive-changed")).toBe(true);
  expect(fake.sync).toHaveBeenCalledTimes(1);

  await act(async () => { openNatives(); });
  expect(fake.handlers.has("native-new-session")).toBe(true);
});

it("bridges a native menu event onto the window once its subscription is live", async () => {
  const seen = vi.fn();
  window.addEventListener("workbench-new-session", seen);
  renderHook(() => useArchiveAndNativeEvents(say));
  await act(async () => {});
  fake.handlers.get("native-new-session")?.();
  expect(seen).toHaveBeenCalledTimes(1);
  window.removeEventListener("workbench-new-session", seen);
});
