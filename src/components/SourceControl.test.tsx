import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CommitPreferences,
  SourceControl,
  type SourceControlProps,
} from "./SourceControl";
import { defaultSettings, workbenchApi } from "../workbenchApi";
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(workbenchApi, "gitAction").mockResolvedValue("");
  vi.spyOn(workbenchApi, "gitDetails").mockResolvedValue({
    branches: ["main", "feature"],
    remotes: [],
    history: "",
    stashes: ["stash@{0}: saved work"],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const props = (): SourceControlProps => ({
  context: { projectId: "p", sessionId: "s" },
  status: {
    branch: "main",
    changes: [
      { path: "src/ready.ts", index: "M", worktree: " " },
      { path: "src/edit.ts", index: " ", worktree: "M" },
      { path: "notes.md", index: "?", worktree: "?" },
    ],
  },
  refresh: vi.fn(),
  onOpen: vi.fn(),
  data: { global: { ...defaultSettings }, projects: {}, notes: [] },
  onData: vi.fn(),
  models: [],
});

it("places the native composer above file groups and opens the appropriate staged diff", async () => {
  const p = props();
  render(<SourceControl {...p} />);
  const composer = screen.getByTestId("commit-composer");
  const staged = screen.getByRole("button", {
    name: "Staged Changes",
  });
  expect(
    composer.compareDocumentPosition(staged) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Open changes in src/ready.ts" }),
  );
  expect(p.onOpen).toHaveBeenCalledWith("src/ready.ts", "diff", true);
  await userEvent.click(
    screen.getByRole("button", { name: "Stage src/edit.ts" }),
  );
  expect(workbenchApi.gitAction).toHaveBeenCalledWith(p.context, {
    action: "stage",
    path: "src/edit.ts",
  });
  expect(screen.queryByText("Review Working Changes")).not.toBeInTheDocument();
});

it("requires confirmation to discard and does not mutate on cancel", async () => {
  render(<SourceControl {...props()} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Discard src/edit.ts" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Cancel" }),
  );
  expect(workbenchApi.gitAction).not.toHaveBeenCalled();
});

it("cancelling smart commit leaves the draft and preference untouched", async () => {
  const p = props();
  p.status!.changes = [{ path: "file.ts", index: " ", worktree: "M" }];
  render(<SourceControl {...p} />);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Commit message" }),
    "Update file",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Commit" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Cancel" }),
  );
  expect(workbenchApi.gitAction).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue(
    "Update file",
  );
  expect(p.data.global.smartCommit).toBe(false);
});

it("clears a committed draft before push failure and keeps a rejected commit draft", async () => {
  const p = props();
  render(<SourceControl {...p} />);
  const message = screen.getByRole("textbox", { name: "Commit message" });
  await userEvent.type(message, "Update file");
  vi.mocked(workbenchApi.gitAction).mockImplementation(
    async (_context, request) => {
      if (request.action === "push") {
        expect(localStorage.getItem("commit:p:s")).toBe("");
        throw new Error("Remote unavailable");
      }
      return "Committed";
    },
  );
  await userEvent.click(screen.getByRole("button", { name: "Commit options" }));
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Commit & Push" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Remote unavailable",
  );
  expect(message).toHaveValue("");
  expect(
    vi.mocked(workbenchApi.gitAction).mock.calls.map((call) => call[1].action),
  ).toEqual(["commit", "push"]);
  vi.mocked(workbenchApi.gitAction).mockRejectedValue(new Error("Hook failed"));
  await userEvent.type(message, "Second message");
  fireEvent.keyDown(message, { key: "Enter", metaKey: true });
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Hook failed"),
  );
  expect(message).toHaveValue("Second message");
});

it("isolates a pending generated message when switching sessions", async () => {
  let resolve!: (value: { message: string; model: string }) => void;
  vi.spyOn(workbenchApi, "generate").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const p = props(),
    view = render(<SourceControl {...p} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Generate commit message" }),
  );
  view.rerender(
    <SourceControl {...p} context={{ projectId: "p", sessionId: "other" }} />,
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Commit message" }),
    "Other draft",
  );
  await act(async () => resolve({ message: "Original generated message", model: "auto" }));
  expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue(
    "Other draft",
  );
  expect(localStorage.getItem("commit:p:s")).toBe("Original generated message");
  expect(localStorage.getItem("commit:p:other")).toBe("Other draft");
});

it("supports tree view and branch checkout without exposing excluded Git controls", async () => {
  const p = props();
  render(<SourceControl {...p} />);
  await userEvent.click(screen.getByRole("button", { name: "Git actions" }));
  expect(
    screen.queryByRole("menuitem", { name: "Clone" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Tags" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("menuitem", { name: "View as Tree" }));
  expect(screen.getAllByRole("button", { name: "Folder src" })).toHaveLength(2);
  await userEvent.click(
    screen.getByRole("button", { name: "Checkout branch" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Checkout branch" });
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "feature" }),
  );
  expect(workbenchApi.gitAction).toHaveBeenCalledWith(p.context, {
    action: "checkout",
    reference: "feature",
  });
});
it("retains project-specific smart commit settings behind the menu", async () => {
  const data = {
    notes: [],
    projects: { project: { ...defaultSettings, smartCommit: false } },
    global: defaultSettings,
  };
  const save = vi.spyOn(workbenchApi, "saveSettings").mockResolvedValue(data);
  render(
    <CommitPreferences
      data={data}
      projectId="project"
      models={[]}
      changed={() => {}}
    />,
  );
  await userEvent.setup().click(
    screen.getByRole("checkbox", {
      name: "Smart commit when nothing is staged",
    }),
  );
  expect(save).toHaveBeenCalledWith(
    "project",
    expect.objectContaining({ smartCommit: true }),
  );
});
