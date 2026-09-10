import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as providerCatalog from "../../providerCatalog";
import userEvent from "@testing-library/user-event";
import { taskSettingsApi } from "../../taskSettings";
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
  vi.spyOn(providerCatalog, "useProviderCatalog").mockReturnValue({ providers: [], error: "", loaded: true});
  vi.spyOn(taskSettingsApi, "read").mockImplementation(async sessionId => ({ sessionId, projectId: "p", mode: "custom", permission: "approve", execution: {provider: "claude-code", model: "exact-model", effort: null}, isolated: false, baseBranch: null, changes: [] }));
  vi.spyOn(taskSettingsApi, "subscribe").mockResolvedValue(() => {});
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
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
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
  await waitFor(() => expect(screen.getByRole("button", { name: "send this turn" })).toBeEnabled());
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

const catalog: providerCatalog.ProviderCatalogEntry[] = [
  { id: "claude-code", label: "Claude Code", instanceId: "claude:test", version: null, modelCatalogKnown: true, efforts: [], models: [{ id: "exact-model", label: "Original model", efforts: ["low", "high"] }] },
  { id: "codex", label: "Codex", instanceId: "codex:test", version: null, modelCatalogKnown: true, efforts: [], models: [{ id: "next-model", label: "Next model", efforts: ["minimal", "medium", "xhigh"] }] },
];
it("changes only subsequent execution settings while the current response remains active", async () => {
  vi.mocked(providerCatalog.useProviderCatalog).mockReturnValue({providers:catalog, error: "", loaded: true});
  const update = vi.spyOn(taskSettingsApi,"update").mockImplementation(async (_id,next) => next);
  mount({busy:true});
  await waitFor(() => expect(screen.getByRole("button",{name:"Execution settings"})).toBeEnabled());
  await userEvent.click(screen.getByRole("button",{name:"Execution settings"}));
  await userEvent.click(screen.getByRole("button",{name:/Codex/}));
  await waitFor(() => expect(update).toHaveBeenCalledWith("s",expect.objectContaining({execution:{provider:"codex",model:null,effort:null}})));
  await userEvent.click(screen.getByRole("option",{name:"Next model"}));
  await waitFor(() => expect(screen.getByRole("slider")).toBeEnabled());
  fireEvent.change(screen.getByRole("slider"),{target:{value:"2"}});
  await waitFor(() => expect(update).toHaveBeenLastCalledWith("s",expect.objectContaining({execution:{provider:"codex",model:"next-model",effort:"xhigh"}})));
  expect(screen.getByRole("button",{name:"Stop task"})).toBeEnabled();
  expect(composerApi.stop).not.toHaveBeenCalled();
  expect(composerApi.enqueue).not.toHaveBeenCalled();
});

it("edits a queued Custom execution snapshot without changing task execution settings", async () => {
  vi.mocked(providerCatalog.useProviderCatalog).mockReturnValue({providers:catalog, error: "", loaded: true});
  state.queue = [{id:"queued",text:"Review next",attachmentIds:["stable-file"],status:"queued",turnId:null,error:null,execution:{provider:"claude-code",model:"exact-model",effort:"high"}}];
  const updateTask = vi.spyOn(taskSettingsApi,"update").mockImplementation(async (_id,next) => next);
  const updateQueue = vi.spyOn(composerApi,"update").mockImplementation(async (_session,id,text,attachmentIds,execution) => {
    state = {...state,revision:state.revision+1,queue:state.queue.map(item=>item.id===id ? {...item,text,attachmentIds,execution} : item)};
    return state;
  });
  mount({busy:true});
  await userEvent.click(await screen.findByRole("button",{name:"Edit queued message"}));
  fireEvent.change(screen.getByRole("textbox",{name:"Edit queued message"}),{target:{value:"Review the changed scope"}});
  await userEvent.click(screen.getAllByRole("button",{name:"Execution settings"})[0]!);
  await userEvent.click(screen.getByRole("button",{name:/Codex/}));
  await userEvent.click(screen.getByRole("option",{name:"Next model"}));
  fireEvent.change(screen.getByRole("slider"),{target:{value:"1"}});
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button",{name:"Save"}));
  await waitFor(() => expect(updateQueue).toHaveBeenCalledWith("s","queued","Review the changed scope",["stable-file"],{provider:"codex",model:"next-model",effort:"medium"}));
  expect(updateTask).not.toHaveBeenCalled();
  expect(screen.getByRole("button",{name:"Execution settings"})).toHaveTextContent("Original model");
});

it("Steer now invokes active steering and Stop remains usable while that acknowledgement is pending", async () => {
  state.queue = [{id:"steering",text:"Prioritize the bug",attachmentIds:[],status:"queued",turnId:null,error:null}];
  let complete!: (state: ComposerState) => void;
  const steer = vi.spyOn(composerApi,"steer").mockImplementation(() => new Promise(resolve=>{complete=resolve;}));
  mount({busy:true});
  await userEvent.click(await screen.findByRole("button",{name:"Steer now"}));
  await waitFor(() => expect(steer).toHaveBeenCalledWith("s","steering"));
  expect(composerApi.enqueue).not.toHaveBeenCalled();
  expect(screen.getByRole("button",{name:"Stop task"})).toBeEnabled();
  await userEvent.click(screen.getByRole("button",{name:"Stop task"}));
  await waitFor(() => expect(composerApi.stop).toHaveBeenCalledOnce());
  await act(async () => complete(state));
  expect(screen.getByText("Queue paused because you stopped")).toBeVisible();
});

it("takes over Auto once using effective execution settings and removes the route back", async () => {
  vi.mocked(providerCatalog.useProviderCatalog).mockReturnValue({providers:catalog, error: "", loaded: true});
  vi.mocked(taskSettingsApi.read).mockResolvedValue({sessionId:"s",projectId:"p",mode:"auto",permission:"approve",execution:{provider:"codex",model:"next-model",effort:"xhigh"},isolated:true,baseBranch:"main",changes:[]});
  const update = vi.spyOn(taskSettingsApi,"update").mockImplementation(async (_id,next)=>next);
  mount({busy:true});
  await userEvent.click(await screen.findByRole("button",{name:"Mode"}));
  await userEvent.click(screen.getByRole("option",{name:/Custom/}));
  await waitFor(() => expect(update).toHaveBeenCalledWith("s",expect.objectContaining({mode:"custom",execution:{provider:"codex",model:"next-model",effort:"xhigh"},isolated:true,baseBranch:"main"})));
  await userEvent.click(screen.getByRole("button",{name:"Mode"}));
  expect(screen.getByRole("option",{name:/Auto/})).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button",{name:"Execution settings"}));
  expect(screen.getByRole("option",{name:"Next model"})).toHaveAttribute("aria-selected","true");
  expect(screen.queryByRole("button",{name:"Branch"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Environment"})).toBeNull();
});

it("shows Stopping and prevents duplicate Stop requests until its acknowledgement arrives", async () => {
  let complete!: (state:ComposerState)=>void;
  vi.mocked(composerApi.stop).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
  mount({busy:true});
  await userEvent.click(await screen.findByRole("button",{name:"Stop task"}));
  const stopping = screen.getByRole("button",{name:"Stopping task"});
  expect(stopping).toBeDisabled();
  fireEvent.click(stopping);
  expect(composerApi.stop).toHaveBeenCalledTimes(1);
  await act(async()=>complete({...state,revision:state.revision+1,stopped:true,paused:true}));
  expect(screen.getByText("Queue paused because you stopped")).toBeVisible();
});
