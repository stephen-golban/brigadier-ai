import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SourceControl } from "./SourceControl";
import { workbenchApi, defaultSettings } from "../workbenchApi";
import type { GitStatus } from "../workspaceApi";

const context = { projectId: "project", sessionId: null };
const status: GitStatus = {
  branch: "feature/panel",
  changes: [
    { path: "src/staged.ts", index: "M", worktree: " " },
    { path: "src/edited.ts", index: " ", worktree: "M" },
    { path: "src/new.ts", index: "?", worktree: "?" },
  ],
};
const props = {
  context,
  status,
  refresh: vi.fn(),
  onOpen: vi.fn(),
  onData: vi.fn(),
  models: [],
  data: {
    notes: [],
    projects: {},
    global: { ...defaultSettings, coAuthor: false },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(workbenchApi, "gitAction").mockResolvedValue("");
  vi.spyOn(workbenchApi, "gitDetails").mockResolvedValue({
    branches: ["main"],
    remotes: ["origin"],
    stashes: [],
    history: "abc123 Improve Git panel",
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Source Control", () => {
  it("keeps group expansion on refresh and stages files without opening the diff", async () => {
    const user = userEvent.setup();
    const view = render(<SourceControl {...props} />);
    await user.click(screen.getByRole("button", { name: "Staged Changes" }));
    expect(screen.queryByTitle("src/staged.ts")).not.toBeInTheDocument();
    view.rerender(
      <SourceControl
        {...props}
        status={{ ...status, changes: [...status.changes] }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Staged Changes" }),
    ).toHaveAttribute("aria-expanded", "false");
    await user.click(
      screen.getByRole("button", { name: "Stage src/edited.ts" }),
    );
    expect(workbenchApi.gitAction).toHaveBeenCalledWith(context, {
      action: "stage",
      path: "src/edited.ts",
    });
    expect(props.onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByTitle("src/edited.ts"));
    expect(props.onOpen).toHaveBeenCalledWith("src/edited.ts", "diff", false);
    await user.click(screen.getByRole("button", { name: "Staged Changes" }));
    await user.click(
      screen.getByRole("button", { name: "Unstage src/staged.ts" }),
    );
    expect(workbenchApi.gitAction).toHaveBeenCalledWith(context, {
      action: "unstage",
      path: "src/staged.ts",
    });
  });

  it("accepts a file dropped onto a collapsed staging group and confirms discard", async () => {
    const user = userEvent.setup();
    render(<SourceControl {...props} />);
    const heading = screen.getByRole("button", {
      name: "Staged Changes",
    });
    await user.click(heading);
    fireEvent.drop(heading, {
      dataTransfer: {
        getData: () => JSON.stringify({ path: "src/edited.ts", staged: false }),
      },
    });
    await act(async () => {});
    expect(workbenchApi.gitAction).toHaveBeenCalledWith(context, {
      action: "stage",
      path: "src/edited.ts",
    });
    vi.mocked(workbenchApi.gitAction).mockClear();
    await user.click(
      screen.getByRole("button", { name: "Discard src/edited.ts" }),
    );
    expect(workbenchApi.gitAction).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(workbenchApi.gitAction).not.toHaveBeenCalled();
  });

  it("generates and commits with the keyboard, retaining the message on failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(workbenchApi, "generate").mockResolvedValue({
      message: "Refine Git panel",
      model: "auto",
    });
    vi.mocked(workbenchApi.gitAction).mockRejectedValueOnce(
      new Error("Commit failed"),
    );
    render(<SourceControl {...props} />);
    await user.click(
      screen.getByRole("button", { name: "Generate commit message" }),
    );
    const message = screen.getByRole("textbox", { name: "Commit message" });
    expect(message).toHaveValue("Refine Git panel");
    fireEvent.keyDown(message, { key: "Enter", metaKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("Commit failed");
    expect(message).toHaveValue("Refine Git panel");
    await user.click(screen.getByRole("button", { name: "Commit" }));
    expect(workbenchApi.gitAction).toHaveBeenLastCalledWith(context, {
      action: "commit",
      message: "Refine Git panel",
    });
    expect(message).toHaveValue("");
    expect(props.refresh).toHaveBeenCalled();
  });

  it("keeps repository actions and commit options in separate menus", async () => {
    const user = userEvent.setup();
    render(<SourceControl {...props} />);
    await user.click(screen.getByRole("button", { name: "Git actions" }));
    expect(screen.getByRole("menuitem", { name: "Fetch" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Commit All" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: "Source Control history" }),
    );
    const history = await screen.findByRole("dialog", {
      name: "Source Control history",
    });
    expect(
      await within(history).findByText("abc123 Improve Git panel"),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await user.type(
      screen.getByLabelText("Commit message"),
      "Commit all changes",
    );
    await user.click(screen.getByRole("button", { name: "Commit options" }));
    await user.click(screen.getByRole("menuitem", { name: "Commit All" }));
    expect(workbenchApi.gitAction).toHaveBeenCalledWith(context, {
      action: "commit_all",
      message: "Commit all changes",
    });
  });

  it("opens branch operations and settings without replacing the file list", async () => {
    const user = userEvent.setup();
    render(<SourceControl {...props} />);
    const row = screen.getByTitle("src/edited.ts");
    await user.click(screen.getByRole("button", { name: "feature/panel" }));
    await user.type(
      screen.getByRole("combobox", { name: "Branch / reference" }),
      "main",
    );
    await user.click(screen.getByRole("button", { name: "Checkout" }));
    expect(workbenchApi.gitAction).toHaveBeenCalledWith(context, {
      action: "checkout",
      reference: "main",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTitle("src/edited.ts")).toBe(row);
    await user.click(screen.getByRole("button", { name: "Commit settings" }));
    expect(
      screen.getByRole("dialog", { name: "Commit settings" }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Use global defaults" }),
    ).toBeChecked();
    await user.keyboard("{Escape}");
    expect(screen.getByTitle("src/edited.ts")).toBe(row);
  });
});
