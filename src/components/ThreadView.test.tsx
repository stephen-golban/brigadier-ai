import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadView } from "./ThreadView";
import { workspaceApi, type ChatItem } from "../workspaceApi";

const { state } = vi.hoisted(() => ({ state: { sessions: { s: { busy: true } } } }));
vi.mock("../feedStore", () => ({ getState: () => state, subscribe: () => () => {} }));
vi.mock("../desktopApi", async (original) => ({
  ...await original<typeof import("../desktopApi")>(),
  useSessionChanges: () => ({ turns: [], files: [] }),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Use the real assistant-ui runtime: isRunning adds its own optimistic assistant message.
it.each([false, true])("renders a running session while saved user message exists = %s", async (saved) => {
  const page: ChatItem[] = saved ? [{
    session_id: "s", id: "user", seq: 1, at: 0, kind: { type: "user-text" },
    body: "Test message", parent_id: null,
  }] : [];
  vi.spyOn(workspaceApi, "chat").mockResolvedValue(page);
  render(<ThreadView sessionId="s" projectId="p" projectName="Example" onFile={() => {}} />);
  expect(await screen.findByText(saved ? "Test message" : "Waiting for the first response…")).toBeVisible();
  expect(screen.getByText("Working…")).toBeVisible();
});
