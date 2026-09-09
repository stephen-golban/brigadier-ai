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
    const summary = screen.getByRole("button", { name: /Worked.*1 failure/ });
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
  expect(container.querySelector(".lucide-check")).toBeNull();
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
  await user.click(screen.getByRole("button", { name: "Reasoning" }));
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
  expect(screen.getByText("Request")).toBeVisible();
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

it("shows recent progress in a long live turn, with earlier work available on demand", async () => {
  const items = Array.from({ length: 60 }, (_, i) =>
    item(`progress-${i}`, { type: "assistant-text" }, `Step ${i}`),
  );
  render(<Harness items={items} running />);
  expect(screen.getByText("Step 59")).toBeVisible();
  expect(screen.queryByText("Step 0")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Show earlier activity (20)" }),
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
