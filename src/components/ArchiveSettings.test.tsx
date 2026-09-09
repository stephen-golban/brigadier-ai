import { pasteComposer } from "../test/composer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadView } from "./ThreadView";
import { NewSession } from "./NewSession";
import { ArchiveSettings } from "./ArchiveSettings";
import {
  readArchive,
  archiveSession,
  saveArchiveSettings,
} from "../sessionArchive";
import { workbenchApi } from "../workbenchApi";
import { workspaceApi } from "../workspaceApi";
const project = {
  id: "p",
  name: "Example",
  root_path: "/repo",
  created_at_ms: 1,
};
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
describe("archive settings", () => {
  it("fills an editable starter and sends the selected base only when Start is clicked", async () => {
    vi.spyOn(workbenchApi, "gitDetails").mockResolvedValue({
      branches: ["main", "feature", "origin/main"],
      localBranches: ["main", "feature"],
      remotes: [],
      history: "",
      stashes: [],
    });
    vi.spyOn(workspaceApi, "git").mockResolvedValue({
      branch: "main",
      changes: [],
    });
    const start = vi.fn();
    render(
      <>
        <ThreadView
          projectId="p"
          projectName="Example"
          sessionId={null}
          onFile={() => {}}
        />
        <NewSession
          project={project}
          models={[]}
          disabled={false}
          onStart={start}
        />
      </>,
    );
    expect(screen.getByText("What should we build in Example?")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Build a new feature, app, or tool" }),
    );
    expect(screen.getByRole("textbox")).toHaveTextContent(
      "Help me build a new feature:",
    );
    await waitFor(()=>expect(screen.getByRole("textbox")).toHaveFocus());
    expect(start).not.toHaveBeenCalled();
    await pasteComposer(screen.getByRole("textbox"), "a timer");
    await userEvent.click(screen.getByRole("button", { name: "Mode" }));
    await userEvent.click(screen.getByRole("option", { name: /Custom/ }));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      await screen.findByRole("button", { name: "Branch" }),
    );
    await userEvent.click(screen.getByRole("option", { name: /Checkout/ }));
    expect(screen.getByRole("option", { name: /origin\/main/ })).toBeVisible();
    await userEvent.click(screen.getByRole("option", { name: /feature/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Help me build a new feature: a timer",
        isolated: true,
        baseBranch: "feature",
      }),
    );
  });
  it("defaults to seven days and independently saves expiry and worktree preferences", async () => {
    render(<ArchiveSettings />);
    expect(screen.getByRole("spinbutton")).toHaveValue(7);
    await userEvent.clear(screen.getByRole("spinbutton"));
    await userEvent.type(screen.getByRole("spinbutton"), "30");
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "Delete isolated worktrees with expired sessions",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save retention settings" }),
    );
    await waitFor(() =>
      expect(readArchive().settings).toEqual({
        autoDelete: true,
        retentionDays: 30,
        deleteWorktrees: false,
      }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "Automatically delete archived sessions",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save retention settings" }),
    );
    await waitFor(() => expect(readArchive().settings.autoDelete).toBe(false));
  });
  it("reopening cancels expiry and closing again restarts the retention period", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    await archiveSession("s", true);
    expect(readArchive().entries.s.archivedAt).toBe(1000);
    await archiveSession("s", false);
    expect(readArchive().entries.s).toBeUndefined();
    clock.mockReturnValue(9000);
    await archiveSession("s", true);
    expect(readArchive().entries.s.archivedAt).toBe(9000);
    await saveArchiveSettings({
      autoDelete: false,
      retentionDays: 30,
      deleteWorktrees: false,
    });
    expect(readArchive().entries.s.archivedAt).toBe(9000);
  });
});
