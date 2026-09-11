import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkTrace } from "./WorkTrace";
import { projectThread, type ThreadRow } from "../threadProjection";
import type { ChatItem } from "../workspaceApi";

vi.mock("./Markdown", () => ({
  Markdown: ({ text }: { text: string }) => <p>{text}</p>,
  CopyButton: () => <button aria-label="Copy" />,
}));
afterEach(cleanup);
const item = (
  id: string,
  kind: ChatItem["kind"],
  body: string,
  parent_id: string | null = null,
): ChatItem => ({ id, kind, body, parent_id, session_id: "s", seq: 0, at: 0 });
function Harness({
  items,
  running = false,
}: {
  items: ChatItem[];
  running?: boolean;
}) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const row = projectThread(
    running
      ? items
      : [...items, item("answer", { type: "assistant-text" }, "Final answer")],
    running,
  )[0] as Extract<ThreadRow, { type: "work" }>;
  return (
    <WorkTrace
      row={row}
      expanded={expanded}
      onFile={() => {}}
      toggle={(id) =>
        setExpanded((old) => {
          const next = new Set(old);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })
      }
    />
  );
}
describe("work disclosure", () => {
  it("starts quiet, keeps failures discoverable, and opens paired details by keyboard", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        items={[
          item("cmd", { type: "tool-call", name: "Bash" }, "npm test"),
          item(
            "out",
            { type: "tool-result", tool_call_id: "cmd", is_error: true },
            "A test failed",
          ),
        ]}
      />,
    );
    expect(screen.queryByText("npm test")).not.toBeInTheDocument();
    // Owner review 2026-09-11, item 5: the turn summary says how long, never how many failed.
    // A failure stays discoverable one fold down, on the row it happened on.
    const summary = screen.getByRole("button", { name: /Worked/ });
    expect(summary).not.toHaveAccessibleName(/failure/);
    await user.tab();
    expect(summary).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(summary).toHaveAttribute("aria-expanded", "true");
    await user.click(
      screen.getByRole("button", { name: /Ran npm test.*Failed/ }),
    );
    expect(screen.getAllByText("npm test")).toHaveLength(1);
    expect(screen.getAllByText("A test failed")).toHaveLength(1);
    await user.click(summary);
    expect(screen.queryByText("npm test")).not.toBeInTheDocument();
    await user.click(summary);
    expect(screen.getAllByText("npm test")).toHaveLength(1);
  });
  it("nests an agent’s progress and leaves unrelated commands alongside the agent", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        items={[
          item(
            "agent",
            { type: "tool-call", name: "Agent" },
            '{"description":"Workspace research"}',
          ),
          item(
            "progress",
            { type: "assistant-text" },
            "Found the relevant behavior.",
            "agent",
          ),
          item("cmd", { type: "tool-call", name: "Bash" }, "git status"),
          item(
            "done",
            { type: "tool-result", tool_call_id: "agent", is_error: false },
            "Research complete",
          ),
        ]}
      />,
    );
    expect(
      screen.queryByText("Found the relevant behavior."),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Worked/ }));
    await user.click(
      screen.getByRole("button", { name: "Workspace research" }),
    );
    expect(
      screen.getByText("Found the relevant behavior."),
    ).toBeInTheDocument();
    const agent = screen
      .getByRole("button", { name: "Workspace research" })
      .closest('[data-trace-id="agent"]');
    const command = screen
      .getByRole("button", { name: "Ran git status" })
      .closest('[data-trace-id="cmd"]');
    expect(agent).not.toContainElement(command as HTMLElement);
    expect(command).toBeVisible();
  });
  it("batches repeated commands and mounts long traces incrementally", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 100 }, (_, n) =>
      item(`cmd-${n}`, { type: "tool-call", name: "Bash" }, `command ${n}`),
    );
    render(<Harness items={items} />);
    expect(screen.queryByText("command 0")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Worked/ }));
    await user.click(screen.getByRole("button", { name: "Ran commands" }));
    expect(
      screen.getAllByRole("button", { name: /^Ran command \d+/ }),
    ).toHaveLength(40);
    await user.click(screen.getByRole("button", { name: "Show more (60)" }));
    expect(
      screen.getAllByRole("button", { name: /^Ran command \d+/ }),
    ).toHaveLength(80);
  });
});

it("separates the working timer from the current tool label", async () => {
  const user = userEvent.setup();
  const call = item(
    "live",
    { type: "tool-call", name: "Bash" },
    "npm run build",
  );
  const view = render(<Harness items={[call]} running />);
  expect(screen.getByText("Working")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Working" })).toBeNull();
  const tool = screen.getByRole("button", { name: "Running npm run build" });
  expect(tool).toHaveAttribute("aria-expanded", "false");
  await user.click(tool);
  view.rerender(
    <Harness
      items={[
        call,
        item(
          "done",
          { type: "tool-result", tool_call_id: "live", is_error: false },
          "Built successfully",
        ),
      ]}
    />,
  );
  const parent = screen.getByRole("button", { name: "Worked" });
  expect(parent).toHaveAttribute("aria-expanded", "false");
  await user.click(parent);
  expect(screen.getByText("Built successfully")).toBeVisible();
});

it("keeps unknown tool completion distinct from success", () => {
  const { container } = render(
    <Harness
      items={[item("cmd", { type: "tool-call", name: "Bash" }, "npm test")]}
    />,
  );
  // `data-icon` is stamped on every vendored icon root by `scripts/vendor-icons.mjs`, so this
  // assertion survives an icon-library swap in a way the old `.lucide-check` class did not.
  expect(container.querySelector('[data-icon="check"]')).toBeNull();
});
it("shows provider reasoning without empty disclosures or orphan copy actions", async () => {
  const user = userEvent.setup();
  render(
    <Harness
      items={[
        item("empty", { type: "thinking" }, ""),
        item("real", { type: "thinking" }, "Provider reasoning"),
      ]}
    />,
  );
  expect(screen.getAllByRole("button")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: /Worked/ }));
  // Plan §3 row 4: the collapsed label names the elapsed figure. The fixture stamps every
  // item at the same instant, so there is no usable pair and the bare verb is correct here.
  await user.click(screen.getByRole("button", { name: "Thought" }));
  expect(screen.getByText("Provider reasoning")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
});

it("automatically folds an open live parent on completion and restores nested detail on demand", async () => {
  const user = userEvent.setup();
  const items = [
    item("progress", { type: "assistant-text" }, "Checking the build."),
    item("cmd", { type: "tool-call", name: "Bash" }, "npm run build"),
  ];
  const view = render(<Harness items={items} running />);
  expect(screen.getByText("Checking the build.")).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Running npm run build" }),
  );
  // Phase 4: the command row is the kit's `CommandExecution` (plan §3 row 7), whose expanded
  // body is a shell card — a `$ <command>` line and a `CommandOutput` pane — not the old
  // `Request`/`Result` label pair. The behaviour under test is unchanged: expanding the live
  // row reveals the command it is running.
  expect(screen.getByText("npm run build", { selector: "code" })).toBeVisible();
  view.rerender(
    <Harness
      items={[
        ...items,
        item(
          "result",
          { type: "tool-result", tool_call_id: "cmd", is_error: false },
          "Build passed",
        ),
      ]}
    />,
  );
  expect(screen.queryByText("Checking the build.")).toBeNull();
  expect(screen.queryByText("Build passed")).toBeNull();
  const parent = screen.getByRole("button", { name: /Worked/ });
  expect(parent).toHaveAttribute("aria-expanded", "false");
  await user.click(parent);
  expect(screen.getByText("Checking the build.")).toBeVisible();
  expect(screen.getByText("Build passed")).toBeVisible();
});

// The fixture carries a trailing tool call on purpose. Streaming (§4.2.3) makes a running turn's
// trailing prose its answer row, so 60 consecutive prose nodes with nothing after them are no
// longer activity at all — this row would be empty and the assertions below unreachable. One tool
// call at the end is what a real long live turn looks like, and it puts all 61 nodes in the
// activity list where the cap and the "show earlier" control are what is under test.
it("shows recent progress in a long live turn, with earlier work available on demand", async () => {
  const items = [
    ...Array.from({ length: 60 }, (_, i) =>
      item(`progress-${i}`, { type: "assistant-text" }, `Step ${i}`),
    ),
    item("cmd", { type: "tool-call", name: "Bash" }, "npm run build"),
  ];
  render(<Harness items={items} running />);
  expect(screen.getByText("Step 59")).toBeVisible();
  expect(screen.queryByText("Step 0")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Show earlier activity (21)" }),
  );
  expect(screen.getByText("Step 0")).toBeVisible();
});

it("keeps created peer tasks navigable when the work disclosure is folded", async () => {
  const select = vi.fn();
  const items = [
    item("create", {type:"tool-call",name:"mcp__brigadier__create_session"}, '{"title":"Review attachments"}'),
    item("result", {type:"tool-result",tool_call_id:"create",is_error:false}, '{"ok":true,"result":{"sessionId":"peer","title":"Review attachments"}}'),
    item("final", {type:"assistant-text"}, "Peer created"),
  ];
  const row = projectThread(items, false)[0] as Extract<ThreadRow,{type:"work"}>;
  render(<WorkTrace row={row} expanded={new Set()} toggle={() => {}} onFile={() => {}} onSelectSession={select} />);
  expect(screen.getByRole("button", {name:/Worked/})).toHaveAttribute("aria-expanded", "false");
  await userEvent.setup().click(screen.getByRole("button", {name:"Open chat: Review attachments"}));
  expect(select).toHaveBeenCalledWith("peer");
});

// The shimmer claims the model is thinking. Once its prose is promoted to a streaming answer row
// below this one (`row.streamingAnswer`), that claim sits directly above words the operator can
// watch arriving — and on a turn whose only content so far is that prose, this row is empty, which
// is exactly the case the shimmer was written for.
it("does not claim to be thinking while an answer is streaming below", () => {
  const streaming = projectThread(
    [
      item("u", { type: "user-text" }, "go"),
      item("p", { type: "assistant-text" }, "Here is the answer so far"),
    ].map((i, seq) => ({ ...i, seq })),
    true,
  );
  const row = streaming[1] as Extract<ThreadRow, { type: "work" }>;
  expect(row).toMatchObject({ type: "work", running: true, streamingAnswer: true });
  const view = render(
    <WorkTrace row={row} expanded={new Set()} toggle={() => {}} onFile={() => {}} />,
  );
  expect(screen.queryByRole("status")).toBeNull();

  // A live turn that ends in reasoning still shimmers: reasoning is never promoted, so nothing is
  // being drawn below this row and the model really is between visible actions.
  const reasoning = projectThread(
    [
      item("u", { type: "user-text" }, "go"),
      item("think", { type: "thinking" }, "Provider reasoning"),
    ].map((i, seq) => ({ ...i, seq })),
    true,
  )[1] as Extract<ThreadRow, { type: "work" }>;
  expect(reasoning.streamingAnswer).toBeUndefined();
  view.rerender(
    <WorkTrace row={reasoning} expanded={new Set()} toggle={() => {}} onFile={() => {}} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Thinking");
});
