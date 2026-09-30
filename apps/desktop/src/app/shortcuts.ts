import { useApp } from "@/state/store";

/** The app's keyboard shortcuts as the tooltips and menus show them, for this platform. */
export function useShortcuts() {
  const mac = useApp((s) => s.info?.platform === "macos");
  return {
    mac,
    sidebar: mac ? "⌘B" : "Ctrl+B",
    search: mac ? "⌘K" : "Ctrl+K",
    settings: mac ? "⌘," : "Ctrl+,",
    inspector: mac ? "⌥⌘I" : "Ctrl+Alt+I",
  };
}
