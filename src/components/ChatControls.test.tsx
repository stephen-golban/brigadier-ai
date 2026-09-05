import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectMenu } from "./SelectMenu";
import { WorkspacePanel } from "./WorkspacePanel";
import { workspaceApi } from "../workspaceApi";
import { NewSession } from "./NewSession";
import { Markdown } from "./Markdown";
import type { ProjectView } from "../wire";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
const project: ProjectView = {
  id: "p",
  name: "Example",
  root_path: "/example",
  created_at_ms: 0,
};
describe("chat controls", () => {
  it("searches model choices and selects by keyboard", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectMenu
        label="Model"
        value="a"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        onChange={onChange}
        searchable
      />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search model" }),
      "bet{Enter}",
    );
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model" })).toHaveFocus();
  });
  it("retains a failed prompt, isolates project drafts, and clears after acceptance", async () => {
    const user = userEvent.setup();
    const start = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const props = { project, models: [], disabled: false, onStart: start };
    const view = render(<NewSession {...props} />);
    await user.type(screen.getByRole("textbox"), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
    view.rerender(
      <NewSession {...props} project={{ ...project, id: "other" }} />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("");
    await user.type(screen.getByRole("textbox"), "Other project");
    view.rerender(<NewSession {...props} />);
    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
  it("routes file links and never renders executable message HTML", async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <Markdown
        text={
          "[source](src/App.tsx)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert)"
        }
        onFile={open}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "source" }));
    expect(open).toHaveBeenCalledWith("src/App.tsx");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});

it("windows a large file preview instead of mounting every line", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(480);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  if (!HTMLElement.prototype.scrollTo)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: () => {},
    });
  vi.spyOn(workspaceApi, "entries").mockResolvedValue([]);
  vi.spyOn(workspaceApi, "git").mockResolvedValue({
    branch: "main",
    changes: [],
  });
  vi.spyOn(workspaceApi, "file").mockResolvedValue({
    path: "large.txt",
    content: Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n"),
    truncated: false,
  });
  const { container } = render(
    <WorkspacePanel
      visible
      context={{ projectId: "p", sessionId: null }}
      rootPath="/example"
      tabs={[{ id: "large", kind: "file", path: "large.txt" }]}
      active="large"
      setTabs={() => {}}
      setActive={() => {}}
      onClose={() => {}}
      onAttach={() => {}}
    />,
  );
  expect(await screen.findByText("line 0")).toBeInTheDocument();
  expect(container.querySelectorAll(".line-number").length).toBeGreaterThan(5);
  expect(container.querySelectorAll(".line-number").length).toBeLessThan(60);
});
