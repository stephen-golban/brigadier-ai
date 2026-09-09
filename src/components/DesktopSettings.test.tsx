import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopSettings } from "./DesktopSettings";
import { workbenchApi, defaultSettings } from "../workbenchApi";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "../providers/ThemeProvider";
vi.mock("../workspaceApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../workspaceApi")>(),
  desktop: true,
}));
const props = {data:{displayName:"Owner",notes:[],global:defaultSettings,projects:{}},onData:vi.fn(),sessions:{},titles:{},projects:[],origins:{},jobs:[],onClose:vi.fn()};
afterEach(()=>{cleanup();document.documentElement.classList.remove("dark","light");document.documentElement.style.removeProperty("color-scheme");});
it("switches and restores Appearance without requiring App fixtures to provide a theme context", async()=>{
  const view=render(<DesktopSettings {...props} />);
  await userEvent.click(screen.getByRole("button",{name:"Appearance"}));
  await userEvent.click(screen.getByRole("button",{name:"Theme"}));
  await userEvent.click(screen.getByRole("option",{name:"Light"}));
  expect(document.documentElement).toHaveClass("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  view.unmount();render(<DesktopSettings {...props} />);
  expect(screen.getByRole("button",{name:"Theme"})).toHaveTextContent("Light");
});
it("updates the existing outer theme provider instead of creating independent settings state", async()=>{
  function Probe(){const {theme}=useTheme();return <output>{theme}</output>;}
  render(<ThemeProvider><Probe /><DesktopSettings {...props} /></ThemeProvider>);
  await userEvent.click(screen.getByRole("button",{name:"Appearance"}));
  await userEvent.click(screen.getByRole("button",{name:"Theme"}));
  await userEvent.click(screen.getByRole("option",{name:"Light"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("light"));
});

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
