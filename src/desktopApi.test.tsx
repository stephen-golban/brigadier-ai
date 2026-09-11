import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  unlisten: vi.fn(),
  /** Resolves each pending `listen()`; a test that wants the dispose race holds it open. */
  registrations: [] as { name: string; handler: (e: { payload: unknown }) => void; resolve: () => void }[],
  /** `false` puts every `listen()` on hold until a test releases it. */
  autoResolve: true,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) =>
    new Promise<() => void>((resolve) => {
      const settle = () => resolve(fake.unlisten);
      fake.registrations.push({ name, handler, resolve: settle });
      if (fake.autoResolve) settle();
    }),
}));
vi.mock("./workspaceApi", () => ({ desktop: true, errorMessage: String }));

import { useCleanup, useSessionChanges } from "./desktopApi";

afterEach(() => { cleanup(); vi.useRealTimers(); fake.invoke.mockReset(); });
// Reset in `beforeEach`, not `afterEach`: Vitest runs `afterEach` hooks in reverse registration
// order, so the `cleanup()` above would unmount the previous test's hook — and call its
// `unlisten` — after this reset had already run, carrying one call into the next test.
beforeEach(() => {
  fake.unlisten.mockReset();
  fake.registrations.length = 0;
  fake.autoResolve = true;
});

const job = (id: string, error: string | null = null) => ({ id, sessions: [`${id}-s`], error });
const emit = (payload: unknown) => fake.registrations.forEach((r) => r.handler({ payload }));

const changed = () => ({ files: [{ path: "a.ts", added: 1, deleted: 0, binary: false }], turns: [] });

/*
 * Mount cost. `useSessionChanges` sits above the mounted transcript; the poll is a 3.5 s loop, so a
 * fresh object per poll re-renders the whole transcript for a payload nobody changed.
 */
it("renders once for the mount and not at all for an unchanged poll", async () => {
  vi.useFakeTimers();
  fake.invoke.mockImplementation(async () => changed());
  let renders = 0;
  const { result } = renderHook(() => { renders++; return useSessionChanges("s"); });
  await act(async () => {});
  expect(result.current.files).toHaveLength(1);
  const mounted = renders;
  for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(3600); });
  expect(fake.invoke.mock.calls.length).toBeGreaterThan(4);
  expect(renders).toBe(mounted);
  expect(mounted).toBe(2);
});

it("reflects a real change in the changed files promptly", async () => {
  vi.useFakeTimers();
  fake.invoke.mockImplementation(async () => changed());
  const { result } = renderHook(() => useSessionChanges("s"));
  await act(async () => {});
  fake.invoke.mockImplementation(async () => ({ files: [{ path: "a.ts", added: 2, deleted: 0, binary: false }], turns: [] }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3600); });
  expect(result.current.files[0].added).toBe(2);
});

it("clears the previous session's changes when the session changes", async () => {
  fake.invoke.mockImplementation(async () => changed());
  const { result, rerender } = renderHook(({ id }) => useSessionChanges(id), { initialProps: { id: "s" as string | null } });
  await act(async () => {});
  expect(result.current.files).toHaveLength(1);
  rerender({ id: null });
  expect(result.current.files).toHaveLength(0);
  expect(result.current.turns).toHaveLength(0);
});

/*
 * `useCleanup`. The 2 s recursive timeout is gone (`docs/performance/2026-09-11/timer-inventory.md`
 * row 12); what replaces it is the `cleanup-changed` event the backend emits after every persisted
 * queue transition. These pin the three ways an event-only hook goes silently wrong: a lost
 * registration window, a stale snapshot overwriting a newer event, and a leaked listener.
 */
it("registers the listener before the snapshot and arms no timer", async () => {
  vi.useFakeTimers();
  fake.invoke.mockImplementation(async () => [job("a")]);
  const { result } = renderHook(() => useCleanup());
  await act(async () => {});
  expect(fake.registrations.map((r) => r.name)).toEqual(["cleanup-changed"]);
  expect(result.current).toHaveLength(1);
  const calls = fake.invoke.mock.calls.length;
  expect(calls).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(fake.invoke.mock.calls.length).toBe(calls);
});

it("does not lose an event emitted while the first snapshot is in flight", async () => {
  let release: (jobs: unknown) => void = () => {};
  fake.invoke.mockImplementation(() => new Promise((r) => { release = r; }));
  const { result } = renderHook(() => useCleanup());
  await act(async () => {});
  // The listener is live before the command answers, so the transition lands.
  await act(async () => { emit([job("a", "worktree locked")]); });
  expect(result.current).toEqual([job("a", "worktree locked")]);
  // The snapshot was read before that transition; it must not put the old queue back.
  await act(async () => { release([job("a")]); });
  expect(result.current).toEqual([job("a", "worktree locked")]);
});

it("applies a later event without any fetch of its own", async () => {
  fake.invoke.mockImplementation(async () => []);
  const { result } = renderHook(() => useCleanup());
  await act(async () => {});
  expect(result.current).toEqual([]);
  await act(async () => { emit([job("a"), job("b")]); });
  expect(result.current).toEqual([job("a"), job("b")]);
  expect(fake.invoke.mock.calls.length).toBe(1);
  await act(async () => { emit([]); });
  expect(result.current).toEqual([]);
  expect(fake.invoke.mock.calls.length).toBe(1);
});

it("unlistens on dispose", async () => {
  fake.invoke.mockImplementation(async () => []);
  const { unmount } = renderHook(() => useCleanup());
  await act(async () => {});
  unmount();
  await act(async () => {});
  expect(fake.unlisten).toHaveBeenCalledTimes(1);
});

it("unlistens when dispose wins the race against registration", async () => {
  fake.autoResolve = false;
  fake.invoke.mockImplementation(async () => []);
  const { unmount } = renderHook(() => useCleanup());
  await act(async () => {});
  unmount();
  // `listen()` resolves only now, after the effect was torn down.
  await act(async () => { fake.registrations.forEach((r) => r.resolve()); });
  expect(fake.unlisten).toHaveBeenCalledTimes(1);
  // No snapshot is fetched for a hook that is already gone.
  expect(fake.invoke).not.toHaveBeenCalled();
});
