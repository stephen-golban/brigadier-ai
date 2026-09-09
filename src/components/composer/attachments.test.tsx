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
  expect(imported).toHaveBeenCalledTimes(4);
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
  fireEvent.click(screen.getByRole("button", { name: "Retry attachment" }));
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
