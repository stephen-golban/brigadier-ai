import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopSettings } from "./DesktopSettings";
import { workbenchApi, defaultSettings } from "../workbenchApi";
vi.mock("../workspaceApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../workspaceApi")>(),
  desktop: true,
}));
const props = {data:{displayName:"Owner",notes:[],global:defaultSettings,projects:{}},onData:vi.fn(),sessions:{},titles:{},projects:[],origins:{},jobs:[],onClose:vi.fn()};
afterEach(()=>{cleanup();});
it("saves keep-awake changes and retains the saved value on failure", async () => {
  localStorage.setItem("brigadier:settings-page", JSON.stringify("general"));
  const onData = vi.fn();
  const save = vi.spyOn(workbenchApi, "setKeepAwake").mockResolvedValue({ ...props.data, keepAwake: true });
  const view = render(<DesktopSettings {...props} onData={onData} />);
  const toggle = screen.getByRole("switch", { name: "Keep machine awake while working" });
  expect(toggle).not.toBeChecked();
  await userEvent.click(toggle);
  await waitFor(() => expect(onData).toHaveBeenCalledWith(expect.objectContaining({ keepAwake: true })));
  expect(save).toHaveBeenCalledWith(true);
  view.rerender(<DesktopSettings {...props} data={{ ...props.data, keepAwake: true }} onData={onData} />);
  expect(toggle).toBeChecked();
  save.mockRejectedValueOnce(new Error("Could not save preference"));
  await userEvent.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save preference");
  expect(toggle).toBeChecked();
  expect(toggle).not.toBeDisabled();
  save.mockRestore();
});
