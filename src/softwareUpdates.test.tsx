import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { notify } from "./desktopApi";
import { refreshSoftwareUpdates, updateSoftware, useSoftwareUpdates, type SoftwareUpdate } from "./softwareUpdates";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./workspaceApi", () => ({ desktop: true, errorMessage: String }));
vi.mock("./desktopApi", () => ({ notify: vi.fn() }));

const row: SoftwareUpdate = { id: "codex:default", provider: "codex", label: "Codex", installedVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, releaseUrl: null, error: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue([row]);
  vi.mocked(notify).mockClear();
  await refreshSoftwareUpdates(true);
});
afterEach(cleanup);

it("waits for verified completion, survives navigation, prevents duplicate jobs, and refreshes versions", async () => {
  const update = deferred<string>();
  const updatedRow = { ...row, installedVersion: "1.1.0", updateAvailable: false };
  vi.mocked(invoke).mockImplementation(command => command === "update_software" ? update.promise : Promise.resolve([updatedRow]));
  const first = renderHook(useSoftwareUpdates);
  let job!: Promise<void>;
  act(() => { job = updateSoftware(row.id); });
  expect(first.result.current.updatingId).toBe(row.id);
  expect(notify).not.toHaveBeenCalled();
  first.unmount();
  const second = renderHook(useSoftwareUpdates);
  expect(second.result.current.updatingId).toBe(row.id);
  await act(async () => { await updateSoftware(row.id); });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "update_software")).toEqual([
    ["update_software", { id: row.id, targetVersion: "1.1.0" }],
  ]);
  await act(async () => { update.resolve("1.1.0"); await job; });
  expect(notify).toHaveBeenCalledWith("Codex updated to 1.1.0.");
  expect(second.result.current.updatingId).toBeNull();
  expect(second.result.current.rows[0]).toEqual(updatedRow);
});

it("shows failures without claiming success and allows a retry", async () => {
  vi.mocked(invoke).mockImplementation(command => command === "update_software" ? Promise.reject("Permission denied") : Promise.resolve([row]));
  const view = renderHook(useSoftwareUpdates);
  await act(async () => { await updateSoftware(row.id); });
  expect(view.result.current.updatingId).toBeNull();
  expect(view.result.current.updateError).toContain("Permission denied");
  expect(view.result.current.rows[0].updateAvailable).toBe(true);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith("Codex update failed: Permission denied", true, expect.any(Function));
  vi.mocked(invoke).mockImplementation(command => command === "update_software" ? Promise.resolve("1.1.0") : Promise.resolve([{ ...row, installedVersion: "1.1.0", updateAvailable: false }]));
  await act(async () => { await updateSoftware(row.id); });
  expect(view.result.current.updateError).toBe("");
  expect(notify).toHaveBeenLastCalledWith("Codex updated to 1.1.0.");
});

it("waits out an earlier check so stale results cannot overwrite the installed version", async () => {
  const check = deferred<SoftwareUpdate[]>();
  vi.mocked(invoke).mockImplementation(command => command === "software_updates" ? check.promise : Promise.resolve("1.1.0"));
  const view = renderHook(useSoftwareUpdates);
  let job!: Promise<void>;
  act(() => { void refreshSoftwareUpdates(true); job = updateSoftware(row.id); });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "update_software")).toHaveLength(0);
  await act(async () => {
    vi.mocked(invoke).mockImplementation(command => command === "software_updates" ? Promise.resolve([{ ...row, installedVersion: "1.1.0", updateAvailable: false }]) : Promise.resolve("1.1.0"));
    check.resolve([row]);
    await job;
  });
  expect(view.result.current.rows[0].installedVersion).toBe("1.1.0");
  expect(view.result.current.rows[0].updateAvailable).toBe(false);
});
