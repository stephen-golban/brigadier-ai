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
  const row = projectThread(items, running)[0] as Extract<
    ThreadRow,
    { type: "work" }
  >;
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
    const summary = screen.getByRole("button", {
      name: "Worked 1 failed",
    });
    await user.tab();
    expect(summary).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Ran npm test")).toBeVisible();
    await user.tab();
    await user.keyboard(" ");
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
    await user.click(screen.getByRole("button", { name: /Worked/ }));
    expect(
      screen.queryByText("Found the relevant behavior."),
    ).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /Worked/ }));
    expect(screen.queryByText("command 0")).not.toBeInTheDocument();
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

it("keeps the current action visible when live activity is collapsed", async () => {
  const user = userEvent.setup();
  const call = item(
    "live",
    { type: "tool-call", name: "Bash" },
    "npm run build",
  );
  const view = render(<Harness items={[call]} running />);
  const header = screen.getByRole("button", {
    name: /Working.*Ran npm run build/,
  });
  expect(header).toHaveAttribute("aria-expanded", "true");
  await user.click(header);
  expect(header).toHaveAttribute("aria-expanded", "false");
  expect(header).toHaveTextContent("Ran npm run build");
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
  expect(screen.getByRole("button", { name: "Worked" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
