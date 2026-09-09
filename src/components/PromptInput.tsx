import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { desktop } from "../workspaceApi";
import { AttachmentPreview } from "./composer/AttachmentPreview";
import { useContext, useCallback, useEffect, useRef, useState, type TextareaHTMLAttributes, type ReactNode, type KeyboardEvent } from "react";
import { peerApi, type PeerAttachment } from "../peerApi";
import { NoteScope } from "../noteScope";
import { workbenchApi, type Note } from "../workbenchApi";
import { workspaceApi, errorMessage } from "../workspaceApi";
import type { ComposerCommand } from "../composerApi";
import { PlusIcon } from "@phosphor-icons/react";
import { ComposerBar, ComposerActions } from "./assistant-ui/elements/composer";
import { Button } from "./controls/button";
import { RichPromptEditor, type EditorHandle, type EditorSuggestion } from "./composer/RichPromptEditor";
import { referenceSource } from "./composer/editorSource";

export function useDraft(key: string): [string, (value: string) => void] {
  const read = (k: string) => {
    try {
      return localStorage.getItem(`draft:${k}`) ?? "";
    } catch {
      return "";
    }
  };
  const [entry, setEntry] = useState({ key, value: read(key) });
  const value = entry.key === key ? entry.value : read(key);
  const write = useCallback(
    (next: string) => {
      setEntry({ key, value: next });
      try {
        if (next) localStorage.setItem(`draft:${key}`, next);
        else localStorage.removeItem(`draft:${key}`);
      } catch {
        /* Keep an in-memory draft if storage is unavailable. */
      }
    },
    [key],
  );
  return [value, write];
}
export function useAttachmentDraft(key: string): [PeerAttachment[], (files: PeerAttachment[]) => void] {
  const [saved, setSaved] = useDraft(`attachments:${key}`);
  let files: PeerAttachment[] = [];
  try { const parsed: unknown = JSON.parse(saved || "[]"); if (Array.isArray(parsed)) files = parsed.filter(a => a && typeof a.id === "string" && typeof a.projectId === "string" && typeof a.name === "string"); } catch { /* Ignore an invalid saved draft. */ }
  const setFiles = useCallback((next: PeerAttachment[]) => setSaved(next.length ? JSON.stringify(next) : ""), [setSaved]);
  return [files, setFiles];
}

export const LARGE_PASTE_THRESHOLD = 16_000;

export type PromptInputProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onKeyDown" | "onPaste" | "onChange"> & {
  onText: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  attachmentProjectId?: string | null;
  sessionId?: string | null;
  attachments?: PeerAttachment[];
  onAttachments?: (files: PeerAttachment[]) => void;
  onUploadChange?: (uploading: boolean) => void;
  commands?: ComposerCommand[];
  focusKey?: string;
  header?: ReactNode;
  children?: ReactNode;
};
export function PromptInput(props: PromptInputProps) {
  const scope = useContext(NoteScope);
  const projectId = props.attachmentProjectId ?? scope;
  const { onText, children, header, onAttachments, attachments = [], onUploadChange } = props;
  const editor = useRef<EditorHandle>(null);
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [failedFiles, setFailedFiles] = useState<File[]>([]);
  const [pasteNotice, setPasteNotice] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(props); latest.current = props;
  const attachmentList = useRef(attachments); attachmentList.current = attachments;
  const scopeKey = `${projectId ?? "none"}:${props.sessionId ?? "new"}`;
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;

  const importFile = useCallback(async (item: File) => {
    if (!projectId || !onAttachments) throw new Error("Select a project before attaching a file.");
    if (item.size > 5 * 1024 * 1024) throw new Error(`${item.name} exceeds the 5 MiB attachment limit.`);
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error(`Could not read ${item.name}`));
      reader.readAsDataURL(item);
    });
    return peerApi.importAttachment(projectId, item.name, base64);
  }, [projectId, onAttachments]);
  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length || latest.current.disabled || uploadLock.current) return;
    if (attachmentList.current.length + files.length > 20) { setError("A message can include up to 20 attachments."); return; }
    const destination = scopeKey;
    uploadLock.current = true; setUploading(true); onUploadChange?.(true); setError(null);
    let remaining = files;
    try {
      setFailedFiles([]);
      for (const item of files) {
        const metadata = await importFile(item);
        if (currentScope.current !== destination) return;
        const next = [...attachmentList.current, metadata]; attachmentList.current = next;
        latest.current.onAttachments?.(next);
        remaining = remaining.slice(1);
      }
    } catch (failure) { if (currentScope.current === destination) { setError(errorMessage(failure)); setFailedFiles(remaining); } }
    finally { uploadLock.current = false; setUploading(false); onUploadChange?.(false); }
  }, [scopeKey, importFile, onUploadChange]);
  useEffect(() => {
    if (!desktop || !projectId || !onAttachments) return;
    let live = true; let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (!live || latest.current.disabled) return;
      const payload = event.payload;
      if (payload.type === "leave") { setDragging(false); return; }
      const rect = surface.current?.getBoundingClientRect();
      // Native coordinates are physical; restrict staging to this composer (worker and root can coexist).
      const scale = window.devicePixelRatio || 1;
      const over = rect && payload.position.x / scale >= rect.left && payload.position.x / scale <= rect.right && payload.position.y / scale >= rect.top && payload.position.y / scale <= rect.bottom;
      setDragging(!!over && payload.type !== "drop");
      if (payload.type !== "drop" || !over || uploadLock.current) return;
      const destination = scopeKey; uploadLock.current = true; setUploading(true); onUploadChange?.(true);
      void (async () => {
        try {
          if (attachmentList.current.length + payload.paths.length > 20) throw new Error("A message can include up to 20 attachments.");
          for (const path of payload.paths) {
            const metadata = await invoke<PeerAttachment>("import_conversation_attachment_path", { projectId, path });
            if (!live || currentScope.current !== destination) return;
            const next = [...attachmentList.current, metadata]; attachmentList.current = next; latest.current.onAttachments?.(next);
          }
        } catch (failure) { if (live) setError(errorMessage(failure)); }
        finally { uploadLock.current = false; if (live) { setUploading(false); onUploadChange?.(false); } }
      })();
    }).then(dispose => { if (live) unlisten = dispose; else dispose(); }).catch(failure => { if (live) setError(errorMessage(failure)); });
    return () => { live = false; unlisten?.(); };
  }, [scopeKey, projectId, !!onAttachments]);
  const importLatest = useRef(addFiles); importLatest.current = addFiles;
  useEffect(() => {
    const attach = (event: Event) => {
      if (latest.current.disabled) return;
      const detail = (event as CustomEvent<{ path: string; content: string; sessionId?: string }>).detail;
      if (detail.sessionId && detail.sessionId !== latest.current.sessionId) return;
      if (latest.current.onAttachments) void importLatest.current([new File([`File: ${detail.path} (reference content)\n\n${detail.content}`], detail.path.split("/").pop() || "context.txt", { type: "text/plain" })]);
      else editor.current?.insert(`\n\nFile: ${detail.path}\n${detail.content}\n`);
      editor.current?.focus();
    };
    const note = (event: Event) => {
      if (!latest.current.disabled) { const note = (event as CustomEvent<Note>).detail; editor.current?.insert(referenceSource(note.title, note.id, "note") + " "); }
    };
    window.addEventListener("brigadier-attach", attach); window.addEventListener("brigadier-insert-note", note);
    return () => { window.removeEventListener("brigadier-attach", attach); window.removeEventListener("brigadier-insert-note", note); };
  }, []);
  const search = useCallback(async (kind: "@" | "/", query: string): Promise<EditorSuggestion[]> => {
    if (kind === "/") return (latest.current.commands ?? []).filter(command => command.name.toLowerCase().includes(query.toLowerCase())).map(command => ({ id: command.name, label: command.name, description: command.argumentHint ? `${command.description} · ${command.argumentHint}` : command.description, kind: "command" }));
    const [files, data] = await Promise.all([
      projectId ? workspaceApi.findFiles({ projectId, sessionId: props.sessionId ?? null }, query) : Promise.resolve({ paths: [] }),
      workbenchApi.load(),
    ]);
    return [
      ...files.paths.slice(0, 9).map(path => ({ id: path, label: path, description: "Attach a snapshot from this workspace", kind: "file" as const })),
      ...data.notes.filter(note => (note.projectId === null || note.projectId === projectId) && note.title.toLowerCase().includes(query.toLowerCase())).slice(0, 3).map(note => ({ id: note.id, label: note.title, description: "Saved note", kind: "note" as const })),
    ];
  }, [projectId, props.sessionId]);
  const select = useCallback(async (item: EditorSuggestion): Promise<string> => {
    if (item.kind === "command") return `/${item.id} `;
    if (item.kind === "note") return referenceSource(item.label, item.id, "note") + " ";
    if (!projectId || !onAttachments) throw new Error("Select a project before mentioning a file.");
    if (uploadLock.current) throw new Error("Wait for the current attachment to finish.");
    if (attachmentList.current.length >= 20) throw new Error("A message can include up to 20 attachments.");
    const destination = scopeKey;
    uploadLock.current = true; setUploading(true); onUploadChange?.(true);
    try {
      const preview = await workspaceApi.file({ projectId, sessionId: props.sessionId ?? null }, item.id);
      if (preview.truncated) throw new Error(`${item.label} is too large for a file mention. Attach the file directly instead.`);
      const metadata = await importFile(new File([`File: ${item.id} (reference content)\n\n${preview.content}`], item.id.split("/").pop() || "context.txt", { type: "text/plain" }));
      if (currentScope.current !== destination) throw new Error("The destination changed while attaching the file.");
      const next = [...attachmentList.current, metadata]; attachmentList.current = next; latest.current.onAttachments?.(next);
      return referenceSource(item.label, metadata.id, "attachment") + " ";
    } finally { uploadLock.current = false; setUploading(false); onUploadChange?.(false); }
  }, [projectId, onAttachments, scopeKey, onUploadChange, props.sessionId, importFile]);

  return <div ref={surface} className="composer-surface"><ComposerBar className="relative bg-input brigadier-composer" data-slot="prompt-input" dragActive={dragging}
    onDragOver={event => { if (!props.disabled && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
    onDropCapture={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); if (!props.disabled) void addFiles(Array.from(event.dataTransfer.files)); }}
    onPasteCapture={event => {
      if (props.disabled) { event.preventDefault(); return; }
      const pastedFiles = Array.from(event.clipboardData.files);
      const text = event.clipboardData.getData("text/plain");
      if (pastedFiles.length || (onAttachments && text.length > LARGE_PASTE_THRESHOLD)) {
        setPasteNotice(!pastedFiles.length);
        event.preventDefault(); event.stopPropagation();
        void addFiles(pastedFiles.length ? pastedFiles : [new File([text], `pasted-text-${Date.now()}.txt`, { type: "text/plain" })]);
      }
    }}>
    {header}
    {attachments.length > 0 && <div className="composer-attachments" aria-label="Attached files">{attachments.map(attachment => <span key={attachment.id} className="composer-attachment" title={`${attachment.name} · ${attachment.mediaType} · ${attachment.size} bytes`}><span aria-hidden="true">{attachment.mediaType?.startsWith("image/") ? "▧" : "▤"}</span><AttachmentPreview attachment={attachment} /><Button type="button" disabled={props.disabled || uploading} aria-label={`Remove attachment ${attachment.name}`} onClick={() => onAttachments?.(attachments.filter(file => file.id !== attachment.id))}>×</Button></span>)}</div>}
    <RichPromptEditor key={scopeKey} editorRef={editor} value={String(props.value ?? "")} onText={onText} disabled={props.disabled} label={props["aria-label"]} placeholder={props.placeholder} focusKey={props.focusKey} onKeyDown={props.onKeyDown} search={search} select={select} onError={setError} />
    {pasteNotice && !uploading && !failedFiles.length && !error && <p role="status" className="composer-hint">Large paste staged as a text attachment; your message is unchanged.</p>}
    {uploading && <p role="status" className="composer-hint">Adding attachments…</p>}
    {dragging && <div className="composer-drop-overlay">Drop files or images to attach</div>}
    <ComposerActions className="relative flex-wrap justify-between px-1 pt-2" onClick={event => event.stopPropagation()}>
      <div className="composer-tools">
        <Button type="button" variant="ghost" size="icon" aria-label="Attach files" title="Attach files and images" disabled={props.disabled || uploading || !onAttachments} onClick={() => file.current?.click()}><PlusIcon size={18} /></Button>
        <Button type="button" variant="ghost" size="icon" aria-label="Mention a file or note" title="Mention a project file or note" disabled={props.disabled} onClick={() => editor.current?.insert("@")}><span>@</span></Button>
        <details className="composer-format-menu"><summary aria-label="Formatting" title="Formatting"><span>Aa</span></summary><div><Button type="button" aria-label="Bold" title="Bold" disabled={props.disabled} onMouseDown={event => event.preventDefault()} onClick={() => editor.current?.format("bold")}>Bold <kbd>⌘ B</kbd></Button><Button type="button" aria-label="Italic" title="Italic" disabled={props.disabled} onMouseDown={event => event.preventDefault()} onClick={() => editor.current?.format("italic")}>Italic <kbd>⌘ I</kbd></Button><Button type="button" aria-label="Code" title="Code" disabled={props.disabled} onMouseDown={event => event.preventDefault()} onClick={() => editor.current?.format("code")}>Code</Button><small>Markdown shortcuts format as you type.</small></div></details>
      </div>
      {children}
      <input ref={file} type="file" multiple disabled={props.disabled} hidden onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    </ComposerActions>
    {error && <p className="composer-error" role="alert">{error}</p>}
    {failedFiles.length > 0 && <div className="composer-hint"><span>Paste retained for retry. </span><Button type="button" disabled={uploading} onClick={() => void addFiles(failedFiles)}>Retry attachment</Button></div>}
  </ComposerBar></div>;
}
