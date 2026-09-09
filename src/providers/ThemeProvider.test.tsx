import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider, useTheme, THEME_STORAGE_KEY } from "./ThemeProvider";
function Probe() {
  const { theme, isDark, setTheme, persistenceError } = useTheme();
  return <><output>{theme}:{String(isDark)}</output><button onClick={() => setTheme("light")}>Use light</button><button onClick={() => setTheme("dark")}>Use dark</button>{persistenceError && <p role="alert">{persistenceError}</p>}</>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.classList.remove("dark", "light"); document.documentElement.style.removeProperty("color-scheme"); });
it.each([null, "auto", "invalid"])("defaults an absent or unsupported %s preference to dark", preference => {
  if (preference) localStorage.setItem(THEME_STORAGE_KEY, preference);
  render(<ThemeProvider><Probe /></ThemeProvider>);
  expect(screen.getByText("dark:true")).toBeVisible();
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
});
it.each(["dark", "light"])("restores the saved %s theme", theme => {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  render(<ThemeProvider><Probe /></ThemeProvider>);
  expect(document.documentElement).toHaveClass(theme);
  expect(document.documentElement.style.colorScheme).toBe(theme);
  expect(screen.getByText(`${theme}:${theme === "dark"}`)).toBeVisible();
});
it("persists switching across remount and reuses the outer provider for nested settings", () => {
  const view = render(<ThemeProvider><ThemeProvider><Probe /></ThemeProvider></ThemeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Use light" }));
  expect(document.documentElement).toHaveClass("light");
  expect(document.documentElement).not.toHaveClass("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  view.unmount(); render(<ThemeProvider><Probe /></ThemeProvider>);
  expect(screen.getByText("light:false")).toBeVisible();
  fireEvent.click(screen.getByRole("button", {name:"Use dark"}));
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
});
it("continues switching when persistence fails and reports the unsaved preference", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("Unavailable");});
  render(<ThemeProvider><Probe /></ThemeProvider>);
  fireEvent.click(screen.getByRole("button", {name:"Use light"}));
  expect(screen.getByText("light:false")).toBeVisible();
  expect(document.documentElement).toHaveClass("light");
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
});
it("requires a provider for direct theme consumers", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => render(<Probe />)).toThrow("useTheme must be used inside a <ThemeProvider>");
});
