import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

afterEach(() => vi.restoreAllMocks());

it("replaces a rendering failure with recovery controls instead of a blank root", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never { throw new Error("streamed message failed to render"); }
  render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
  expect(screen.getByRole("alert")).toHaveTextContent("Running work continues");
  expect(screen.getByRole("button", { name: "Reload interface" })).toBeEnabled();
});
