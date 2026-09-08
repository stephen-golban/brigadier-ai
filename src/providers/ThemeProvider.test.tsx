import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThemeProvider, useTheme, THEME_STORAGE_KEY } from "./ThemeProvider";
function Probe() {
  const { theme, isDark } = useTheme();
  return (
    <output>
      {theme}:{String(isDark)}
    </output>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
});
it.each(["light", "auto", "dark", "invalid"])(
  "renders dark and migrates stored %s preferences",
  (preference) => {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByText("dark:true")).toBeVisible();
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  },
);
it("stays dark when storage is unavailable without querying the OS theme", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Unavailable");
  });
  const systemTheme = vi.spyOn(window, "matchMedia");
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  expect(screen.getByText("dark:true")).toBeVisible();
  expect(document.documentElement).toHaveClass("dark");
  expect(systemTheme).not.toHaveBeenCalled();
});
it("requires a provider for theme consumers", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => render(<Probe />)).toThrow(
    "useTheme must be used inside a <ThemeProvider>",
  );
});
