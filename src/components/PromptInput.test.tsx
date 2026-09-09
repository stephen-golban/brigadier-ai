import { pasteComposer } from "../test/composer";
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
describe("prompt input", () => {
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
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true"));
    await pasteComposer(screen.getByRole("textbox"), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep this draft");
    view.rerender(
      <NewSession {...props} project={{ ...project, id: "other" }} />,
    );
    expect(screen.getByRole("textbox")).toHaveTextContent("");
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true"));
    await pasteComposer(screen.getByRole("textbox"), "Other project");
    view.rerender(<NewSession {...props} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("Keep this draft"));
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("textbox")).toHaveTextContent("");
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
    await pasteComposer(input, "First line");
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(
      true,
    );
    expect(start).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await pasteComposer(input, "Second line");
    expect(input).toHaveTextContent("First lineSecond line");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(input).toHaveTextContent("");
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
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent(
      window,
      new CustomEvent("brigadier-attach", {
        detail: { path: "src/example.ts", content: "const n = 1;" },
      }),
    );
    await waitFor(() => expect(input.textContent!).toContain("const n = 1;"));
    const previous = input.textContent!;
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
    expect(input.textContent).toBe(previous);
    expect(
      screen.getByRole("button", { name: "Attach files" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Mention a file or note" })).toBeNull();
    expect(screen.queryByLabelText("Formatting")).toBeNull();
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
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true"));
    await pasteComposer(screen.getByRole("textbox"), "Pass this reference to the review task");
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {target:{files:[new File(["png"], "Reference.png", {type:"image/png"})]}});
  await screen.findByRole("button", {name:"Remove attachment Reference.png"});
  await waitFor(() => expect(screen.queryByLabelText("Pending attachments")).toBeNull());
  expect(imported).toHaveBeenCalledWith("p", "Reference.png", "cG5n");
  await user.click(screen.getByRole("button", {name:"Send"}));
  expect(start).toHaveBeenLastCalledWith(expect.objectContaining({attachmentIds:["attachment"]}));
  expect(screen.getByRole("button", {name:"Remove attachment Reference.png"})).toBeVisible();
  await user.click(screen.getByRole("button", {name:"Send"}));
  expect(screen.queryByRole("button", {name:"Remove attachment Reference.png"})).toBeNull();
});

it("sends a huge paste staged from an empty new-conversation draft", async () => {
  const {peerApi} = await import('../peerApi');
  const source = 'large exact request\r\n'.repeat(1000);
  const imported = vi.spyOn(peerApi,'importAttachment').mockResolvedValue({id:'huge',projectId:'p',name:'pasted.txt',mediaType:'text/plain',size:source.length,createdAt:0});
  const start = vi.fn().mockResolvedValue(true);
  render(<NewSession project={project} models={[]} disabled={false} onStart={start}/>);
  await waitFor(()=>expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable','true'));
  fireEvent.paste(screen.getByRole('textbox'),{clipboardData:{files:[],getData:(type:string)=>type==='text/plain'?source:''}});
  await screen.findByRole('button',{name:'Remove attachment pasted.txt'});
  await waitFor(() => expect(screen.queryByLabelText('Pending attachments')).toBeNull());
  expect(atob(imported.mock.calls[0]![2])).toBe(source);
  await userEvent.click(screen.getByRole('button',{name:'Send'}));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({prompt:'',attachmentIds:['huge']}));
});
