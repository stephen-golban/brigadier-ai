import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PromptInput } from "./PromptInput";
import { SelectMenu } from "./SelectMenu";
import { NewSession } from "./NewSession";
import { Markdown } from "./Markdown";
import type { ProjectView } from "../wire";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
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
    await user.click(screen.getByRole("button", { name: /Model$/ }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search model" }),
      "bet{Enter}",
    );
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Model$/ })).toHaveFocus(),
    );
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
          "[source](src/App.tsx)\n\n[note](brigadier-note:example-note)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert)"
        }
        onFile={open}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "source" }));
    expect(open).toHaveBeenCalledWith("src/App.tsx");
    await user.click(screen.getByRole("button", { name: "note" }));
    expect(open).toHaveBeenCalledWith("brigadier-note:example-note");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });
  it("submits once on Return, preserves Shift+Return, and leaves composing Return to the IME", async () => {
    const start = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(
      <NewSession
        project={project}
        models={[]}
        disabled={false}
        onStart={start}
      />,
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "First line");
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(
      true,
    );
    expect(start).not.toHaveBeenCalled();
    await user.keyboard("{Shift>}{Enter}{/Shift}Second line");
    expect(input).toHaveValue("First line\nSecond line");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(input).toHaveValue("");
  });

  it("forwards focus to the textarea and rejects attachments and mentions while disabled", async () => {
    function Harness({ disabled = false }: { disabled?: boolean }) {
      const [value, setValue] = useState("");
      return (
        <PromptInput
          value={value}
          onText={setValue}
          focusKey="session"
          disabled={disabled}
        />
      );
    }
    const view = render(<Harness />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveFocus();
    fireEvent(
      window,
      new CustomEvent("brigadier-attach", {
        detail: { path: "src/example.ts", content: "const n = 1;" },
      }),
    );
    expect((input as HTMLTextAreaElement).value).toContain("const n = 1;");
    const previous = (input as HTMLTextAreaElement).value;
    view.rerender(<Harness disabled />);
    fireEvent(
      window,
      new CustomEvent("brigadier-attach", {
        detail: { path: "blocked.ts", content: "blocked" },
      }),
    );
    fireEvent(
      window,
      new CustomEvent("brigadier-insert-note", {
        detail: { title: "Blocked note", id: "blocked" },
      }),
    );
    expect(input).toHaveValue(previous);
    expect(
      screen.getByRole("button", { name: "Attach text files" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Mention a note" }),
    ).toBeDisabled();
  });

  it("preserves reference links and uses the current file callback after rerendering", async () => {
    const first = vi.fn(),
      next = vi.fn();
    const user = userEvent.setup();
    const text =
      "[source][file]\n\nSome more text.\n\n[file]: ./src/example.ts";
    const view = render(<Markdown text={text} onFile={first} />);
    await user.click(await screen.findByRole("button", { name: "source" }));
    expect(first).toHaveBeenCalledWith("src/example.ts");
    view.rerender(<Markdown text={text} onFile={next} />);
    await user.click(screen.getByRole("button", { name: "source" }));
    expect(next).toHaveBeenCalledWith("src/example.ts");
    expect(first).toHaveBeenCalledOnce();
  });
  it("renders fenced code as a block and multiline inline code inside its paragraph", async () => {
    const { container } = render(
      <Markdown
        text={
          "Inline `one\ntwo` text.\n\n```unknown-language\nconst n = 1;\n```"
        }
      />,
    );
    await screen.findByText("one two");
    expect(container.querySelector("p > code")?.textContent).toBe("one two");
    expect(container.querySelector("pre code")?.textContent).toContain(
      "const n = 1;",
    );
    expect(container.querySelector("p div")).toBeNull();
  });
});

it("imports picked files for peer forwarding and retains IDs until the new session is accepted", async () => {
  const { peerApi } = await import("../peerApi");
  const metadata = {id:"attachment",projectId:"p",name:"Reference.png",mediaType:"image/png",size:3,createdAt:0};
  const imported = vi.spyOn(peerApi, "importAttachment").mockResolvedValue(metadata);
  const start = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const user = userEvent.setup();
  const view = render(<NewSession project={project} models={[]} disabled={false} onStart={start} />);
  await user.type(screen.getByRole("textbox"), "Pass this reference to the review task");
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {target:{files:[new File(["png"], "Reference.png", {type:"image/png"})]}});
  await screen.findByRole("button", {name:"Remove attachment Reference.png"});
  expect(imported).toHaveBeenCalledWith("p", "Reference.png", "cG5n");
  await user.click(screen.getByRole("button", {name:"Start"}));
  expect(start).toHaveBeenLastCalledWith(expect.objectContaining({attachmentIds:["attachment"]}));
  expect(screen.getByRole("button", {name:"Remove attachment Reference.png"})).toBeVisible();
  await user.click(screen.getByRole("button", {name:"Start"}));
  expect(screen.queryByRole("button", {name:"Remove attachment Reference.png"})).toBeNull();
});
