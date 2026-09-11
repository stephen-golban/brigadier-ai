/**
 * The terminal half of the workspace bridge: the command names and argument keys Rust actually
 * registers (`src-tauri/src/lib.rs`), and the channel's teardown.
 */
import { beforeEach, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  class FakeChannel<T> {
    onmessage: (value: T) => void = () => {};
  }
  return {
    invoke: vi.fn(async () => undefined as unknown),
    isTauri: () => true,
    Channel: FakeChannel,
  };
});
vi.mock("@tauri-apps/api/core", () => tauri);
const { workspaceApi } = await import("./workspaceApi");

beforeEach(() => {
  tauri.invoke.mockClear();
});

it("hands Rust the channel under the argument name the command expects", async () => {
  const frames: number[] = [];
  const stop = await workspaceApi.subscribeTerminal("terminal-1", (frame) =>
    frames.push(frame.seq),
  );
  expect(tauri.invoke).toHaveBeenCalledTimes(1);
  const [command, args] = tauri.invoke.mock.calls[0] as unknown as [
    string,
    { id: string; onOutput: { onmessage: (frame: unknown) => void } },
  ];
  expect(command).toBe("terminal_subscribe");
  expect(args.id).toBe("terminal-1");
  args.onOutput.onmessage({
    seq: 1,
    bytes: "",
    dropped_before: 0,
    exited: false,
    drained: false,
  });
  expect(frames).toEqual([1]);
  // Teardown detaches this page's handler; a frame already in flight lands nowhere.
  stop();
  args.onOutput.onmessage({
    seq: 2,
    bytes: "",
    dropped_before: 0,
    exited: false,
    drained: false,
  });
  expect(frames).toEqual([1]);
});

it("keeps the deprecated polled read wired to its command", async () => {
  await workspaceApi.readTerminal("terminal-1");
  expect(tauri.invoke).toHaveBeenCalledWith("terminal_read", {
    id: "terminal-1",
  });
});
