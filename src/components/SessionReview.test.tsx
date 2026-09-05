import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangedFilesCard } from "./SessionReview";
import { desktopApi } from "../desktopApi";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const files = [
  { path: "src/one.ts", added: 12, deleted: 3, binary: false },
  { path: "src/two.ts", added: 4, deleted: 1, binary: false },
];
describe("recorded file changes", () => {
  it("opens the exact turn's diff and review, using recorded counts", async () => {
    const user = userEvent.setup();
    const diff = vi.fn(),
      review = vi.fn();
    window.addEventListener("workbench-recorded-diff", diff);
    window.addEventListener("workbench-review", review);
    render(<ChangedFilesCard sessionId="session" turn="turn" files={files} />);
    expect(screen.getByText("Edited 2 files")).toBeVisible();
    expect(screen.getByText("+16")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /src\/one.ts/ }));
    expect(diff.mock.calls[0][0].detail).toEqual({
      sessionId: "session",
      turn: "turn",
      path: "src/one.ts",
    });
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(review.mock.calls[0][0].detail).toEqual({
      sessionId: "session",
      turn: "turn",
    });
    window.removeEventListener("workbench-recorded-diff", diff);
    window.removeEventListener("workbench-review", review);
  });
  it("never applies a conflicting undo preview", async () => {
    vi.spyOn(desktopApi, "previewUndo").mockResolvedValue({
      id: "ticket",
      session: "session",
      phase: "preview",
      error: null,
      plan: { conflicts: ["src/one.ts"], changes: [] },
    });
    const apply = vi.spyOn(desktopApi, "apply");
    render(<ChangedFilesCard sessionId="session" turn="turn" files={files} />);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Resolve these conflicts/)).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close" }),
    );
    expect(apply).not.toHaveBeenCalled();
  });
});
