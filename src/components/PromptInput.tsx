import { getCurrentWebview } from "@tauri-apps/api/webview";
import { desktop } from "../workspaceApi";
import { AttachmentPreview } from "./composer/AttachmentPreview";
import { useContext, useCallback, useEffect, useRef, useState, type TextareaHTMLAttributes, type ReactNode, type KeyboardEvent } from "react";
import { peerApi, type PeerAttachment } from "../peerApi";
import { NoteScope } from "../noteScope";
import { workbenchApi, type Note } from "../workbenchApi";
import { workspaceApi, errorMessage } from "../workspaceApi";
import type { ComposerCommand } from "../composerApi";
import { Plus, X } from "../icons";
import { ComposerBar, ComposerActions } from "./assistant-ui/elements/composer";
import { Button } from "./controls/button";
import { RichPromptEditor, type EditorHandle, type EditorSuggestion } from "./composer/RichPromptEditor";
import { referenceSource } from "./composer/editorSource";
import { useAttachmentImports } from "./composer/useAttachmentImports";
import { bridge } from "../bridge";
import { useSessionNavigation } from "../sessionNavigation";
import "./composer/attachments.css";

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
  const imports = useAttachmentImports({ scope: scopeKey, projectId, attachments, onAttachments, disabled: props.disabled, onError: setError });
  const addFiles = imports.addFiles;
  const addPaths = useRef(imports.addPaths); addPaths.current = imports.addPaths;
  useEffect(() => { onUploadChange?.(uploading || imports.blocked); }, [uploading, imports.blocked, onUploadChange]);
  useEffect(() => {
    if (!desktop || !projectId || !onAttachments) return;
    let live = true; let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (!live || latest.current.disabled) return;
      const payload = event.payload;
      if (payload.type === "leave") { setDragging(false); return; }
      const rect = surface.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const over = rect && payload.position.x / scale >= rect.left && payload.position.x / scale <= rect.right && payload.position.y / scale >= rect.top && payload.position.y / scale <= rect.bottom;
      setDragging(!!over && payload.type !== "drop");
      if (payload.type === "drop" && over) addPaths.current(payload.paths);
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
  const { titles } = useSessionNavigation();
  const search = useCallback(async (kind: "@" | "/", query: string): Promise<EditorSuggestion[]> => {
    if (kind === "/") return (latest.current.commands ?? []).filter(command => command.name.toLowerCase().includes(query.toLowerCase())).map(command => ({ id: command.name, label: command.name, description: command.argumentHint ? `${command.description} · ${command.argumentHint}` : command.description, kind: "command" }));
    const [files, data, sessions, peers] = await Promise.all([
      projectId ? workspaceApi.findFiles({ projectId, sessionId: props.sessionId ?? null }, query) : Promise.resolve({ paths: [] }),
      workbenchApi.load(),
      bridge().listSessions(),
      peerApi.snapshot(),
    ]);
    return [
      ...files.paths.slice(0, 8).map(path => ({ id: path, label: path, description: "Attach a snapshot from this workspace", kind: "file" as const })),
      ...data.notes.filter(note => (note.projectId === null || note.projectId === projectId) && note.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId)).slice(0, 6).map(note => ({ id: note.id, label: note.title, description: note.projectId ? "Project note" : "Global note", kind: "note" as const })),
      ...sessions.filter(session => session.session_id !== props.sessionId && (session.project_id === projectId || session.project_id === null)).map(session => ({ id: session.session_id, label: titles[session.session_id] ?? peers.titles[session.session_id] ?? `Session ${session.session_id.slice(-6)}`, description: `${session.project_id ? "Current project" : "Global session"} · ${session.status}`, kind: "session" as const, projectId: session.project_id })).filter(session => `${session.label} ${session.id}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId)).slice(0, 6),
    ];
  }, [projectId, props.sessionId, titles]);
  const select = useCallback(async (item: EditorSuggestion): Promise<string> => {
    if (item.kind === "command") return `/${item.id} `;
    if (item.kind === "session") return referenceSource(item.label, item.id, "session") + " ";
    if (item.kind === "note") return referenceSource(item.label, item.id, "note") + " ";
    if (!projectId || !onAttachments) throw new Error("Select a project before mentioning a file.");
    if (uploadLock.current) throw new Error("Wait for the current attachment to finish.");
    if (attachmentList.current.length >= 20) throw new Error("A message can include up to 20 attachments.");
    const destination = scopeKey;
    uploadLock.current = true; setUploading(true);
    try {
      const preview = await workspaceApi.file({ projectId, sessionId: props.sessionId ?? null }, item.id);
      if (preview.truncated) throw new Error(`${item.label} is too large for a file mention. Attach the file directly instead.`);
      const metadata = await importFile(new File([`File: ${item.id} (reference content)\n\n${preview.content}`], item.id.split("/").pop() || "context.txt", { type: "text/plain" }));
      if (currentScope.current !== destination) throw new Error("The destination changed while attaching the file.");
      const next = [...attachmentList.current, metadata]; attachmentList.current = next; latest.current.onAttachments?.(next);
      return referenceSource(item.label, metadata.id, "attachment") + " ";
    } finally { uploadLock.current = false; setUploading(false); }
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
        const retained = addFiles(pastedFiles.length ? pastedFiles : [new File([text], `pasted-text-${Date.now()}.txt`, { type: "text/plain" })]);
        if (retained) { setPasteNotice(!pastedFiles.length); event.preventDefault(); event.stopPropagation(); }
        // If capacity prevents staging, let the literal-text handler preserve a large paste inline.
      }
    }}>
    {header}
    {attachments.length > 0 && <div className="composer-attachments" aria-label="Attached files">{attachments.map(attachment => <span key={attachment.id} className="composer-attachment" title={`${attachment.name} · ${attachment.mediaType} · ${attachment.size} bytes`}><AttachmentPreview attachment={attachment} thumbnail /><Button type="button" disabled={props.disabled} aria-label={`Remove attachment ${attachment.name}`} onClick={() => onAttachments?.(attachments.filter(file => file.id !== attachment.id))}><X className="size-3.5" /></Button></span>)}</div>}
    {imports.recoveryError && <div role="alert" className="composer-error">Pending attachments could not be restored: {imports.recoveryError} <Button type="button" onClick={imports.retryRecovery}>Retry attachment recovery</Button></div>}
    {imports.pending.length > 0 && <div className="composer-attachments" aria-label="Pending attachments">{imports.pending.map(item => <div key={item.id} className="composer-attachment composer-attachment-pending" data-status={item.status}>
      <span className="attachment-import-name" title={item.name}>{item.name}</span>
      {item.status === "failed" ? <><span role="alert" className="attachment-import-error">{item.error}</span><Button type="button" disabled={props.disabled} aria-label={`Retry attachment ${item.name}`} onClick={() => imports.retry(item.id)}>Retry</Button></> : <progress aria-label={`Importing ${item.name}`} value={item.progress} max={100} />}
      <Button type="button" disabled={props.disabled} aria-label={`Remove attachment ${item.name}`} onClick={() => imports.remove(item.id)}><X className="size-3.5" /></Button>
    </div>)}</div>}
    <RichPromptEditor key={scopeKey} editorRef={editor} value={String(props.value ?? "")} onText={onText} disabled={props.disabled} label={props["aria-label"]} placeholder={props.placeholder} focusKey={props.focusKey} onKeyDown={props.onKeyDown} search={search} select={select} onError={setError} />
    {pasteNotice && !uploading && !imports.pending.length && !error && <p role="status" className="composer-hint">Large paste staged as a text attachment; your message is unchanged.</p>}
    {uploading && <p role="status" className="composer-hint">Adding attachments…</p>}
    {dragging && <div className="composer-drop-overlay">Drop files or images to attach</div>}
    <ComposerActions className="relative flex-wrap justify-between px-1 pt-2" onClick={event => event.stopPropagation()}>
      <div className="composer-tools">
        <Button type="button" variant="ghost" size="icon" aria-label="Attach files" title="Attach files and images" disabled={props.disabled || !onAttachments} onClick={() => file.current?.click()}><Plus width={18} height={18} /></Button>

      </div>
      {children}
      <input ref={file} type="file" multiple disabled={props.disabled} hidden onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    </ComposerActions>
    {error && <p className="composer-error" role="alert">{error}</p>}
  </ComposerBar></div>;
}
