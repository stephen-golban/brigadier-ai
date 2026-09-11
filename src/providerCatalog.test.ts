import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  listened: [] as string[],
  handlers: [] as (() => void)[],
  unlisten: vi.fn(),
  /** Held open to keep a `listen()` unresolved; see the reordering tests at the bottom. */
  gate: null as Promise<void> | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke, isTauri: () => true }));
// `listen` resolves a microtask later at the earliest, and the handler is only live once it has:
// Tauri registers the subscription across the IPC boundary, and nothing emitted before that is
// buffered or replayed (`docs/plans/efficiency-plan-review-2026-09-11.md` §B4). The mock models
// exactly that — the name is recorded synchronously, the handler is not.
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: () => void) => {
    fake.listened.push(name);
    const register = () => { fake.handlers.push(handler); return fake.unlisten; };
    return (fake.gate ?? Promise.resolve()).then(register);
  },
}));
vi.mock("./workspaceApi", () => ({ desktop: true, errorMessage: String }));

import { providerCatalogStore, useProviderCatalog, type ProviderCatalogEntry } from "./providerCatalog";

// `await` between the unmount and the reset on purpose: the hook unsubscribes through
// `stop.then(unlisten => unlisten())`, a microtask, so a synchronous reset would move the
// previous test's `unlisten()` into the next test's call count.
afterEach(async () => {
  cleanup();
  await Promise.resolve(); await Promise.resolve();
  vi.useRealTimers();
  fake.invoke.mockReset(); fake.unlisten.mockReset();
  fake.listened.length = 0; fake.handlers.length = 0; fake.gate = null;
  visibility("visible");
});

/** jsdom has no window manager; `visibilityState` is a plain getter to redefine. */
function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
}
const visibilityChanged = () => document.dispatchEvent(new Event("visibilitychange"));

const NONE: never[] = [];
const entry = (over: Partial<ProviderCatalogEntry> = {}): ProviderCatalogEntry => ({
  id: "claude-code", label: "Claude Code", instanceId: "claude-code:default", version: "2.0.0",
  models: [{ id: "sonnet", label: "Sonnet", efforts: [] }], efforts: [], modelCatalogKnown: true, ...over,
});
/** What `src-tauri/src/provider_catalog.rs` emits when a background discovery finishes. */
const refreshed = () => { for (const handler of fake.handlers) handler(); };
/** The whole retry budget: 300 + 900 + 1500 + 1500. */
const BUDGET_MS = 4200;

/*
 * `loaded` is the whole point of this hook's second field: `NewSession` prints "No provider CLI is
 * connected" off an empty catalogue, and until the first read settles an empty catalogue means
 * "not known yet" (`docs/research/execution-settings-banner.md`).
 */
it("reports not loaded until the first read resolves", async () => {
  let resolve: (rows: ProviderCatalogEntry[]) => void = () => {};
  fake.invoke.mockImplementation(() => new Promise<ProviderCatalogEntry[]>(r => { resolve = r; }));
  const { result } = renderHook(() => useProviderCatalog(NONE));
  expect(result.current.loaded).toBe(false);
  expect(result.current.providers).toEqual([]);
  // The read starts once the subscription is live, one microtask after mount.
  await act(async () => {});
  await act(async () => { resolve([entry()]); });
  expect(result.current.loaded).toBe(true);
  expect(result.current.providers).toHaveLength(1);
});

/*
 * The Rust command answers from the capability cache and refreshes discovery behind the response,
 * so the first read of a launch can legitimately be empty. Retrying is what turns that into the
 * real answer; staying unloaded through the retries is what keeps the banner quiet meanwhile.
 *
 * The schedule is front-loaded — 300, 900, 1500, 1500 — so a cache that fills quickly is seen
 * quickly. This test is the schedule: change the constant and it fails.
 */
it("retries on a front-loaded 300/900/1500/1500 schedule, and stays unloaded until it is spent", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue([]);
  const { result } = renderHook(() => useProviderCatalog(NONE));
  await act(async () => {});
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  expect(result.current.loaded).toBe(false);
  const schedule: [number, number][] = [[300, 2], [900, 3], [1500, 4], [1500, 5]];
  for (const [gap, calls] of schedule) {
    await act(async () => { await vi.advanceTimersByTimeAsync(gap - 1); });
    expect(fake.invoke).toHaveBeenCalledTimes(calls - 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fake.invoke).toHaveBeenCalledTimes(calls);
    expect(result.current.loaded).toBe(calls === 5);
  }
  // Spent. Nothing until the 15 s poll, which is the next test.
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(5);
});

it("stops retrying as soon as a provider appears", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValueOnce([]).mockResolvedValue([entry()]);
  const { result } = renderHook(() => useProviderCatalog(NONE));
  await act(async () => {});
  expect(result.current.loaded).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fake.invoke).toHaveBeenCalledTimes(2);
  expect(result.current.loaded).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(2);
});

it("does not retry a non-empty first read", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue([entry()]);
  const { result } = renderHook(() => useProviderCatalog(NONE));
  await act(async () => {});
  expect(result.current.loaded).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(1);
});

/*
 * A provider whose model list has not arrived yet is the same "not known yet" as no provider at
 * all — `modelCatalogKnown: false` is exactly what the command reports while the Claude handshake
 * is still running.
 */
it("retries a provider whose model catalogue is not known yet", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValueOnce([entry({ models: [], modelCatalogKnown: false })]).mockResolvedValue([entry()]);
  const { result } = renderHook(() => useProviderCatalog(NONE));
  await act(async () => {});
  expect(result.current.loaded).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(result.current.loaded).toBe(true);
  expect(result.current.providers[0]?.modelCatalogKnown).toBe(true);
});

/*
 * `provider_catalog` rejects with `startup_pending` while the app is still opening. Surfacing that
 * as a composer error would be a second false alarm, so it is held until the retries are spent.
 */
it("holds a rejection back until the retries are spent", async () => {
  vi.useFakeTimers();
  fake.invoke.mockRejectedValue(new Error("Brigadier is opening"));
  const { result } = renderHook(() => useProviderCatalog(NONE));
  await act(async () => {});
  expect(result.current.error).toBe("");
  expect(result.current.loaded).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(BUDGET_MS - 1); });
  expect(result.current.loaded).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.error).toContain("Brigadier is opening");
  expect(result.current.loaded).toBe(true);
});

it("re-reads on focus and gives the retries back", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue([]);
  renderHook(() => useProviderCatalog(NONE));
  await act(async () => { await vi.advanceTimersByTimeAsync(BUDGET_MS); });
  expect(fake.invoke).toHaveBeenCalledTimes(5);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(fake.invoke).toHaveBeenCalledTimes(6);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fake.invoke).toHaveBeenCalledTimes(7);
});

/*
 * The bug this closes: with the budget spent and the catalogue still empty, the old hook settled
 * on `providers: []` and nothing re-read it until a window `focus` — which a launch never fires,
 * because the window already has focus. `provider-catalog-refreshed` is the Rust side saying the
 * handshake is done, and it is honoured regardless of the budget.
 */
it("re-reads on provider-catalog-refreshed even after the budget is spent", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue([]);
  const { result } = renderHook(() => useProviderCatalog(NONE));
  expect(fake.listened).toEqual(["provider-catalog-refreshed"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(BUDGET_MS); });
  expect(fake.invoke).toHaveBeenCalledTimes(5);
  expect(result.current.loaded).toBe(true);
  expect(result.current.providers).toEqual([]);
  fake.invoke.mockResolvedValue([entry()]);
  await act(async () => { refreshed(); });
  expect(fake.invoke).toHaveBeenCalledTimes(6);
  expect(result.current.providers).toHaveLength(1);
  expect(result.current.loaded).toBe(true);
});

/*
 * Belt to the event's braces: a CLI installed while the window is open, or an emit that never
 * arrives, is still noticed. The poll runs only while the catalogue is unsettled.
 */
it("polls every 15 s while unsettled and stops the moment a provider lands", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue([]);
  renderHook(() => useProviderCatalog(NONE));
  await act(async () => { await vi.advanceTimersByTimeAsync(BUDGET_MS); });
  expect(fake.invoke).toHaveBeenCalledTimes(5);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(6);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(7);
  fake.invoke.mockResolvedValue([entry()]);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(8);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(8);
});

/*
 * Focus arrives in bursts — the OS window focus plus the webview's own. Two overlapping reads
 * would each schedule a retry on resolve and the second `setTimeout` would overwrite the handle,
 * leaking the first past unmount, so a read in flight swallows the next one.
 */
it("does not stack reads when focus fires in a burst", async () => {
  vi.useFakeTimers();
  const resolvers: ((rows: ProviderCatalogEntry[]) => void)[] = [];
  fake.invoke.mockImplementation(() => new Promise<ProviderCatalogEntry[]>(r => { resolvers.push(r); }));
  renderHook(() => useProviderCatalog(NONE));
  await act(async () => {});
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  await act(async () => {
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("focus"));
    refreshed(); refreshed();
  });
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  await act(async () => { for (const r of resolvers) r([]); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fake.invoke).toHaveBeenCalledTimes(2);
});

it("unsubscribes and stops every timer on unmount", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue([]);
  const { unmount } = renderHook(() => useProviderCatalog(NONE));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fake.invoke).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => {});
  expect(fake.unlisten).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(2);
});

/*
 * B4, `docs/plans/efficiency-plan-review-2026-09-11.md`: the subscription is registered **before**
 * the first read, so there is no window in which a `provider-catalog-refreshed` can be emitted
 * and dropped. The old order read first and subscribed afterwards; with `listen` unresolved the
 * read below could not have been answered by the event at all, and only the 15 s poll would have
 * found the catalogue — 15 s of "No provider CLI is connected" on a machine that has one.
 */
it("subscribes before it reads, so a refresh at the first read's heels is not lost", async () => {
  let open: () => void = () => {};
  fake.gate = new Promise<void>(r => { open = r; });
  fake.invoke.mockResolvedValue([]);
  const { result } = renderHook(() => useProviderCatalog(NONE));

  // Nothing is read while the subscription is still landing. This is the invariant.
  await act(async () => {});
  expect(fake.listened).toEqual(["provider-catalog-refreshed"]);
  expect(fake.invoke).not.toHaveBeenCalled();

  await act(async () => { open(); });
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  expect(result.current.providers).toEqual([]);

  // The emit the old order raced: it lands, because the handler was live before the read was.
  fake.invoke.mockResolvedValue([entry()]);
  await act(async () => { refreshed(); });
  expect(fake.invoke).toHaveBeenCalledTimes(2);
  expect(result.current.providers).toHaveLength(1);
  expect(result.current.loaded).toBe(true);
});

it("unsubscribes a listen that resolves after unmount, and never reads or polls", async () => {
  vi.useFakeTimers();
  let open: () => void = () => {};
  fake.gate = new Promise<void>(r => { open = r; });
  fake.invoke.mockResolvedValue([entry()]);
  const { unmount } = renderHook(() => useProviderCatalog(NONE));
  unmount();

  await act(async () => { open(); });
  expect(fake.unlisten).toHaveBeenCalledTimes(1);
  expect(fake.invoke).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fake.invoke).not.toHaveBeenCalled();
});

/*
 * Gap 8, `docs/research/lifecycle-bounds-audit-2026-09-11.md` §4. The hook is mounted by
 * `Composer`, `NewSession` and `SessionPreferences` at once, and each mount used to hold its own
 * budget, its own subscription, its own `focus` listener and — on a machine with no CLI, where the
 * catalogue never settles — its own 15 s poll for the window's life.
 */
it("shares one subscription, one budget and one poll across every mount", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue([]);
  const a = renderHook(() => useProviderCatalog(NONE));
  const b = renderHook(() => useProviderCatalog(NONE));
  const c = renderHook(() => useProviderCatalog(NONE));
  expect(providerCatalogStore().consumers).toBe(3);

  await act(async () => { await vi.advanceTimersByTimeAsync(BUDGET_MS); });
  expect(fake.listened).toEqual(["provider-catalog-refreshed"]);
  expect(fake.invoke).toHaveBeenCalledTimes(5);

  // One invoke per cadence tick, not one per mount.
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(6);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(7);

  // And every mount sees the one answer.
  fake.invoke.mockResolvedValue([entry()]);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  for (const mount of [a, b, c]) {
    expect(mount.result.current.providers).toHaveLength(1);
    expect(mount.result.current.loaded).toBe(true);
  }

  // The store outlives a mount and is torn down by the last one to leave.
  a.unmount(); b.unmount();
  expect(providerCatalogStore().consumers).toBe(1);
  expect(fake.unlisten).not.toHaveBeenCalled();
  c.unmount();
  await act(async () => {});
  expect(providerCatalogStore()).toEqual({ consumers: 0, running: false, polling: false });
  expect(fake.unlisten).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(8);
});

/*
 * A hidden window cannot draw a model picker, so it is not worth an IPC round trip — and the
 * budget must not be spent behind its back either, or a window backgrounded through the whole
 * launch would come forward to a permanently empty catalogue.
 */
it("invokes nothing while hidden, and reads once when the window comes forward", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue([]);
  visibility("hidden");
  renderHook(() => useProviderCatalog(NONE));
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fake.listened).toEqual(["provider-catalog-refreshed"]);
  expect(fake.invoke).not.toHaveBeenCalled();
  expect(providerCatalogStore().polling).toBe(false);

  visibility("visible");
  await act(async () => { visibilityChanged(); });
  expect(fake.invoke).toHaveBeenCalledTimes(1);
  // The budget was given back, not burned while hidden.
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(fake.invoke).toHaveBeenCalledTimes(2);
  expect(providerCatalogStore().polling).toBe(true);
});

/* A CLI installed while the window is in the background is still found when it comes forward. */
it("clears the poll on hide and re-arms it on show", async () => {
  vi.useFakeTimers();
  fake.invoke.mockResolvedValue([]);
  renderHook(() => useProviderCatalog(NONE));
  await act(async () => { await vi.advanceTimersByTimeAsync(BUDGET_MS); });
  expect(fake.invoke).toHaveBeenCalledTimes(5);
  expect(providerCatalogStore().polling).toBe(true);

  visibility("hidden");
  await act(async () => { visibilityChanged(); });
  expect(providerCatalogStore().polling).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fake.invoke).toHaveBeenCalledTimes(5);

  fake.invoke.mockResolvedValue([entry()]);
  visibility("visible");
  await act(async () => { visibilityChanged(); });
  expect(fake.invoke).toHaveBeenCalledTimes(6);
  // Settled: the poll it re-armed stops itself.
  expect(providerCatalogStore().polling).toBe(false);
});
