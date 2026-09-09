import { Popover, Label, Description } from "./controls/overlay";
import { ListBox } from "./controls/listbox";
import {
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type TextareaHTMLAttributes,
  type ReactNode,
} from "react";
import { peerApi, type PeerAttachment } from "../peerApi";
import { NoteScope } from "../noteScope";
import { workbenchApi, type Note } from "../workbenchApi";
import { PlusIcon } from "@phosphor-icons/react";

import {
  ComposerBar,
  ComposerInput,
  ComposerActions,
} from "./assistant-ui/elements/composer";
import { MessageAction } from "./assistant-ui/elements/tooltip-icon-button";
import { Button } from "./controls/button";

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

export function PromptInput(
  props: TextareaHTMLAttributes<HTMLTextAreaElement> & {
    onText: (value: string) => void;
    attachmentProjectId?: string | null;
    attachments?: PeerAttachment[];
    onAttachments?: (files: PeerAttachment[]) => void;
    onUploadChange?: (uploading: boolean) => void;
    focusKey?: string;
    header?: ReactNode;
    children?: ReactNode;
  },
) {
  const projectId = useContext(NoteScope);
  const { onText, focusKey, header, children, attachmentProjectId, attachments = [], onAttachments, onUploadChange, ...rest } = props;
  const durableAttach = useRef<((files: File[]) => void) | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null),
    file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusKey) {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(0, textarea.current.value.length);
    }
  }, [focusKey]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteMenu, setNoteMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = String(props.value ?? "");
  const latest = useRef({ value, onText, disabled: props.disabled });
  latest.current = { value, onText, disabled: props.disabled };
  useEffect(() => {
    const attach = (e: Event) => {
      if (latest.current.disabled) return;
      const { path, content } = (
        e as CustomEvent<{ path: string; content: string }>
      ).detail;
      if (durableAttach.current) {
        durableAttach.current([new File([content], path.split("/").pop() || "context.txt", {type: "text/plain"})]);
        return;
      }
      latest.current.onText(
        `${latest.current.value}${latest.current.value ? "\n\n" : ""}${fileContext(path, content)}`,
      );
      setError(
        content.length > 64000
          ? "File context was truncated to 64,000 characters."
          : null,
      );
      textarea.current?.focus();
    };
    const mention = (e: Event) => {
      if (latest.current.disabled) return;
      const note = (e as CustomEvent<Note>).detail;
      latest.current.onText(
        `${latest.current.value}${latest.current.value ? " " : ""}@[${note.title}](brigadier-note:${note.id}) `,
      );
      textarea.current?.focus();
    };
    window.addEventListener("brigadier-attach", attach);
    window.addEventListener("brigadier-insert-note", mention);
    return () => {
      window.removeEventListener("brigadier-attach", attach);
      window.removeEventListener("brigadier-insert-note", mention);
    };
  }, []);
  const [uploading, setUploading] = useState(false);
  const attachmentState = useRef({ onAttachments, attachments });
  attachmentState.current = { onAttachments, attachments };
  const addFiles = async (files: FileList | File[] | null) => {
    if (!files || uploading) return;
    if (attachmentProjectId && onAttachments) {
      const destination = onAttachments;
      setUploading(true); onUploadChange?.(true); setError(null);
      try {
        for (const item of Array.from(files)) {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
            reader.onerror = () => reject(new Error(`Could not read ${item.name}`));
            reader.readAsDataURL(item);
          });
          const attachment = await peerApi.importAttachment(attachmentProjectId, item.name, base64);
          if (attachmentState.current.onAttachments !== destination) return;
          const next = [...attachmentState.current.attachments, attachment];
          attachmentState.current.attachments = next;
          destination(next);
        }
      } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { setUploading(false); onUploadChange?.(false); }
      return;
    }
    const destination = latest.current.onText;
    let content = "";
    try {
      for (const item of Array.from(files)) {
        if (item.size > 64000)
          throw new Error(`${item.name} exceeds the 64 KB attachment limit`);
        const text = await item.text();
        if (text.includes("\0") || item.type.startsWith("image/"))
          throw new Error(
            `${item.name}: this adapter currently accepts text file context`,
          );
        content += `\n\n${fileContext(item.name, text)}`;
      }
      if (latest.current.disabled || latest.current.onText !== destination)
        return;
      destination(latest.current.value + content);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  durableAttach.current = attachmentProjectId && onAttachments ? files => { void addFiles(files); } : null;
  return (
    <ComposerBar
      className="relative bg-input"
      data-slot="prompt-input"
      onDragOver={(e) => {
        if (!props.disabled) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (!props.disabled) void addFiles(e.dataTransfer.files);
      }}
    >
      {header}
      {attachments.length > 0 && <div className="flex flex-wrap gap-2 px-2 py-1 text-xs" aria-label="Attached files">{attachments.map(a => <span key={a.id}>{a.name} <Button type="button" disabled={props.disabled || uploading} aria-label={`Remove attachment ${a.name}`} onClick={() => onAttachments?.(attachments.filter(file => file.id !== a.id))}>×</Button></span>)}</div>}
      {uploading && <p role="status" className="px-2 text-xs">Adding attachments…</p>}
      <ComposerInput
        {...rest}
        ref={textarea}
        onChange={(e) => {
          onText(e.target.value);
          if (e.target.value.endsWith("@")) {
            setNoteMenu(true);
            void workbenchApi
              .load()
              .then((d) =>
                setNotes(
                  d.notes.filter(
                    (n) => n.projectId === null || n.projectId === projectId,
                  ),
                ),
              )
              .catch(() => {});
          }
        }}
      />
      <ComposerActions
        className="relative flex-wrap justify-between px-1 pt-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1">
          <MessageAction tooltip={onAttachments ? "Attach files or drop them in the composer" : "Attach text files or drop them in the composer"}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={onAttachments ? "Attach files" : "Attach text files"}
              title={onAttachments ? "Attach files or drop them in the composer" : "Attach text files or drop them in the composer"}
              disabled={props.disabled}
              onClick={() => file.current?.click()}
            >
              <PlusIcon size={18} />
            </Button>
          </MessageAction>
          <Popover
            isOpen={noteMenu && !props.disabled}
            onOpenChange={setNoteMenu}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.disabled}
              aria-label="Mention a note"
              onClick={() => {
                setNoteMenu(!noteMenu);
                void workbenchApi
                  .load()
                  .then((d) =>
                    setNotes(
                      d.notes.filter(
                        (n) =>
                          n.projectId === null || n.projectId === projectId,
                      ),
                    ),
                  )
                  .catch((e) => setError(String(e)));
              }}
            >
              @ Note
            </Button>
            <Popover.Content placement="top start">
              <Popover.Dialog aria-label="Mention a note">
                <ListBox
                  aria-label="Notes"
                  renderEmptyState={() => "No notes yet"}
                  className="max-h-64 min-w-64 overflow-auto"
                >
                  {notes.map((note) => (
                    <ListBox.Item
                      id={note.id}
                      textValue={note.title}
                      key={note.id}
                      onAction={() => {
                        onText(
                          `${value.endsWith("@") ? value.slice(0, -1) : value}${value && !value.endsWith("@") ? " " : ""}@[${note.title}](brigadier-note:${note.id}) `,
                        );
                        setNoteMenu(false);
                        textarea.current?.focus();
                      }}
                    >
                      <Label>{note.title}</Label>
                      <Description>
                        {note.projectId ? "Project" : "Global"}
                      </Description>
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
        </div>
        {children}
        <input
          ref={file}
          type="file"
          multiple
          disabled={props.disabled}
          hidden
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </ComposerActions>
      {error ? (
        <p className="inline-error my-2 text-[13px] text-error" role="alert">
          {error}
        </p>
      ) : null}
    </ComposerBar>
  );
}

function fileContext(path: string, content: string) {
  const body = content.slice(0, 64000);
  const longest = Math.max(
    2,
    ...Array.from(body.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = "`".repeat(longest + 1);
  return `Attached file: ${path} (reference content)\n\n${fence}\n${body}\n${fence}\n`;
}
