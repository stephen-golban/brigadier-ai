import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewSession } from "../NewSession";
import { composerWorkspaceApi, type ComposerWorkspaceOptions } from "../../composerWorkspaceApi";
import * as providerCatalog from "../../providerCatalog";
import { taskSettingsApi } from "../../taskSettings";
import { pasteComposer } from "../../test/composer";
import { invalidBranchName, TaskSetupRail } from "./TaskSetupRail";

const project = {id:"rail-project",name:"Rail project",root_path:"/repo",created_at_ms:0};
const options: ComposerWorkspaceOptions = {
  isGit:true,currentBranch:"main",branches:[{name:"main",remote:false},{name:"feature",remote:false},{name:"origin/release",remote:true}],
  worktrees:[
    {path:"/repo/external",branch:"external",activeTaskId:null,activeTaskTitle:null,available:true,reason:null},
    {path:"/repo/busy",branch:"busy",activeTaskId:"task-2",activeTaskTitle:"Running review",available:false,reason:"In use"},
  ],
};
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(composerWorkspaceApi,"options").mockResolvedValue(options);
  vi.spyOn(providerCatalog,"useProviderCatalog").mockReturnValue({providers:[{id:"codex",instanceId:"codex:test",label:"Codex",version:null,models:[],modelCatalogKnown:false,efforts:[]}],error:""});
});
afterEach(() => {cleanup();vi.restoreAllMocks();localStorage.clear();});
async function mount() {
  const start = vi.fn().mockResolvedValue(true);
  render(<NewSession project={project} models={[]} disabled={false} onStart={start}/>);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Environment"})).toBeEnabled());
  await pasteComposer(screen.getByRole("textbox",{name:"Message"}),"Keep this authored draft");
  return start;
}
it("shows the rail in Auto and sends the staged local branch without changing execution mode",async()=>{
  const start=await mount();
  expect(screen.getByRole("button",{name:"Mode"})).toHaveTextContent("Auto");
  expect(screen.queryByRole("button",{name:"Execution settings"})).toBeNull();
  await userEvent.click(screen.getByRole("button",{name:"Environment"}));
  await userEvent.click(screen.getByRole("option",{name:/Work locally/}));
  await userEvent.click(screen.getByRole("button",{name:"Branch"}));
  await userEvent.click(screen.getByRole("option",{name:/Checkout/}));
  await userEvent.click(screen.getByRole("option",{name:/feature Local branch/}));
  expect(start).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button",{name:"Send"}));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({composerMode:"auto",isolated:false,baseBranch:"feature",prompt:"Keep this authored draft"}));
});
it("stages a named branch with an explicit start ref until Send",async()=>{
  const start=await mount();
  await userEvent.click(screen.getByRole("button",{name:"Branch"}));
  await userEvent.click(screen.getByRole("option",{name:/New branch/}));
  await userEvent.type(screen.getByRole("textbox",{name:"New branch name"}),"feature/rail");
  await userEvent.click(screen.getByRole("button",{name:"Starting point"}));
  await userEvent.click(screen.getByRole("option",{name:/origin\/release/}));
  await userEvent.click(screen.getByRole("button",{name:"Use new branch"}));
  expect(screen.getByRole("button",{name:"Branch"})).toHaveTextContent("New: feature/rail");
  expect(start).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button",{name:"Send"}));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({isolated:true,newBranch:"feature/rail",baseBranch:"origin/release"}));
});
it("lists external worktrees and blocks the one owned by active work",async()=>{
  const start=await mount();
  await userEvent.click(screen.getByRole("button",{name:"Environment"}));
  await userEvent.click(screen.getByRole("option",{name:/Existing worktree/}));
  expect(screen.getByRole("option",{name:/Running review/})).toBeDisabled();
  await userEvent.click(screen.getByRole("option",{name:/external \/repo\/external/}));
  expect(screen.getByRole("button",{name:"Branch"})).toHaveTextContent("Current (external)");
  await userEvent.click(screen.getByRole("button",{name:"Send"}));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({workspacePath:"/repo/external",isolated:false,composerMode:"auto"}));
});
it("keeps an unavailable remembered worktree visible and blocks Auto Send until corrected",async()=>{
  await taskSettingsApi.savePreferences(project.id,{mode:"auto",permission:"approve",manual:{provider:"",model:null,effort:null},isolated:false,baseBranch:null,workspacePath:"/repo/deleted"});
  await mount();
  expect(screen.getByRole("button",{name:"Environment"})).toHaveTextContent("deleted");
  expect(screen.getByRole("button",{name:"Send"})).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
  await userEvent.click(screen.getByRole("button",{name:"Environment"}));
  await userEvent.click(screen.getByRole("option",{name:/New worktree/}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Send"})).toBeEnabled());
});
it.each(["", "bad name", "../escape", "feature..bad", "feature/", "-option", "branch.lock", "foo@{bar", "bad\\name"])("rejects invalid staged branch %s",name=>expect(invalidBranchName(name)).toBe(true));
it("permits hierarchical branch names",()=>expect(invalidBranchName("feature/composer-rail")).toBe(false));


it.each(["success", "failure"] as const)("ignores an older workspace refresh %s after newer occupancy information arrives", async staleOutcome => {
  await taskSettingsApi.savePreferences(project.id, {mode:"auto",permission:"approve",manual:{provider:"",model:null,effort:null},isolated:false,baseBranch:null,workspacePath:"/repo/external"});
  await mount();
  await waitFor(() => expect(screen.getByRole("button", {name:"Send"})).toBeEnabled());
  let finishOlder!: (value:ComposerWorkspaceOptions) => void;
  let failOlder!: (reason:Error) => void;
  let finishLatest!: (value:ComposerWorkspaceOptions) => void;
  vi.mocked(composerWorkspaceApi.options)
    .mockImplementationOnce(() => new Promise((resolve,reject) => {finishOlder=resolve;failOlder=reject;}))
    .mockImplementationOnce(() => new Promise(resolve => {finishLatest=resolve;}));
  fireEvent.focus(window);
  fireEvent.focus(window);
  await act(async () => finishLatest({...options,worktrees:[{...options.worktrees[0]!,branch:"fresh-external",available:false,activeTaskId:"new-task",reason:"Workspace now belongs to another task"}]}));
  expect(screen.getByRole("button", {name:"Branch"})).toHaveTextContent("Current (fresh-external)");
  expect(screen.getByRole("button", {name:"Send"})).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Workspace now belongs to another task");
  await act(async () => {if (staleOutcome === "success") finishOlder(options); else failOlder(new Error("Outdated refresh failed"));});
  expect(screen.getByRole("button", {name:"Branch"})).toHaveTextContent("Current (fresh-external)");
  expect(screen.getByRole("button", {name:"Send"})).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Workspace now belongs to another task");
  expect(screen.queryByText("Outdated refresh failed")).toBeNull();
});

it.each(["environment", "checkout", "new branch"] as const)("closes an open %s setup view and prevents selection while disabled", async viewName => {
  const change = vi.fn();
  const props = {project,picks:{mode:"auto" as const,permission:"approve" as const,manual:{provider:"",model:null,effort:null},isolated:true,baseBranch:null},options,onChange:change};
  const view = render(<TaskSetupRail {...props} disabled={false} />);
  const trigger = viewName === "environment" ? "Environment" : "Branch";
  await userEvent.click(screen.getByRole("button", {name:trigger}));
  if (viewName === "environment") {
    await userEvent.click(screen.getByRole("option", {name:/Existing worktree/}));
    expect(screen.getByRole("option", {name:/external \/repo\/external/})).toBeEnabled();
  } else if (viewName === "checkout") {
    await userEvent.click(screen.getByRole("option", {name:/Checkout/}));
    expect(screen.getByRole("option", {name:/feature Local branch/})).toBeEnabled();
  } else {
    await userEvent.click(screen.getByRole("option", {name:/New branch/}));
    await userEvent.type(screen.getByRole("textbox", {name:"New branch name"}), "feature/unsent");
    expect(screen.getByRole("button", {name:"Use new branch"})).toBeEnabled();
  }
  expect(screen.getByRole("dialog")).toBeVisible();
  view.rerender(<TaskSetupRail {...props} disabled />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", {name:trigger})).toBeDisabled();
  await userEvent.click(screen.getByRole("button", {name:trigger}));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(change).not.toHaveBeenCalled();
  view.rerender(<TaskSetupRail {...props} disabled={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", {name:trigger})).toBeEnabled();
});
