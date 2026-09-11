/**
 * `useSessionNavigation` is mounted once per session row (`SessionMenu`), plus the sidebar, the
 * composer and `usePeers`. Each mount used to `JSON.parse` both stored keys for itself; the reads
 * are now coalesced behind a cache keyed on the raw stored string, invalidated by the same
 * `brigadier-session-navigation-changed` / `storage` events the hook already subscribes to.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSessionNavigation } from "./sessionNavigation";

const titlesKey = "brigadier:session-titles:v1";
const archivedKey = "brigadier:archived-sessions:v1";
const changed = "brigadier-session-navigation-changed";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function parsesOf(calls: readonly unknown[][], raw: string) {
  return calls.filter((call) => call[0] === raw).length;
}

describe("session navigation reads", () => {
  it("parses each stored key once across mounts and re-parses only the key that changed", () => {
    const titles = JSON.stringify({ "s-1": "First" });
    const archived = JSON.stringify(["s-9"]);
    localStorage.setItem(titlesKey, titles);
    localStorage.setItem(archivedKey, archived);
    const parse = vi.spyOn(JSON, "parse");

    const first = renderHook(() => useSessionNavigation());
    expect(first.result.current.titles).toEqual({ "s-1": "First" });
    expect(first.result.current.archivedIds).toEqual(["s-9"]);
    expect(parsesOf(parse.mock.calls, titles)).toBe(1);
    expect(parsesOf(parse.mock.calls, archived)).toBe(1);

    // A second consumer of the same stored strings parses nothing.
    const second = renderHook(() => useSessionNavigation());
    expect(second.result.current.titles).toBe(first.result.current.titles);
    expect(second.result.current.archivedIds).toBe(
      first.result.current.archivedIds,
    );
    expect(parsesOf(parse.mock.calls, titles)).toBe(1);
    expect(parsesOf(parse.mock.calls, archived)).toBe(1);

    const renamed = JSON.stringify({ "s-1": "Renamed" });
    act(() => {
      localStorage.setItem(titlesKey, renamed);
      window.dispatchEvent(new Event(changed));
    });
    expect(first.result.current.titles).toEqual({ "s-1": "Renamed" });
    expect(second.result.current.titles).toBe(first.result.current.titles);
    expect(parsesOf(parse.mock.calls, renamed)).toBe(1);
    // The archived key did not change, so neither re-render re-parsed it.
    expect(parsesOf(parse.mock.calls, archived)).toBe(1);
  });
});
