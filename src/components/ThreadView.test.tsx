import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { ThreadView } from "./ThreadView";
import { workspaceApi, type ChatItem } from "../workspaceApi";

const { state } = vi.hoisted(() => ({
  state: {
    sessions: {
      s: { busy: true },
      cancelled: { busy: false, lastStop: "interrupted" },
      failed: { busy: false, lastStop: '{"error":"Provider disconnected"}' },
    },
  },
}));
vi.mock("../feedStore", () => ({
  getState: () => state,
  subscribe: () => () => {},
}));
vi.mock("../desktopApi", async (original) => ({
  ...(await original<typeof import("../desktopApi")>()),
  useSessionChanges: () => ({ turns: [], files: [] }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

// Use the real assistant-ui runtime: isRunning adds its own optimistic assistant message.
it.each([false, true])(
  "renders a running session while saved user message exists = %s",
  async (saved) => {
    const page: ChatItem[] = saved
      ? [
          {
            session_id: "s",
            id: "user",
            seq: 1,
            at: 0,
            kind: { type: "user-text" },
            body: "Test message",
            parent_id: null,
          },
        ]
      : [];
    vi.spyOn(workspaceApi, "chat").mockResolvedValue(page);
    render(
      <ThreadView
        sessionId="s"
        projectId="p"
        projectName="Example"
        onFile={() => {}}
      />,
    );
    expect(
      await screen.findByText(
        saved ? "Test message" : "Waiting for the first response…",
      ),
    ).toBeVisible();
    expect(screen.getByText("Working…")).toBeVisible();
  },
);

const saved = (
  id: string,
  kind: ChatItem["kind"],
  body: string,
  seq: number,
): ChatItem => ({
  session_id: "idle",
  id,
  seq,
  at: 0,
  kind,
  body,
  parent_id: null,
});
const transcript = [
  saved("user", { type: "user-text" }, "Inspect the changes", 1),
  saved("empty", { type: "thinking" }, "", 2),
  saved("before", { type: "assistant-text" }, "I’ll inspect the diff.", 3),
  saved("call", { type: "tool-call", name: "Bash" }, "git diff", 4),
  saved(
    "result",
    { type: "tool-result", tool_call_id: "call", is_error: true },
    "Command failed",
    5,
  ),
  saved(
    "after",
    { type: "assistant-text" },
    "The command failed. Open [README.md](README.md).",
    6,
  ),
];
it("folds intermediate prose, preserves final edit/file actions, and copies visible bodies", async () => {
  const user = userEvent.setup();
  const edit = vi.fn(),
    file = vi.fn();
  vi.spyOn(workspaceApi, "chat").mockImplementation(async (_id, after) =>
    transcript.filter((i) => i.seq > after),
  );
  const { container } = render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={file}
      onEdit={edit}
      requests={<button>Approve pending request</button>}
    />,
  );
  await screen.findByRole("button", { name: /Worked/ });
  expect(screen.queryByText("I’ll inspect the diff.")).toBeNull();
  expect(
    [...container.querySelectorAll("[data-message-id]")].map((el) =>
      el.getAttribute("data-message-id"),
    ),
  ).toEqual(["user", "work:user", "after"]);
  expect(screen.queryByText("Thinking")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: /Worked/ }));
  expect(screen.getByText("I’ll inspect the diff.")).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: /Ran git diff.*Failed/ }),
  );
  expect(screen.getByText("Command failed")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Edit message" }));
  expect(edit).toHaveBeenCalledWith(transcript[0]);
  await user.click(await screen.findByRole("button", { name: "README.md" }));
  expect(file).toHaveBeenCalledWith("README.md");
  expect(
    screen.getByRole("button", { name: "Approve pending request" }),
  ).toBeVisible();
});
it("restores expanded tools after switching sessions and reloading history", async () => {
  const user = userEvent.setup();
  vi.spyOn(workspaceApi, "chat").mockImplementation(async (id, after) =>
    id === "idle"
      ? transcript.filter((i) => i.seq > after)
      : [saved("other-user", { type: "user-text" }, "Other session", 1)],
  );
  const props = { projectId: "p", projectName: "Example", onFile: vi.fn() };
  const view = render(<ThreadView {...props} sessionId="idle" />);
  await user.click(await screen.findByRole("button", { name: /Worked/ }));
  await user.click(
    screen.getByRole("button", { name: /Ran git diff.*Failed/ }),
  );
  view.rerender(<ThreadView {...props} sessionId="other" />);
  await screen.findByText("Other session");
  expect(screen.queryByText("Command failed")).toBeNull();
  view.rerender(<ThreadView {...props} sessionId="idle" />);
  expect(await screen.findByText("Command failed")).toBeVisible();
  view.unmount();
  render(<ThreadView {...props} sessionId="idle" />);
  expect(await screen.findByText("Command failed")).toBeVisible();
});
it("keeps peer attribution short and navigable", async () => {
  const user = userEvent.setup(),
    select = vi.fn();
  const title =
    "A very long peer session title that contains an entire prompt and should not become a sentence above the bubble";
  vi.spyOn(workspaceApi, "chat").mockResolvedValue([transcript[0]!]);
  render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={() => {}}
      onSelectSession={select}
      peers={{
        origins: { idle: "peer" },
        titles: { peer: title },
        closed: [],
        messages: [],
        requests: [],
      }}
    />,
  );
  const attribution = await screen.findByRole("button", {
    name: /^From A very long/,
  });
  expect(attribution.textContent!.length).toBeLessThan(50);
  expect(attribution).toHaveAttribute("title", title);
  await user.click(attribution);
  expect(select).toHaveBeenCalledWith("peer");
});
it("discards late history from a session that was switched away", async () => {
  let resolve!: (items: ChatItem[]) => void;
  vi.spyOn(workspaceApi, "chat").mockImplementation((id) =>
    id === "old"
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve([
          saved("new-user", { type: "user-text" }, "New session", 1),
        ]),
  );
  const props = { projectId: "p", projectName: "Example", onFile: vi.fn() };
  const view = render(<ThreadView {...props} sessionId="old" />);
  view.rerender(<ThreadView {...props} sessionId="new" />);
  await screen.findByText("New session");
  resolve(transcript);
  await waitFor(() =>
    expect(screen.queryByText("Inspect the changes")).toBeNull(),
  );
});

it.each([
  ["cancelled", "interrupted"],
  ["failed", "Provider disconnected"],
])("retains partial output after %s", async (sessionId, label) => {
  vi.spyOn(workspaceApi, "chat").mockResolvedValue(transcript.slice(0, 4));
  render(
    <ThreadView
      sessionId={sessionId!}
      projectId="p"
      projectName="Example"
      onFile={() => {}}
    />,
  );
  expect(await screen.findByText("I’ll inspect the diff.")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /You stopped|Stopped/ }),
  ).toBeNull();
  expect(screen.getByText(label!)).toBeVisible();
  expect(screen.queryByText("Working…")).toBeNull();
});
it("hydrates all history pages before resting", async () => {
  const page = Array.from({ length: 23 }, (_, i) =>
    saved(`history-${i}`, { type: "user-text" }, `Saved turn ${i}`, i + 1),
  );
  const chat = vi
    .spyOn(workspaceApi, "chat")
    .mockImplementation(async (_id, after) =>
      page.filter((i) => i.seq > after).slice(0, 20),
    );
  render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={() => {}}
    />,
  );
  expect(await screen.findByText("Saved turn 22")).toBeVisible();
  expect(chat).toHaveBeenCalledWith("idle", 20);
  expect(screen.getByText("Saved turn 0")).toBeVisible();
});

it("renders a recorded duration after history reload without hiding the final answer", async () => {
  vi.spyOn(workspaceApi, "chat").mockResolvedValue(transcript);
  vi.spyOn(workspaceApi, "chatTurns").mockResolvedValue([
    {
      id: "turn",
      start_seq: 1,
      end_seq: 7,
      started_at: 1000,
      ended_at: 135000,
      status: "completed",
    },
  ]);
  render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={() => {}}
    />,
  );
  expect(
    await screen.findByRole("button", {
      name: /Worked for 2m 14s.*1 failure/,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText(/The command failed/)).toBeVisible();
  expect(screen.queryByText("I’ll inspect the diff.")).toBeNull();
});

it("folds a full turn while preserving commentary boundaries and independent tool disclosures", async () => {
  const user = userEvent.setup();
  const progress = [
    "Inspecting the conversation.",
    "Implementing work blocks.",
    "Checking the result.",
  ];
  const page = [
    saved("user", { type: "user-text" }, "Add compact work blocks", 1),
  ];
  for (const [index, body] of progress.entries()) {
    page.push(
      saved(
        `progress-${index}`,
        { type: "assistant-text" },
        body,
        page.length + 1,
      ),
    );
    for (let command = 0; command < 2; command++) {
      const id = `command-${index}-${command}`;
      page.push(
        saved(
          id,
          { type: "tool-call", name: "Bash" },
          `check ${index}-${command}`,
          page.length + 1,
        ),
      );
      page.push(
        saved(
          `${id}-result`,
          { type: "tool-result", tool_call_id: id, is_error: false },
          `Output ${index}-${command}`,
          page.length + 1,
        ),
      );
    }
  }
  page.push(
    saved(
      "answer",
      { type: "assistant-text" },
      "Implemented compact work blocks.",
      page.length + 1,
    ),
  );
  vi.spyOn(workspaceApi, "chat").mockResolvedValue(page);
  vi.spyOn(workspaceApi, "chatTurns").mockResolvedValue([
    {
      id: "turn",
      start_seq: 1,
      end_seq: page.length + 1,
      started_at: 1000,
      ended_at: 954000,
      status: "completed",
    },
  ]);
  render(
    <ThreadView
      sessionId="idle"
      projectId="p"
      projectName="Example"
      onFile={() => {}}
    />,
  );

  const parent = await screen.findByRole("button", {
    name: "Worked for 15m 53s",
  });
  expect(parent).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("Implemented compact work blocks.")).toBeVisible();
  for (const body of progress) expect(screen.queryByText(body)).toBeNull();
  expect(screen.queryByRole("button", { name: "Ran commands" })).toBeNull();

  await user.click(parent);
  for (const body of progress) expect(screen.getByText(body)).toBeVisible();
  const groups = screen.getAllByRole("button", { name: "Ran commands" });
  expect(groups).toHaveLength(3);
  await user.click(groups[1]!);
  await user.click(screen.getByRole("button", { name: "Ran check 1-0" }));
  expect(screen.getByText("Output 1-0")).toBeVisible();
  expect(screen.queryByText("Output 0-0")).toBeNull();
  expect(screen.queryByText("Output 2-0")).toBeNull();

  await user.click(parent);
  expect(screen.queryByText("Output 1-0")).toBeNull();
  expect(screen.getByText("Implemented compact work blocks.")).toBeVisible();
  await user.click(parent);
  expect(screen.getByText("Output 1-0")).toBeVisible();
});
