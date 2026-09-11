/**
 * `usePeers`, and specifically the order in which it wires itself up.
 *
 * B4 of `docs/plans/efficiency-plan-review-2026-09-11.md`: `listen` is async, Tauri v2 buffers
 * and replays nothing, and this hook used to call `fetch()` first and subscribe afterwards — so a
 * `peer-state-changed` emitted in between reached nobody and the inbox stayed stale until the
 * 30 s poll. The poll is still here on purpose; it is what hid the bug, and removing it waits on
 * the producer coverage this reorder is the precondition for.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { PeerData } from "./peerApi";

const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  listened: [] as string[],
  handlers: [] as (() => void)[],
  unlisten: vi.fn(),
  /** Held open to keep a `listen()` unresolved, which is the window under test. */
  gate: null as Promise<void> | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke, isTauri: () => true }));
// The handler goes live only when the promise resolves, as the real IPC registration does.
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: () => void) => {
    fake.listened.push(name);
    const register = () => { fake.handlers.push(handler); return fake.unlisten; };
    return (fake.gate ?? Promise.resolve()).then(register);
  },
}));
vi.mock("./workspaceApi", () => ({ desktop: true }));
vi.mock("./sessionNavigation", () => ({ useSessionNavigation: () => ({ titles: {} }) }));

import { usePeers } from "./peerApi";

afterEach(async () => {
  cleanup();
  await Promise.resolve(); await Promise.resolve();
  vi.useRealTimers();
  fake.invoke.mockReset(); fake.unlisten.mockReset();
  fake.listened.length = 0; fake.handlers.length = 0; fake.gate = null;
});

const snapshot = (over: Partial<PeerData> = {}): PeerData => ({
  origins: {}, subagents: {}, titles: {}, closed: [], messages: [], requests: [], ...over,
});

const message = (id: string) => ({
  id, from: "a", to: "b", text: id, work: false, delivered: true, error: null,
});

/** What `src-tauri/src/peer_sessions.rs` emits when the peer state moves. */
const changed = () => { for (const handler of fake.handlers) handler(); };

it("subscribes before it fetches, so a change at the first snapshot's heels is not lost", async () => {
  let open: () => void = () => {};
  fake.gate = new Promise<void>(r => { open = r; });
  fake.invoke.mockResolvedValue(snapshot());
  const { result } = renderHook(() => usePeers());

  // Nothing is fetched while the subscription is still landing. This is the invariant.
  await act(async () => {});
  expect(fake.listened).toEqual(["peer-state-changed"]);
  expect(fake.invoke).not.toHaveBeenCalled();
  expect(result.current.loaded).toBe(false);

  await act(async () => { open(); });
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  expect(result.current.loaded).toBe(true);
  expect(result.current.messages).toEqual([]);

  // The emit the old order raced: the handler was live before the fetch was, so it lands.
  fake.invoke.mockResolvedValue(snapshot({ messages: [message("m1")] }));
  await act(async () => { changed(); });
  expect(fake.invoke).toHaveBeenCalledTimes(2);
  expect(result.current.messages.map(m => m.id)).toEqual(["m1"]);
});

it("unsubscribes a listen that resolves after unmount, and never fetches or polls", async () => {
  vi.useFakeTimers();
  let open: () => void = () => {};
  fake.gate = new Promise<void>(r => { open = r; });
  fake.invoke.mockResolvedValue(snapshot());
  const { unmount } = renderHook(() => usePeers());
  unmount();

  await act(async () => { open(); });
  expect(fake.unlisten).toHaveBeenCalledTimes(1);
  expect(fake.invoke).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fake.invoke).not.toHaveBeenCalled();
});

it("keeps the 30 s poll and the focus re-read behind the subscription", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue(snapshot());
  const { unmount } = renderHook(() => usePeers());
  await act(async () => {});
  expect(fake.invoke).toHaveBeenCalledTimes(1);

  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(2);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(fake.invoke).toHaveBeenCalledTimes(3);

  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(3);
  expect(fake.unlisten).toHaveBeenCalledTimes(1);
});
