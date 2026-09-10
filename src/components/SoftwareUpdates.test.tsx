import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SoftwareUpdate } from "../softwareUpdates";
const state = vi.hoisted(() => ({ rows: [] as SoftwareUpdate[], checking: false, error: "", checkedAt: 1 }));
vi.mock("../softwareUpdates", () => ({ useSoftwareUpdates: () => state, refreshSoftwareUpdates: vi.fn() }));
vi.mock("../workspaceApi", () => ({ desktop: true, errorMessage: String }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
import { SoftwareStatus, SoftwareUpdates } from "./SoftwareUpdates";
import { openUrl } from "@tauri-apps/plugin-opener";
beforeEach(() => {
  state.rows = [{ id: "codex:default", provider: "codex", label: "Codex", installedVersion: "1.0.0", latestVersion: "1.0.0", updateAvailable: false, releaseUrl: "https://github.com/openai/codex/releases", error: null }];
  state.checking = false;
  state.error = "";
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("keeps connected CLI icons visible without an update and opens Updates settings", async () => {
  render(<SoftwareStatus />);
  expect(screen.getByRole("img", { name: "Codex" })).toBeVisible();
  const listener = vi.fn();
  window.addEventListener("brigadier-settings", listener);
  try {
    await userEvent.click(screen.getByRole("button", { name: "Software updates: Codex 1.0.0" }));
    expect(listener.mock.calls[0][0].detail).toEqual({ page: "updates" });
  } finally { window.removeEventListener("brigadier-settings", listener); }
});
it("includes Brigadier in the update indicator and links to the available release", async () => {
  state.rows.push({ ...state.rows[0], id: "brigadier", provider: "brigadier", label: "Brigadier", latestVersion: "1.1.0", updateAvailable: true, releaseUrl: "https://github.com/stephen-golban/brigadier-ai/releases" });
  render(<><SoftwareStatus /><SoftwareUpdates /></>);
  expect(screen.getByRole("button", { name: "Software updates: Brigadier updates available" })).toBeVisible();
  expect(screen.getByText("1.0.0 → 1.1.0")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "View Brigadier update" }));
  expect(openUrl).toHaveBeenCalledWith("https://github.com/stephen-golban/brigadier-ai/releases");
});
it("does not report a failed update check as up to date", () => {
  state.rows[0] = { ...state.rows[0], error: "Could not check for updates. Try again later.", latestVersion: null };
  render(<SoftwareUpdates />);
  expect(screen.getByText("Could not check for updates. Try again later.")).toBeVisible();
  expect(screen.queryByLabelText("Up to date")).toBeNull();
  expect(screen.queryByRole("button", { name: "View Codex update" })).toBeNull();
});
