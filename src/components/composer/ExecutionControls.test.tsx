import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExecutionControl, ModeControl, PermissionControl, supportedExecutionEfforts } from "./ExecutionControls";
import type { ExecutionSelection } from "../../taskSettings";
import * as providerCatalog from "../../providerCatalog";
import { NewSession } from "../NewSession";
import { pasteComposer } from "../../test/composer";
import { taskSettingsApi } from "../../taskSettings";
import { workbenchApi } from "../../workbenchApi";
import { workspaceApi } from "../../workspaceApi";

const providers: providerCatalog.ProviderCatalogEntry[] = [
  { id: "claude-code", label: "Claude Code", instanceId: "claude:test", version: null, modelCatalogKnown: true, efforts: [], models: [{ id: "model-a", label: "Model A", efforts: ["low", "high"] }] },
  { id: "codex", label: "Codex", instanceId: "codex:test", version: null, modelCatalogKnown: true, efforts: [], models: [{ id: "model-b", label: "Model B", efforts: ["minimal", "medium", "xhigh"] }] },
];
const project = { id: "p", name: "Project", root_path: "/repo", created_at_ms: 0 };
const models: [] = [];
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(providerCatalog, "useProviderCatalog").mockReturnValue({ providers, error: "" });
  vi.spyOn(workbenchApi, "gitDetails").mockResolvedValue({ branches: ["main", "feature"], localBranches: ["main", "feature"], remotes: [], stashes: [], history: "" });
  vi.spyOn(workspaceApi, "git").mockResolvedValue({ branch: "main", changes: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
function Controls({ started = false }: { started?: boolean }) {
  const [selection, setSelection] = useState<ExecutionSelection>({ provider: "claude-code", model: null, effort: null });
  return <ExecutionControl mode="custom" selection={selection} providers={providers} started={started} onMode={() => {}} onChange={setSelection} />;
}
it("keeps one card open across provider/model selection and uses only the chosen model's effort steps", async () => {
  render(<Controls />);
  await userEvent.click(screen.getByRole("button", { name: "Execution settings" }));
  await userEvent.click(screen.getByRole("option", { name: "Model A" }));
  expect(screen.getByRole("dialog", { name: "Provider, model and effort" })).toBeVisible();
  const effort = screen.getByRole("slider", { name: "Reasoning effort" });
  expect(effort).toHaveAttribute("max", "1");
  fireEvent.change(effort, { target: { value: "1" } });
  expect(effort).toHaveAttribute("aria-valuetext", "high");
  await userEvent.click(screen.getByRole("button", { name: /Codex/ }));
  expect(screen.queryByRole("option", { name: "Model A" })).toBeNull();
  await userEvent.click(screen.getByRole("option", { name: "Model B" }));
  expect(screen.getByRole("slider")).toHaveAttribute("max", "2");
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Provider default");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Execution settings" })).toHaveTextContent("Model B");
});
it("keeps Mode visible and explains why a started Custom task cannot return to Auto", async () => {
  const change = vi.fn();
  render(<ModeControl value="custom" started onChange={change} />);
  await userEvent.click(screen.getByRole("button", { name: "Mode" }));
  const auto = screen.getByRole("option", { name: /Auto/ });
  expect(auto).toBeDisabled();
  expect(auto).toHaveTextContent("Auto is available when starting a new task");
  await userEvent.click(auto);
  expect(change).not.toHaveBeenCalled();
});
it("allows changing mode in both directions before Send and closes each choice", async () => {
  function Modes() { const [mode, setMode] = useState<"auto" | "custom">("auto"); return <ModeControl value={mode} onChange={setMode} />; }
  render(<Modes />);
  await userEvent.click(screen.getByRole("button", {name:"Mode"}));
  await userEvent.click(screen.getByRole("option", {name:/Custom/}));
  expect(screen.getByRole("button", {name:"Mode"})).toHaveTextContent("Custom");
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(screen.getByRole("button", {name:"Mode"}));
  await userEvent.click(screen.getByRole("option", {name:/Auto/}));
  expect(screen.getByRole("button", {name:"Mode"})).toHaveTextContent("Auto");
});
it("presents the same three policy meanings independent of provider", async () => {
  const change = vi.fn();
  render(<PermissionControl value="approve" onChange={change} />);
  await userEvent.click(screen.getByRole("button", { name: "Permissions" }));
  expect(screen.getAllByRole("option")).toHaveLength(3);
  await userEvent.click(screen.getByRole("option", { name: /Ask for approval/ }));
  expect(change).toHaveBeenCalledWith("ask");
});
describe("project settings", () => {
  it("starts Auto immediately with the inherited project and Brigadier permission policy", async () => {
    const start = vi.fn();
    render(<NewSession project={project} models={models} disabled={false} onStart={start} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true"));
    expect(screen.getByRole("button", { name: "Branch" })).toHaveTextContent("Current (main)");
    expect(screen.queryByRole("button", { name: "Execution settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Permissions" })).toHaveTextContent("Approve for me");
    await pasteComposer(screen.getByRole("textbox"), "Build the approved feature");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p", composerMode: "auto", composerPermission: "approve", model: null, isolated: true }));
  });
  it("remembers manual choices across remounts and Auto never overwrites them", async () => {
    const view = render(<NewSession project={project} models={models} disabled={false} onStart={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Mode" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Mode" }));
    await userEvent.click(screen.getByRole("option", { name: /Custom/ }));
    await userEvent.click(screen.getByRole("button", { name: "Execution settings" }));
    await userEvent.click(screen.getByRole("button", { name: /Codex/ }));
    await userEvent.click(screen.getByRole("option", { name: "Model B" }));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Mode" }));
    await userEvent.click(screen.getByRole("option", { name: /Auto/ }));
    await waitFor(async () => expect((await taskSettingsApi.preferences("p")).manual).toEqual({ provider: "codex", model: "model-b", effort: "xhigh" }));
    view.unmount();
    render(<NewSession project={project} models={models} disabled={false} onStart={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Mode" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Mode" }));
    await userEvent.click(screen.getByRole("option", { name: /Custom/ }));
    await userEvent.click(screen.getByRole("button", { name: "Execution settings" }));
    expect(screen.getByRole("option", { name: "Model B" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "xhigh");
    expect((await taskSettingsApi.preferences("another-project")).mode).toBe("auto");
  });
  it("makes unavailable saved branches visible and blocks sending until corrected", async () => {
    await taskSettingsApi.savePreferences("p", { mode: "custom", permission: "ask", manual: { provider: "codex", model: "model-b", effort: "medium" }, isolated: true, baseBranch: "deleted" });
    render(<NewSession project={project} models={models} disabled={false} onStart={vi.fn()} />);
    await screen.findByText(/Saved branch “deleted” is unavailable/);
    await pasteComposer(screen.getByRole("textbox"), "Start");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Branch" }));
    await userEvent.click(screen.getByRole("option", { name: /main/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  });
});

it("disables exact-model editing during a pending settings write", async () => {
  const entries = [{...providers[0]!,modelCatalogKnown:false}];
  const props = {mode:"custom" as const,selection:{provider:"claude-code",model:"manual",effort:null},providers:entries,onMode:vi.fn(),onChange:vi.fn()};
  const view = render(<ExecutionControl {...props} />);
  await userEvent.click(screen.getByRole("button",{name:"Execution settings"}));
  expect(screen.getByRole("textbox",{name:"Exact model ID"})).toBeEnabled();
  view.rerender(<ExecutionControl {...props} disabled />);
  expect(screen.getByRole("textbox",{name:"Exact model ID"})).toBeDisabled();
});

it("manual changes update future project defaults without reconfiguring another running task", async () => {
  await taskSettingsApi.savePreferences("p",{mode:"custom",permission:"approve",manual:{provider:"claude-code",model:"model-a",effort:null},isolated:false,baseBranch:"feature"});
  const {Composer} = await import('../Composer');
  const {ZERO_USAGE} = await import('../../wire');
  const session = {sessionId:"first",projectId:"p",status:"running" as const,model:"model-a",instanceId:"claude:test",cwd:"/repo",providerSessionId:"native",worktreePath:null,branch:"feature",worktreeRemoved:false,resumed:false,busy:true,lastTurnId:null,lastStop:null,costUsd:0,usage:ZERO_USAGE,rowsTotal:0,rowsDropped:0,startedAtMs:0,endedAtMs:null,exitCode:null,lastMessage:null,lastEventSeq:0};
  const callbacks = {busy:false,onSend:vi.fn(),onResume:vi.fn(),onInterrupt:vi.fn(),onKill:vi.fn(),onEnd:vi.fn(),onCleanup:vi.fn()};
  const view = render(<><Composer {...callbacks} session={session} /><Composer {...callbacks} session={{...session,sessionId:"second"}} /></>);
  await userEvent.click(screen.getAllByRole("button",{name:"Permissions"})[0]!);
  await userEvent.click(screen.getByRole("option",{name:/Full access/}));
  await waitFor(async()=>expect((await taskSettingsApi.preferences("p")).permission).toBe("full"));
  const controls = screen.getAllByRole("button",{name:"Permissions"});
  expect(controls[0]).toHaveTextContent("Full access");
  expect(controls[1]).toHaveTextContent("Approve for me");
  view.unmount();
  render(<NewSession project={project} models={models} disabled={false} onStart={vi.fn()} />);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Permissions"})).toHaveTextContent("Full access"));
  expect(screen.getByRole("button",{name:"Environment"})).toHaveTextContent("Work locally");
  expect(screen.getByRole("button",{name:"Branch"})).toHaveTextContent("feature");
  expect((await taskSettingsApi.preferences("different-project")).permission).toBe("approve");
});

it("keeps a removed saved effort visible and blocks Send until the owner chooses a supported value", async () => {
  await taskSettingsApi.savePreferences("p",{mode:"custom",permission:"approve",manual:{provider:"codex",model:"model-b",effort:"retired-effort"},isolated:true,baseBranch:null});
  const start = vi.fn();
  render(<NewSession project={project} models={models} disabled={false} onStart={start} />);
  await screen.findByText(/Saved effort “retired-effort” is unavailable/);
  await pasteComposer(screen.getByRole("textbox"),"Run the task");
  expect(screen.getByRole("button",{name:"Send"})).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("textbox"),{key:"Enter"});
  expect(start).not.toHaveBeenCalled();
  expect((await taskSettingsApi.preferences("p")).manual.effort).toBe("retired-effort");
  await userEvent.click(screen.getByRole("button",{name:"Execution settings"}));
  const slider = screen.getByRole("slider",{name:"Reasoning effort"});
  expect(slider).toHaveAttribute("aria-invalid","true");
  expect(slider).toHaveAttribute("aria-valuetext","Unavailable saved effort: retired-effort");
  expect(slider).toHaveAttribute("max","2");
  fireEvent.change(slider,{target:{value:"1"}});
  await waitFor(()=>expect(screen.queryAllByText(/Saved effort “retired-effort” is unavailable/)).toHaveLength(0));
  expect(slider).toHaveAttribute("aria-valuetext","medium");
  await userEvent.keyboard("{Escape}");
  await waitFor(()=>expect(screen.getByRole("button",{name:"Send"})).toBeEnabled());
  await userEvent.click(screen.getByRole("button",{name:"Send"}));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({options:{effort:"medium"}}));
});

it("does not offer provider-wide efforts for a model that explicitly supports none", async () => {
  vi.mocked(providerCatalog.useProviderCatalog).mockReturnValue({providers:[{...providers[1]!,efforts:["low","high"],models:[{id:"no-effort",label:"No effort model",efforts:[]}]}],error:""});
  await taskSettingsApi.savePreferences("p",{mode:"custom",permission:"approve",manual:{provider:"codex",model:"no-effort",effort:"high"},isolated:true,baseBranch:null});
  const start=vi.fn();
  render(<NewSession project={project} models={models} disabled={false} onStart={start} />);
  await screen.findByText(/Saved effort “high” is unavailable/);
  await pasteComposer(screen.getByRole("textbox"),"Run the task");
  expect(screen.getByRole("button",{name:"Send"})).toBeDisabled();
  await userEvent.click(screen.getByRole("button",{name:"Execution settings"}));
  expect(screen.queryByRole("slider")).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"Reset effort to default"}));
  await userEvent.keyboard("{Escape}");
  await waitFor(()=>expect(screen.getByRole("button",{name:"Send"})).toBeEnabled());
  await userEvent.click(screen.getByRole("button",{name:"Send"}));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({model:"no-effort"}));
  expect(start.mock.calls[0]![0].options).toBeUndefined();
});

it("Auto retains an unavailable saved manual effort without using or blocking on it", async () => {
  await taskSettingsApi.savePreferences("p",{mode:"auto",permission:"approve",manual:{provider:"codex",model:"model-b",effort:"retired-effort"},isolated:true,baseBranch:null});
  const start=vi.fn();
  render(<NewSession project={project} models={models} disabled={false} onStart={start} />);
  await waitFor(()=>expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable","true"));
  await pasteComposer(screen.getByRole("textbox"),"Run automatically");
  await waitFor(()=>expect(screen.getByRole("button",{name:"Send"})).toBeEnabled());
  expect(screen.queryByText(/Saved effort/)).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"Send"}));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({composerMode:"auto",model:null}));
  expect(start.mock.calls[0]![0].options).toBeUndefined();
  expect((await taskSettingsApi.preferences("p")).manual.effort).toBe("retired-effort");
});

it("recognizes the resolved native model inherited from Auto as a catalog alias", async () => {
  const entries = [{ ...providers[0]!, models: [{ id: "opus", resolvedId: "claude-opus-5[1m]", label: "Opus", efforts: ["low", "high"] }] }];
  vi.mocked(providerCatalog.useProviderCatalog).mockReturnValue({providers:entries,error:""});
  await taskSettingsApi.savePreferences("p", {mode:"custom",permission:"approve",manual:{provider:"claude-code",model:"claude-opus-5[1m]",effort:"high"},isolated:true,baseBranch:null});
  render(<NewSession project={project} models={models} disabled={false} onStart={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", {name:"Execution settings"})).toBeEnabled());
  await pasteComposer(screen.getByRole("textbox"), "Continue with the actual model");
  await userEvent.click(screen.getByRole("button", {name:"Execution settings"}));
  expect(screen.getByRole("option", {name:"Opus"})).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "high");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", {name:"Send"})).toBeEnabled();
});


it("shows unknown default without selecting an effort step and resets an explicit choice to null", async () => {
  render(<Controls />);
  await userEvent.click(screen.getByRole("button", {name:"Execution settings"}));
  await userEvent.click(screen.getByRole("option", {name:"Model A"}));
  const slider = screen.getByRole("slider");
  expect(slider.parentElement).toHaveClass("is-default");
  expect(slider).toHaveStyle({"--effort-fill":"0%"});
  expect(screen.getByRole("button", {name:"Use low effort"})).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(screen.getByRole("button", {name:"Use high effort"}));
  expect(slider.parentElement).not.toHaveClass("is-default");
  expect(slider).toHaveAttribute("aria-valuetext", "high");
  await userEvent.click(screen.getByRole("button", {name:"Reset effort to default"}));
  expect(slider).toHaveAttribute("aria-valuetext", "Provider default");
  expect(slider.parentElement).toHaveClass("is-default");
});
it("uses provider segments and selects a model with one actual supported effort", async () => {
  const change = vi.fn();
  render(<ExecutionControl selection={{provider:"codex",model:"single",effort:null}} providers={[{...providers[1]!,models:[{id:"single",label:"Single level",efforts:["high"]}]}]} onChange={change} />);
  await userEvent.click(screen.getByRole("button", {name:"Execution settings"}));
  expect(screen.getByRole("button", {name:/Codex/})).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("option", {name:/Codex/})).toBeNull();
  expect(screen.getAllByRole("button", {name:/Use .* effort/})).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", {name:"Use high effort"}));
  expect(change).toHaveBeenCalledWith({provider:"codex",model:"single",effort:"high"});
  expect(screen.queryByRole("option", {name:/Auto|Custom/})).toBeNull();
});


it("keeps the selected provider's model and effort when its segment is pressed again", async () => {
  const change = vi.fn();
  render(<ExecutionControl selection={{provider:"codex",model:"model-b",effort:"xhigh"}} providers={providers} onChange={change} />);
  await userEvent.click(screen.getByRole("button", {name:"Execution settings"}));
  await userEvent.click(screen.getByRole("button", {name:/Codex/}));
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("option", {name:"Model B"})).toHaveAttribute("aria-selected", "true");
});
it("begins keyboard effort selection at the first supported step from unknown Default", async () => {
  render(<Controls />);
  await userEvent.click(screen.getByRole("button", {name:"Execution settings"}));
  await userEvent.click(screen.getByRole("option", {name:"Model A"}));
  const slider = screen.getByRole("slider");
  fireEvent.keyDown(slider, {key:"ArrowRight"});
  expect(slider).toHaveAttribute("aria-valuetext", "low");
});


it("orders actual provider and model effort levels monotonically without changing the catalog", () => {
  const provider = {...providers[1]!, efforts:["high","low","max","medium","ultra","xhigh"], models:[{id:"ordered",resolvedId:"native-ordered",label:"Ordered model",efforts:["future-b","high","none","future-a","medium","minimal","ultra","low","max","xhigh"]}]};
  expect(supportedExecutionEfforts(provider, null)).toEqual(["low","medium","high","xhigh","max","ultra"]);
  expect(supportedExecutionEfforts(provider, "ordered")).toEqual(["none","minimal","low","medium","high","xhigh","max","ultra","future-b","future-a"]);
  expect(supportedExecutionEfforts(provider, "native-ordered")).toEqual(supportedExecutionEfforts(provider, "ordered"));
  expect(supportedExecutionEfforts({...provider,modelCatalogKnown:false}, "exact-unknown")).toEqual(["low","medium","high","xhigh","max","ultra"]);
  expect(provider.efforts).toEqual(["high","low","max","medium","ultra","xhigh"]);
  expect(provider.models[0]!.efforts[0]).toBe("future-b");
});
