import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopSettings } from "./DesktopSettings";
import { defaultSettings } from "../workbenchApi";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "../providers/ThemeProvider";
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
