import { expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));
import { reportRenderError } from "./renderDiagnostics";

it("sends a bounded error record without application state", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error("x".repeat(3000));
  error.stack = "y".repeat(9000);
  reportRenderError(error, "component");
  expect(invoke).toHaveBeenCalledWith("report_frontend_error", { message: "x".repeat(2000), stack: "y".repeat(8000) });
  consoleError.mockRestore();
});
