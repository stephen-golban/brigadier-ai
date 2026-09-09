import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { taskSettingsApi, useTaskExecutionSettings, type TaskExecutionSettings } from "../../taskSettings";
vi.mock("../../workspaceApi", async original => ({...await original<object>(),desktop:true}));
afterEach(() => {cleanup();vi.restoreAllMocks();});
const original: TaskExecutionSettings = {sessionId:"session",projectId:"project",mode:"auto",permission:"approve",execution:{provider:"claude-code",model:"original",effort:"high"},isolated:true,baseBranch:"main",changes:[]};
function Settings() { const {settings} = useTaskExecutionSettings("session"); return <div>{settings ? `${settings.mode}:${settings.execution.model}:${settings.permission}` : "loading"}</div>; }
it("does not overwrite a newer settings event with an older initial-read response", async () => {
  let read!: (settings:TaskExecutionSettings)=>void, emit!: (settings:TaskExecutionSettings)=>void;
  vi.spyOn(taskSettingsApi,"read").mockImplementation(()=>new Promise(resolve=>{read=resolve;}));
  vi.spyOn(taskSettingsApi,"subscribe").mockImplementation(async apply=>{emit=apply;return()=>{};});
  render(<Settings />);
  await waitFor(()=>expect(taskSettingsApi.read).toHaveBeenCalledWith("session"));
  await act(async()=>emit({...original,mode:"custom",permission:"ask",execution:{provider:"codex",model:"newer",effort:"medium"}}));
  expect(screen.getByText("custom:newer:ask")).toBeVisible();
  await act(async()=>read(original));
  expect(screen.getByText("custom:newer:ask")).toBeVisible();
});
