import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useSessionSources } from "./useSessionSources";
import type { PeerAttachment } from "../peerApi";
vi.mock("@tauri-apps/api/core", () => ({invoke: vi.fn()}));
vi.mock("../workspaceApi", () => ({desktop: true}));
const source: PeerAttachment = {id: "a", projectId: "p", name: "brief.md", mediaType: "text/plain", size: 12, createdAt: 1};
function deferred() {
  let resolve!: (sources: PeerAttachment[]) => void;
  const promise = new Promise<PeerAttachment[]>(done => { resolve = done; });
  return {promise, resolve};
}
beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(cleanup);
it("keeps sources during refresh, preserves identical snapshots, and publishes changed metadata", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([source]);
  const {result, rerender} = renderHook(({busy}) => useSessionSources("one", busy, "turn"), {initialProps: {busy: false}});
  await waitFor(() => expect(result.current.sources).toEqual([source]));
  const initial = result.current;
  const refresh = deferred(); vi.mocked(invoke).mockReturnValueOnce(refresh.promise);
  rerender({busy: true});
  expect(result.current).toBe(initial);
  await act(async () => refresh.resolve([{...source}]));
  expect(result.current).toBe(initial);
  vi.mocked(invoke).mockResolvedValueOnce([{...source, name: "renamed.md"}]);
  rerender({busy: false});
  await waitFor(() => expect(result.current.sources[0].name).toBe("renamed.md"));
});
it("does not republish empty source results", async () => {
  const refresh = deferred(); vi.mocked(invoke).mockReturnValueOnce(refresh.promise);
  const {result} = renderHook(() => useSessionSources("one", false, null));
  const initial = result.current;
  await act(async () => refresh.resolve([]));
  expect(result.current).toBe(initial);
});
it("never shows a previous session's sources or accepts its late response", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([source]);
  const {result, rerender} = renderHook(({id, busy}) => useSessionSources(id, busy, null), {initialProps: {id: "one", busy: false}});
  await waitFor(() => expect(result.current.sources).toEqual([source]));
  const old = deferred(); vi.mocked(invoke).mockReturnValueOnce(old.promise);
  rerender({id: "one", busy: true});
  const next = deferred(); vi.mocked(invoke).mockReturnValueOnce(next.promise);
  rerender({id: "two", busy: false});
  expect(result.current.sources).toEqual([]);
  const other = {...source, id: "b"};
  await act(async () => next.resolve([other]));
  await act(async () => old.resolve([source]));
  expect(result.current.sources).toEqual([other]);
});
