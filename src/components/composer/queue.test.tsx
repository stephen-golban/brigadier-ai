import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "../Composer";
import { composerApi, emptyComposer, type ComposerState, serializeComposerWrite } from "../../composerApi";
import { ZERO_USAGE } from "../../wire";
import type { SessionRuntime } from "../../feedStore";
import { pasteComposer } from "../../test/composer";
vi.mock("../../workspaceApi", async importOriginal => ({ ...await importOriginal<object>(), desktop: true }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
const session: SessionRuntime = { sessionId: "s", projectId: "p", status: "running", model: "exact-model", cwd: "/project", providerSessionId: "native", worktreePath: null, branch: null, worktreeRemoved: false, resumed: false, busy: false, lastTurnId: null, lastStop: null, costUsd: 0, usage: ZERO_USAGE, rowsTotal: 0, rowsDropped: 0, startedAtMs: 0, endedAtMs: null, exitCode: null, lastMessage: null, lastEventSeq: 0 };
let state: ComposerState;
let emit: (state: ComposerState) => void;
beforeEach(() => {
  state = emptyComposer("s"); emit = () => {};
  vi.spyOn(composerApi, "state").mockImplementation(async () => structuredClone(state));
  vi.spyOn(composerApi, "subscribe").mockImplementation(async callback => { emit = callback; return () => {}; });
  vi.spyOn(composerApi, "commands").mockResolvedValue([{ name: "context", description: "Read context", arguments: false, execution: "control" }]);
  vi.spyOn(composerApi, "saveDraft").mockImplementation(async (_session, text, attachmentIds) => { state = { ...state, revision: state.revision + 1, draft: { text, attachmentIds } }; return structuredClone(state); });
  vi.spyOn(composerApi, "enqueue").mockImplementation(async (_session, id, text, attachmentIds) => { if (!state.queue.some(item => item.id === id)) state = { ...state, revision: state.revision + 1, draft: { text: "", attachmentIds: [] }, queue: [...state.queue, { id, text, attachmentIds, status: "queued", turnId: null, error: null }] }; return structuredClone(state); });
  vi.spyOn(composerApi, "stop").mockImplementation(async () => { state = { ...state, revision: state.revision + 1, stopped: true, paused: true, stopping: false }; emit(state); return state; });
  vi.spyOn(composerApi, "resume").mockImplementation(async () => { state = { ...state, revision: state.revision + 1, stopped: false, paused: false, stopping: false }; emit(state); return state; });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function mount(over: Partial<SessionRuntime> = {}) { return render(<Composer session={{ ...session, ...over }} busy={false} onSend={vi.fn()} onResume={vi.fn()} onInterrupt={vi.fn()} onKill={vi.fn()} onEnd={vi.fn()} onCleanup={vi.fn()} />); }
it("queues active-turn submissions, Stop pauses durably and only explicit Resume drains", async () => {
  const view = mount({ busy: true });
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true"));
  await pasteComposer(screen.getByRole("textbox"), "next task");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await screen.findByText("next task", { selector: "summary" });
  expect(composerApi.enqueue).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
  await screen.findByText("Queue paused because you stopped");
  view.unmount(); mount({ status: "exited", busy: false });
  await screen.findByText("Queue paused because you stopped");
  expect(composerApi.resume).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
  await waitFor(() => expect(composerApi.resume).toHaveBeenCalledOnce());
});
it("keeps unknown receipts inspectable and never treats unsupported slash commands as prompts", async () => {
  state.queue = [{ id: "unknown", text: "uncertain send", attachmentIds: ["image"], status: "unknown", turnId: null, error: "Lost acknowledgement" }]; state.paused = true;
  mount();
  await screen.findByRole("button", { name: "Verified delivered" });
  expect(screen.queryByRole("button", { name: "Remove queued message" })).toBeNull();
  await pasteComposer(screen.getByRole("textbox"), "/unsupported high");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await screen.findByText("/unsupported is not supported by this session's adapter.");
  expect(composerApi.enqueue).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveTextContent("/unsupported high");
});
it("reuses the same persisted request identity after an ambiguous IPC response and remount", async () => {
  const enqueue = vi.mocked(composerApi.enqueue); enqueue.mockRejectedValueOnce(new Error("Lost reply"));
  const first = mount();
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true"));
  await pasteComposer(screen.getByRole("textbox"), "do exactly once");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await screen.findByText("Lost reply");
  const id = enqueue.mock.calls[0]![1];
  first.unmount(); mount();
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("do exactly once"));
  fireEvent.click(screen.getByRole("button", { name: "send this turn" }));
  await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
  expect(enqueue.mock.calls[1]![1]).toBe(id);
  expect(state.queue).toHaveLength(1);
});
it("Stop is not delayed behind a pending draft acknowledgement", async () => {
  let resolve: (value: ComposerState) => void = () => {};
  vi.mocked(composerApi.saveDraft).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mount({ busy: true });
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true"));
  await pasteComposer(screen.getByRole("textbox"), "still saving");
  fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
  await waitFor(() => expect(composerApi.stop).toHaveBeenCalledOnce());
  await act(async () => resolve(state));
});
it("serializes drafts and sends across remounts without losing writes after a rejection", async () => {
  let release: () => void = () => {}; const seen: string[] = [];
  const first = serializeComposerWrite("order", async () => { seen.push("draft"); await new Promise<void>(done => { release = done; }); throw new Error("write failed"); });
  const handled = first.catch(() => {});
  const second = serializeComposerWrite("order", async () => { seen.push("send"); return "accepted"; });
  await Promise.resolve(); await Promise.resolve(); expect(seen).toEqual(["draft"]);
  release(); await handled; expect(await second).toBe("accepted"); expect(seen).toEqual(["draft", "send"]);
});

it("resumes a retired worker whose disposable worktree was removed", async () => {
  mount({status: "exited", worktreeRemoved: true});
  fireEvent.click(await screen.findByRole("button", {name: "Continue"}));
  await waitFor(() => expect(composerApi.resume).toHaveBeenCalledWith("s"));
});
it("captures queued send identity across session navigation while draft acknowledgement is pending", async () => {
  let release: (value: ComposerState) => void = () => {};
  vi.mocked(composerApi.saveDraft).mockImplementationOnce(() => new Promise(done => { release = done; }));
  const view = mount();
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true"));
  await pasteComposer(screen.getByRole("textbox"), "old task");
  fireEvent.keyDown(screen.getByRole("textbox"), {key: "Enter"});
  const attempt = JSON.parse(localStorage.getItem("composer-request:s")!);
  state = {...emptyComposer("other"), draft: {text: "new task draft", attachmentIds: []}};
  view.rerender(<Composer session={{...session, sessionId: "other"}} busy={false} onSend={vi.fn()} onResume={vi.fn()} onInterrupt={vi.fn()} onKill={vi.fn()} onEnd={vi.fn()} onCleanup={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("new task draft"));
  await act(async () => release(emptyComposer("s")));
  await waitFor(() => expect(composerApi.enqueue).toHaveBeenCalledWith("s", attempt.id, "old task", []));
  expect(screen.getByRole("textbox")).toHaveTextContent("new task draft");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("preserves leading absolute file paths as ordinary prompt text", async () => {
  mount();
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true"));
  await pasteComposer(screen.getByRole("textbox"), "/Users/me/project/src/file.ts needs a fix");
  fireEvent.keyDown(screen.getByRole("textbox"), {key:"Enter"});
  await waitFor(() => expect(composerApi.enqueue).toHaveBeenCalledWith("s", expect.any(String), "/Users/me/project/src/file.ts needs a fix", []));
});
