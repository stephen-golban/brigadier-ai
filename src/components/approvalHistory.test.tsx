import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ApprovalHistoryItem } from "./approvalHistory";

const fake = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke, isTauri: () => true }));
vi.mock("../workspaceApi", () => ({ desktop: true, errorMessage: String }));

import { useApprovalHistory } from "./approvalHistory";

afterEach(() => { cleanup(); fake.invoke.mockReset(); });

const receipt = (id: string): ApprovalHistoryItem => ({
  request_id: id, session_id: "s", opened_at_ms: 1, expired: false, resolved: true,
  decision: { type: "allow", updated_input: null, updated_permissions: [] },
  kind: { type: "tool-permission", tool_name: "Bash", input_excerpt: "ls", suggestions: [], tool_call_id: "c" },
});

/*
 * Mount cost. An empty history is the common case on a first mount, and resolving it to a fresh
 * `[]` costs a whole extra render of the mounted transcript for no new information.
 */
it("does not re-render the mount when there is no history to show", async () => {
  fake.invoke.mockImplementation(async () => []);
  let renders = 0;
  const { result } = renderHook(() => { renders++; return useApprovalHistory("s", ""); });
  await act(async () => {});
  expect(result.current).toHaveLength(0);
  expect(renders).toBe(1);
});

it("shows a receipt as soon as it loads and again when a new one arrives", async () => {
  fake.invoke.mockImplementation(async () => [receipt("a")]);
  const { result, rerender } = renderHook(({ key }) => useApprovalHistory("s", key), { initialProps: { key: "" } });
  await act(async () => {});
  expect(result.current).toHaveLength(1);
  fake.invoke.mockImplementation(async () => [receipt("a"), receipt("b")]);
  rerender({ key: "b" });
  await act(async () => {});
  expect(result.current).toHaveLength(2);
});

it("does not re-render for a refresh that returns the same receipts", async () => {
  // A fresh array per call, as the IPC boundary always produces: identity alone cannot bail out.
  fake.invoke.mockImplementation(async () => [receipt("a")]);
  let renders = 0;
  const { rerender } = renderHook(({ key }) => { renders++; return useApprovalHistory("s", key); }, { initialProps: { key: "" } });
  await act(async () => {});
  const loaded = renders;
  for (const key of ["a", "b", "c"]) {
    rerender({ key });
    await act(async () => {});
  }
  expect(renders).toBe(loaded + 3); // the three rerenders themselves, and nothing from the loads
});
