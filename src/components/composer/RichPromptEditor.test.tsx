import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { RichPromptEditor, type EditorHandle } from "./RichPromptEditor";
import { pasteComposer } from "../../test/composer";
afterEach(cleanup);
it("preserves pasted code, whitespace, literal paths and ignores IME Enter", async () => {
  const change = vi.fn(), submit = vi.fn();
  function Harness() { const [text, set] = useState(""); return <RichPromptEditor value={text} onText={text => { set(text); change(text); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(text); } }} />; }
  render(<Harness />);
  const source = 'const path = "C:\\Users\\user_name\\x.ts";\n\n  `literal` **source**\n';
  await pasteComposer(screen.getByRole("textbox"), source);
  await waitFor(() => expect(change).toHaveBeenLastCalledWith(source));
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true })).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(submit).toHaveBeenCalledWith(source);
});
it("serializes rich marks and restores bold, links, lists and fenced code without flattening", async () => {
  const source = '**bold** and *italic* [source](src/a_b.ts)\n- first\n- second\n```ts\n  const literal = `text`;\n```';
  const changed = vi.fn();
  const view = render(<RichPromptEditor value={source} onText={changed} />);
  expect(view.container.querySelector("strong, .prompt-bold")).toHaveTextContent("bold");
  expect(view.container.querySelector("a")).toHaveTextContent("source");
  expect(view.container.querySelector("ul")).toHaveTextContent("firstsecond");
  expect(view.container.querySelector(".prompt-code-block")).toHaveTextContent("const literal");
  await pasteComposer(screen.getByRole("textbox"), "extra");
  expect(changed.mock.lastCall?.[0]).toContain("[source](src/a_b.ts)");
});
it("round-trips reference identity separately from its label and does not inherit history across external draft swaps", async () => {
  const source = "**Use** @[src/app.ts](brigadier-attachment:stable-file) and @[Spec](brigadier-note:note-id)";
  const changed = vi.fn();
  const view = render(<RichPromptEditor value={source} onText={changed} focusKey="test" />);
  expect(view.container.querySelector(".prompt-bold")).toHaveTextContent("Use");
  expect(view.container.querySelector('[data-directive-id="stable-file"]')).toHaveTextContent("src/app.ts");
  expect(view.container.querySelector('[data-directive-id="note-id"]')).toHaveTextContent("Spec");
  view.rerender(<RichPromptEditor value="another draft" onText={changed} focusKey="test" />);
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("another draft"));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", ctrlKey: true });
  expect(screen.getByRole("textbox")).not.toHaveTextContent("src/app.ts");
});
it("formats a selected range and undo restores its original literal source", async () => {
  const handle = createRef<EditorHandle>(); const changed = vi.fn();
  function Harness() { const [value, set] = useState("literal_path"); return <RichPromptEditor value={value} onText={text => { set(text); changed(text); }} editorRef={handle} />; }
  render(<Harness />);
  const element = screen.getByRole("textbox");
  await act(async () => {
    element.focus(); const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range); document.dispatchEvent(new Event("selectionchange"));
  });
  await act(async () => handle.current?.format("bold"));
  expect(changed).toHaveBeenLastCalledWith("**literal_path**");
  await act(async () => { fireEvent.keyDown(element, { key: "z", ctrlKey: true }); });
  expect(changed).toHaveBeenLastCalledWith("literal_path");
});
it("cancels stale mention results and inserts only after keyboard selection", async () => {
  const changed = vi.fn(); let first: (items: { id: string; label: string; kind: "file" }[]) => void = () => {};
  const search = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockResolvedValue([{ id: "current", label: "Current", kind: "file" }]);
  const select = vi.fn().mockResolvedValue("@[Current](brigadier-attachment:current) ");
  function Harness() { const [value, set] = useState(""); return <RichPromptEditor value={value} onText={text => { set(text); changed(text); }} search={search} select={select} />; }
  render(<Harness />);
  await pasteComposer(screen.getByRole("textbox"), "@a");
  await waitFor(() => expect(search).toHaveBeenCalled());
  await pasteComposer(screen.getByRole("textbox"), "b");
  await screen.findByRole("option", { name: "@Current" });
  await act(async () => first([{ id: "stale", label: "Stale", kind: "file" }]));
  expect(screen.queryByText("@Stale")).toBeNull();
  expect(select).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith("@[Current](brigadier-attachment:current) "));
});

it("stages a slash command on the first Enter and submits editable arguments on the next Enter", async () => {
  const submit = vi.fn();
  const search = vi.fn().mockResolvedValue([{ id: "review", label: "review", kind: "command" }]);
  const select = vi.fn().mockResolvedValue("/review ");
  function Harness() { const [value, set] = useState(""); return <RichPromptEditor value={value} onText={set} search={search} select={select} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); submit(value); } }} />; }
  render(<Harness />);
  await pasteComposer(screen.getByRole("textbox"), "/rev");
  await screen.findByRole("option", { name: "/review" });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("/review"));
  expect(submit).not.toHaveBeenCalled();
  await pasteComposer(screen.getByRole("textbox"), "main");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(submit).toHaveBeenCalledExactlyOnceWith("/review main");
});

it("restores stable agent session references as inline chips", () => {
  render(<RichPromptEditor value="Use @[Research](brigadier-session:session-uuid)" onText={vi.fn()} />);
  expect(document.querySelector('[data-directive-id="session-uuid"]')).toHaveTextContent("Research");
});

it("continues filtering a file mention when its query contains path separators", async () => {
  const search = vi.fn().mockResolvedValue([]);
  function Harness() { const [value,set] = useState(""); return <RichPromptEditor value={value} onText={set} search={search} />; }
  render(<Harness />);
  await pasteComposer(screen.getByRole("textbox"), "@src/components/");
  await waitFor(() => expect(search).toHaveBeenCalledWith("@", "src/components/"));
});

it("does not submit an unfinished slash query while command discovery is pending", async () => {
  const submit = vi.fn(), search = vi.fn().mockImplementation(() => new Promise(() => {}));
  function Harness() { const [value,set] = useState(""); return <RichPromptEditor value={value} onText={set} search={search} onKeyDown={submit} />; }
  render(<Harness />);
  await pasteComposer(screen.getByRole("textbox"), "/rev");
  fireEvent.keyDown(screen.getByRole("textbox"),{key:"Enter"});
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("textbox"),{key:"Escape"});
  fireEvent.keyDown(screen.getByRole("textbox"),{key:"Enter"});
  expect(submit).toHaveBeenCalledTimes(1);
});
