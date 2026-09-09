import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  isTauri: () => true,
  Channel: class {},
}));
import { bridge } from "./bridge";

beforeEach(() => invoke.mockReset());

it("sends durable attachment IDs through the native attachment-aware turn command", async () => {
  invoke.mockResolvedValue({ turn_id: "turn" });
  await expect(bridge().sendTurn("session", "See attached", ["image", "file"]))
    .resolves.toEqual({ turn_id: "turn" });
  expect(invoke).toHaveBeenCalledWith("send_conversation_turn", {
    sessionId: "session", text: "See attached", attachmentIds: ["image", "file"],
  });
});

it("preserves the existing text-only turn command", async () => {
  invoke.mockResolvedValue({ turn_id: "turn" });
  await bridge().sendTurn("session", "Hello");
  expect(invoke).toHaveBeenCalledWith("send_turn", { sessionId: "session", text: "Hello" });
});

it("passes initial attachment IDs when creating a session", async () => {
  invoke.mockResolvedValue({ session_id: "session" });
  const args = { projectId: "project", prompt: "See attached", model: null, permissionMode: "default" as const, attachmentIds: ["file"] };
  await bridge().startSession(args);
  expect(invoke).toHaveBeenCalledWith("start_session", expect.objectContaining(args));
});
