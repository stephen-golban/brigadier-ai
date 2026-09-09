import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { PromptInput, LARGE_PASTE_THRESHOLD } from "../PromptInput";
import { peerApi, type PeerAttachment } from "../../peerApi";
import { workspaceApi } from "../../workspaceApi";
import { workbenchApi } from "../../workbenchApi";
import { pasteComposer } from "../../test/composer";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Harness() { const [text, setText] = useState("Keep my draft"), [attachments, setAttachments] = useState<PeerAttachment[]>([]); return <PromptInput value={text} onText={setText} attachmentProjectId="project" sessionId="session" attachments={attachments} onAttachments={setAttachments} />; }
function importer() {
  let index = 0;
  return vi.spyOn(peerApi, "importAttachment").mockImplementation(async (projectId, name, base64) => ({ id: `file-${++index}`, projectId, name, mediaType: name.endsWith(".png") ? "image/png" : "text/plain", size: atob(base64).length, createdAt: 0 }));
}
it("uses one durable pipeline for clipboard, dropped and picked mixed files", async () => {
  const imported = importer(); const view = render(<Harness />);
  const image = new File(["image"], "paste.png", { type: "image/png" });
  fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [image], getData: () => "" } });
  await screen.findByRole("button", { name: "Remove attachment paste.png" });
  fireEvent.drop(view.container.querySelector('[data-slot="prompt-input"]')!, { dataTransfer: { types: ["Files"], files: [new File(["text"], "drop.txt"), new File(["image"], "drop.png")] } });
  await screen.findByRole("button", { name: "Remove attachment drop.png" });
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["source"], "source.ts")] } });
  await screen.findByRole("button", { name: "Remove attachment source.ts" });
  await waitFor(() => expect(screen.queryByLabelText("Pending attachments")).toBeNull());
  await waitFor(() => expect(imported).toHaveBeenCalledTimes(4));
  expect(imported.mock.calls.map(call => atob(call[2]))).toEqual(["image", "text", "image", "source"]);
  expect(screen.getByRole("textbox")).toHaveTextContent("Keep my draft");
});
it("stages oversized Unicode/CRLF/code paste exactly, retains it after import failure and previews retry", async () => {
  const source = "😀\r\n```ts\r\n  const x = 1;\r\n```\r\n".repeat(600);
  expect(source.length).toBeGreaterThan(LARGE_PASTE_THRESHOLD);
  const imported = importer(); imported.mockRejectedValueOnce(new Error("Disk unavailable"));
  vi.spyOn(peerApi, "attachment").mockResolvedValue({ metadata: { id: "file-1", projectId: "project", name: "pasted.txt", mediaType: "text/plain", size: source.length, createdAt: 0 }, base64: btoa(String.fromCharCode(...new TextEncoder().encode(source))) });
  render(<Harness />);
  fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [], getData: (type: string) => type === "text/plain" ? source : "<p>Huge html</p>" } });
  await screen.findByText("Disk unavailable");
  expect(screen.getByRole("textbox")).toHaveTextContent("Keep my draft");
  fireEvent.click(screen.getByRole("button", { name: /^Retry attachment/ }));
  await waitFor(() => expect(imported).toHaveBeenCalledTimes(2));
  const bytes = Uint8Array.from(atob(imported.mock.calls[1]![2]), char => char.charCodeAt(0));
  expect(new TextDecoder().decode(bytes)).toBe(source);
  const preview = await screen.findByTitle("Preview attachment");
  fireEvent.click(preview);
  await waitFor(() => expect(screen.getByText(source, { exact: false, selector: "pre", normalizer: value => value })).toBeInTheDocument());
});
it("keeps a paste exactly at the threshold inline", async () => {
  const imported = importer(); render(<Harness />);
  const source = "a".repeat(LARGE_PASTE_THRESHOLD);
  await pasteComposer(screen.getByRole("textbox"), source);
  expect(imported).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox").textContent).toContain(source);
});
it("resolves real file and note mentions with distinct identities, retaining file bytes", async () => {
  const imported = importer();
  vi.spyOn(workspaceApi, "findFiles").mockResolvedValue({ paths: ["src/same.ts"], truncated: false });
  vi.spyOn(workspaceApi, "file").mockResolvedValue({ path: "src/same.ts", content: "export const source = 1;", truncated: false });
  vi.spyOn(workbenchApi, "load").mockResolvedValue({ notes: [{ id: "note-1", title: "same.ts", body: "Note content", projectId: "project" }] } as never);
  render(<Harness />);
  await pasteComposer(screen.getByRole("textbox"), " @same");
  fireEvent.click(await screen.findByRole("option", { name: /@src\/same.ts/ }));
  await screen.findByRole("button", { name: "Remove attachment same.ts" });
  expect(atob(imported.mock.calls[0]![2])).toBe("File: src/same.ts (reference content)\n\nexport const source = 1;");
  expect(document.querySelector('[data-directive-id="file-1"]')).not.toBeNull();
  await pasteComposer(screen.getByRole("textbox"), " @same");
  fireEvent.click(await screen.findByRole("option", { name: /@same.ts/ }));
  await waitFor(() => expect(document.querySelector('[data-directive-id="note-1"]')).not.toBeNull());
  expect(imported).toHaveBeenCalledTimes(1);
});

vi.mock("./attachmentImports", () => ({ attachmentImports: { load: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) } }));

it("blocks sending until each retained failure is retried or removed", async () => {
  const imported = importer(); imported.mockRejectedValueOnce(new Error("Disk unavailable"));
  function SendingHarness() {
    const [files, setFiles] = useState<PeerAttachment[]>([]), [blocked, setBlocked] = useState(false);
    return <PromptInput value="Ready message" onText={vi.fn()} attachmentProjectId="project" attachments={files} onAttachments={setFiles} onUploadChange={setBlocked}><button disabled={blocked}>Send test</button></PromptInput>;
  }
  const view = render(<SendingHarness />);
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["bytes"], "failed.txt")] } });
  await screen.findByText("Disk unavailable");
  expect(screen.getByRole("button", {name:"Send test"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button", {name:"Remove attachment failed.txt"}));
  await waitFor(() => expect(screen.getByRole("button", {name:"Send test"})).toBeEnabled());
});

it("restores a retained file after remount and retries its exact bytes", async () => {
  const { attachmentImports } = await import("./attachmentImports");
  const retained = {id:"pending-persisted",scope:"project:session",name:"recover.txt",size:9,file:new Blob(["exact\r\n😀"])};
  vi.mocked(attachmentImports.load).mockResolvedValueOnce([retained]);
  const imported = importer();
  render(<Harness />);
  await screen.findByRole("button", {name:"Retry attachment recover.txt"});
  expect(imported).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name:"Retry attachment recover.txt"}));
  await waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
  const bytes = Uint8Array.from(atob(imported.mock.calls[0]![2]), char => char.charCodeAt(0));
  expect(new TextDecoder().decode(bytes)).toBe("exact\r\n😀");
  await waitFor(() => expect(attachmentImports.remove).toHaveBeenCalledWith("pending-persisted"));
});

it("groups real agent sessions with project and global notes without changing identity", async () => {
  const { bridge } = await import("../../bridge");
  const { renameSession } = await import("../../sessionNavigation");
  renameSession("real-session", "Related task");
  vi.spyOn(bridge(), "listSessions").mockResolvedValue([{session_id:"real-session",project_id:"project",status:"ended"}, {session_id:"outside",project_id:"other",status:"ended"}] as never);
  vi.spyOn(workspaceApi,"findFiles").mockResolvedValue({paths:[],truncated:false});
  vi.spyOn(workbenchApi,"load").mockResolvedValue({notes:[{id:"global",title:"Global note",projectId:null},{id:"local",title:"Project note",projectId:"project"}]} as never);
  render(<Harness />);
  await pasteComposer(screen.getByRole("textbox"), " @");
  await screen.findByRole("option", {name:/@Related task/});
  expect(screen.getByText("Agent sessions")).toBeVisible();
  expect(screen.getByText("Notes")).toBeVisible();
  const notes = screen.getAllByRole("option");
  expect(notes[0]).toHaveTextContent("Project note");
  expect(notes[1]).toHaveTextContent("Global note");
  expect(screen.queryByRole("option",{name:/outside/})).toBeNull();
  fireEvent.click(screen.getByRole("option", {name:/@Related task/}));
  await waitFor(() => expect(document.querySelector('[data-directive-id="real-session"]')).toHaveTextContent("Related task"));
});

it("keeps an oversized paste inline if the attachment count prevents staging", async () => {
  const imported = importer();
  const files = Array.from({length:20},(_,i) => ({id:`retained-${i}`,projectId:"project",name:`file-${i}.txt`,mediaType:"text/plain",size:1,createdAt:0}));
  function FullHarness() { const [text,set] = useState(""); return <PromptInput value={text} onText={set} attachmentProjectId="project" attachments={files} onAttachments={vi.fn()} />; }
  render(<FullHarness />);
  const source = "preserved text ".repeat(2000);
  await pasteComposer(screen.getByRole("textbox"), source);
  expect(imported).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox").textContent).toBe(source);
  expect(screen.getByRole("alert")).toHaveTextContent("20 attachments");
});

it("does not append a removed in-flight file when the import finishes", async () => {
  let complete!: (metadata: PeerAttachment) => void;
  const imported = vi.spyOn(peerApi,"importAttachment").mockImplementation(() => new Promise(resolve => {complete=resolve;}));
  const view = render(<Harness />);
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["bytes"], "removed.txt")] } });
  await waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button",{name:"Remove attachment removed.txt"}));
  complete({id:"late",projectId:"project",name:"removed.txt",mediaType:"text/plain",size:5,createdAt:0});
  await waitFor(() => expect(screen.queryByRole("button",{name:"Remove attachment removed.txt"})).toBeNull());
  expect(screen.queryByTitle("Preview attachment")).toBeNull();
});

it("keeps dispatch blocked when pending attachment recovery fails until recovery succeeds", async () => {
  const {attachmentImports} = await import('./attachmentImports');
  vi.mocked(attachmentImports.load).mockRejectedValueOnce(new Error('Draft storage unavailable'));
  function SendingHarness() {
    const [files,setFiles] = useState<PeerAttachment[]>([]), [blocked,setBlocked] = useState(false);
    return <PromptInput value="Draft" onText={vi.fn()} attachmentProjectId="project" attachments={files} onAttachments={setFiles} onUploadChange={setBlocked}><button disabled={blocked}>Send test</button></PromptInput>;
  }
  render(<SendingHarness />);
  await screen.findByText(/Pending attachments could not be restored/);
  expect(screen.getByRole('button',{name:'Send test'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Retry attachment recovery'}));
  await waitFor(() => expect(screen.getByRole('button',{name:'Send test'})).toBeEnabled());
});
