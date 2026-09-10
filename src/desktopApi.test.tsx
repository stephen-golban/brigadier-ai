import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke, isTauri: () => true }));
vi.mock("./workspaceApi", () => ({ desktop: true, errorMessage: String }));

import { useSessionChanges } from "./desktopApi";

afterEach(() => { cleanup(); vi.useRealTimers(); fake.invoke.mockReset(); });

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
