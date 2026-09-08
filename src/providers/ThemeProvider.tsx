/**
 * Originally adapted from janhq/jan (Copyright 2025 Menlo Research), Apache-2.0.
 * Modified: replaced OS/light theme switching with the dark-only token contract.
 * See THIRD_PARTY_NOTICES.md and licenses/Apache-2.0.txt.
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";

export type Theme = "dark";
export const THEME_STORAGE_KEY = "brigadier.theme";
export type ThemeState = { theme: Theme; isDark: true };
const ThemeContext = createContext<ThemeState | null>(null);
const dark: ThemeState = { theme: "dark", isDark: true };

export function ThemeProvider({ children }: { children?: ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.classList.add("dark");
    try {
      // Migrate earlier light/system preferences to the dark-only UI.
      localStorage.setItem(THEME_STORAGE_KEY, "dark");
    } catch {
      // Rendering remains dark when browser storage is unavailable.
    }
  }, []);
  return <ThemeContext.Provider value={dark}>{children}</ThemeContext.Provider>;
}
export function useTheme(): ThemeState {
  const state = useContext(ThemeContext);
  if (!state) throw new Error("useTheme must be used inside a <ThemeProvider>");
  return state;
}
