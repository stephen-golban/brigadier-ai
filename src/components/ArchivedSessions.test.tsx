import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchivedSessions } from "./ArchivedSessions";
import { Toasts } from "./Toasts";
import { archiveSession, readArchive } from "../sessionArchive";
import { peerApi } from "../peerApi";
import type { SessionRuntime } from "../feedStore";
import { ZERO_USAGE } from "../wire";

const session = (
  id: string,
  projectId = "p",
  worktree = false,
): SessionRuntime => ({
  sessionId: id,
  projectId,
  status: "exited",
  busy: false,
  model: null,
  cwd: "/repo",
  providerSessionId: null,
  worktreePath: worktree ? `/repo/.brigadier/worktrees/${id}` : null,
  branch: null,
  worktreeRemoved: false,
  resumed: false,
  lastTurnId: null,
  lastStop: null,
  costUsd: 0,
  usage: ZERO_USAGE,
  rowsTotal: 0,
  rowsDropped: 0,
  startedAtMs: 1,
  endedAtMs: null,
  exitCode: 0,
  lastMessage: null,
  lastEventSeq: 0,
});
const origins = { child: "alpha" };
const sessions = {
  alpha: session("alpha", "p", true),
  child: session("child"),
  beta: session("beta"),
  gamma: session("gamma", "q", true),
};
const props = {
  sessions,
  origins,
  titles: {
    alpha: "Fix one",
    child: "Internal worker",
    beta: "Fix two",
    gamma: "Other project",
  },
  projects: [
    { id: "p", name: "First", root_path: "/repo", created_at_ms: 1 },
    { id: "q", name: "Second", root_path: "/other", created_at_ms: 1 },
  ],
  projectNames: {},
};
beforeEach(async () => {
  localStorage.clear();
  vi.spyOn(peerApi, "snapshot").mockResolvedValue({
    origins,
    titles: {},
    closed: [],
    messages: [],
    requests: [],
  });
  for (const id of ["alpha", "beta", "gamma"]) await archiveSession(id, true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("filters by project and worktree and confirms deletion of only matching roots", async () => {
  const user = userEvent.setup();
  render(<ArchivedSessions {...props} />);
  expect(screen.queryByText("Internal worker")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Filter projects" }));
  await user.click(screen.getByRole("menuitem", { name: "First" }));
  await user.click(screen.getByRole("button", { name: "Filter chats" }));
  await user.click(screen.getByRole("menuitem", { name: "With a worktree" }));
  await user.type(
    screen.getByRole("textbox", { name: "Search archived chats" }),
    "Fix",
  );
  expect(screen.queryByText("Fix two")).not.toBeInTheDocument();
  expect(screen.queryByText("Other project")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete all" }));
  const dialog = screen.getByRole("dialog", {
    name: "Delete 1 archived chat?",
  });
  expect(readArchive().deleted).toEqual([]);
  expect(dialog).toHaveTextContent(
    "matching the current search and filters in First",
  );
  await user.click(within(dialog).getByRole("button", { name: "Delete all" }));
  await waitFor(() =>
    expect(readArchive().deleted).toEqual(
      expect.arrayContaining(["alpha", "child"]),
    ),
  );
  expect(Object.keys(readArchive().entries).sort()).toEqual(["beta", "gamma"]);
});

it("unarchives everything inside a chat and offers View without navigating", async () => {
  const user = userEvent.setup();
  const view = vi.fn();
  window.addEventListener("brigadier-view-chat", view);
  render(
    <>
      <ArchivedSessions {...props} />
      <Toasts />
    </>,
  );
  await user.click(screen.getByRole("button", { name: "Unarchive Fix one" }));
  expect(readArchive().entries.alpha).toBeUndefined();
  expect(readArchive().entries.child).toBeUndefined();
  expect(view).not.toHaveBeenCalled();
  await user.click(
    within(screen.getByRole("status")).getByRole("button", { name: "View" }),
  );
  expect(view).toHaveBeenCalledOnce();
  window.removeEventListener("brigadier-view-chat", view);
});

it("deletes a row immediately without a dialog and clears all session recovery buffers", async () => {
  const user = userEvent.setup();
  localStorage.setItem("composer-pending:alpha", "secret");
  localStorage.setItem(
    "brigadier:session-workspaces:v2",
    JSON.stringify({
      '["p","alpha"]': {
        tabs: [
          {
            id: "file",
            kind: "file",
            path: "a.ts",
            context: { projectId: "p", sessionId: "alpha" },
            root: "/repo",
          },
        ],
        active: "file",
      },
    }),
  );
  localStorage.setItem("brigadier:buffer:file", "unsaved draft");
  localStorage.setItem("brigadier:terminal:file", "output");
  localStorage.setItem("composer-pending:beta", "keep");
  render(<ArchivedSessions {...props} />);
  await user.click(screen.getByRole("button", { name: "Delete Fix one" }));
  await waitFor(() => expect(readArchive().deleted).toContain("alpha"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(localStorage.getItem("composer-pending:alpha")).toBeNull();
  expect(localStorage.getItem("brigadier:buffer:file")).toBeNull();
  expect(localStorage.getItem("brigadier:terminal:file")).toBeNull();
  expect(localStorage.getItem("composer-pending:beta")).toBe("keep");
});

it("rejects standalone subagent archive actions", async () => {
  await expect(archiveSession("child", false)).rejects.toThrow("parent chat");
});
