import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  listen: vi.fn(),
  unlistens: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: unknown, options?: unknown) => {
    fake.listen(name, handler, options);
    const off = vi.fn();
    fake.unlistens.push(off);
    return Promise.resolve(off);
  },
}));

import { listen, listenerRegistrations } from "./listeners";

beforeEach(() => {
  fake.listen.mockClear();
  fake.unlistens.length = 0;
});
afterEach(() => {
  // Leave no registration behind for the next test: `pagehide` is the app's own drain.
  window.dispatchEvent(new Event("pagehide"));
});

const calls = () => fake.unlistens.map((off) => off.mock.calls.length);
/** `PageTransitionEvent` is not constructible in this environment; only `persisted` is read. */
const pagehide = (persisted: boolean) => {
  const event = new Event("pagehide");
  Object.defineProperty(event, "persisted", {value: persisted});
  return event;
};

/*
 * Gap 4, `docs/research/lifecycle-bounds-audit-2026-09-11.md` §2.1. React cleanup does not run on
 * a reload, so without this drain every registration stays in Tauri's `js_event_listeners` map for
 * the process's life and every later emit evals a script for it.
 */
it("unlistens every registration exactly once when the page goes away", async () => {
  const before = listenerRegistrations().live;
  const offs = await Promise.all(
    ["a", "b", "c", "d"].map((name) => listen(name, () => {})),
  );
  expect(listenerRegistrations().live).toBe(before + 4);
  expect(calls()).toEqual([0, 0, 0, 0]);

  window.dispatchEvent(new Event("pagehide"));
  expect(calls()).toEqual([1, 1, 1, 1]);
  expect(listenerRegistrations().live).toBe(0);

  // A second `pagehide`, and `beforeunload` behind it, must not unlisten an id twice.
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("beforeunload"));
  expect(calls()).toEqual([1, 1, 1, 1]);

  // Nor may the caller's own cleanup, which loses the race with a reload.
  for (const off of offs) off();
  expect(calls()).toEqual([1, 1, 1, 1]);
});

it("records a registration made after a drain, for a bfcache-style resume", async () => {
  await listen("a", () => {});
  window.dispatchEvent(new Event("pagehide"));
  expect(calls()).toEqual([1]);

  await listen("b", () => {});
  expect(calls()).toEqual([1, 0]);
  window.dispatchEvent(new Event("pagehide"));
  expect(calls()).toEqual([1, 1]);
});

it("takes a caller's unlisten out of the registry, so the drain does not repeat it", async () => {
  const off = await listen("a", () => {});
  off();
  off();
  expect(calls()).toEqual([1]);
  expect(listenerRegistrations().live).toBe(0);
  window.dispatchEvent(new Event("pagehide"));
  expect(calls()).toEqual([1]);
});

/*
 * A bfcache freeze fires `pagehide` too, and the document it freezes is resumed with its JS
 * state intact. Draining there would leave a resumed page holding unlisten functions for Rust
 * subscriptions that no longer exist, and receiving nothing.
 */
it("keeps its registrations when the page is frozen rather than torn down", async () => {
  await listen("a", () => {});
  window.dispatchEvent(pagehide(true));
  expect(calls()).toEqual([0]);
  expect(listenerRegistrations().live).toBe(1);

  window.dispatchEvent(pagehide(false));
  expect(calls()).toEqual([1]);
  expect(listenerRegistrations().live).toBe(0);
});

it("passes the event name, handler and options straight through", async () => {
  const handler = () => {};
  await listen("native-new-session", handler, { target: "main" });
  expect(fake.listen).toHaveBeenCalledWith("native-new-session", handler, {
    target: "main",
  });
});
