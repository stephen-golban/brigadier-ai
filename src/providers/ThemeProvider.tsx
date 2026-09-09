/**
 * Originally adapted from janhq/jan (Copyright 2025 Menlo Research), Apache-2.0.
 * Modified: persisted explicit light/dark selection with dark as the default.
 * See THIRD_PARTY_NOTICES.md and licenses/Apache-2.0.txt.
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "dark" | "light";
export const THEME_STORAGE_KEY = "brigadier.theme";
export const THEME_CHANGED_EVENT = "brigadier-theme-changed";
export type ThemeState = { theme: Theme; isDark: boolean; setTheme: (theme: Theme) => void; persistenceError: string | null };
const ThemeContext = createContext<ThemeState | null>(null);
const validTheme = (value: string | null): Theme => value === "light" ? "light" : "dark";
function savedTheme(): Theme {
  try { return validTheme(localStorage.getItem(THEME_STORAGE_KEY)); } catch { return "dark"; }
}

/** Reuse an outer provider; standalone settings views can safely supply their own boundary. */
export function ThemeProvider({ children }: { children?: ReactNode }) {
  const parent = useContext(ThemeContext);
  return parent ? children : <ThemeRoot>{children}</ThemeRoot>;
}
function ThemeRoot({ children }: { children?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme === "light");
    root.style.colorScheme = theme;
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); setPersistenceError(null); }
    catch { setPersistenceError("Theme changed for this window, but the preference could not be saved."); }
    window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
  }, [theme]);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === THEME_STORAGE_KEY) setTheme(validTheme(event.newValue)); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return <ThemeContext.Provider value={{ theme, isDark: theme === "dark", setTheme, persistenceError }}>{children}</ThemeContext.Provider>;
}
export function useTheme(): ThemeState {
  const state = useContext(ThemeContext);
  if (!state) throw new Error("useTheme must be used inside a <ThemeProvider>");
  return state;
}
