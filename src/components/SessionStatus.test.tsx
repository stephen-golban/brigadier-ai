import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SessionStatus } from "./SessionStatus";
afterEach(cleanup);
it("shows attention ahead of work and removes status when idle", () => {
  const { rerender } = render(<SessionStatus attention working />);
  expect(screen.getByRole("img", { name: "Needs attention" })).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  rerender(<SessionStatus working />);
  expect(screen.getByRole("status", { name: "Working" })).toBeVisible();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  rerender(<SessionStatus />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
