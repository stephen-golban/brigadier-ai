import {
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type TextareaHTMLAttributes,
  type ReactNode,
} from "react";
import { NoteScope } from "../noteScope";
import { workbenchApi, type Note } from "../workbenchApi";
import { PlusIcon } from "@phosphor-icons/react";

import {
  PromptInput as KitPromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputAction,
} from "./prompt-kit/prompt-input";
import { Button } from "./ui/button";

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
export function PromptInput(
  props: TextareaHTMLAttributes<HTMLTextAreaElement> & {
    onText: (value: string) => void;
    focusKey?: string;
    header?: ReactNode;
    children?: ReactNode;
  },
) {
  const projectId = useContext(NoteScope);
  const { onText, focusKey, header, children, ...rest } = props;
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
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
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
  return (
    <KitPromptInput
      value={value}
      onValueChange={onText}
      disabled={props.disabled}
      className="relative bg-secondary"
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
      <PromptInputTextarea
        {...rest}
        ref={textarea}
        onChange={(e) => {
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
      <PromptInputActions
        className="relative flex-wrap justify-between px-1 pt-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1">
          <PromptInputAction tooltip="Attach text files or drop them in the composer">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Attach text files"
              title="Attach text files or drop them in the composer"
              disabled={props.disabled}
              onClick={() => file.current?.click()}
            >
              <PlusIcon size={18} />
            </Button>
          </PromptInputAction>
          <PromptInputAction tooltip="Mention a note">
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
          </PromptInputAction>
        </div>
        {children}
        {noteMenu && !props.disabled && (
          <div className="note-mention-menu">
            {notes.map((note) => (
              <button
                type="button"
                key={note.id}
                onClick={() => {
                  onText(
                    `${value.endsWith("@") ? value.slice(0, -1) : value}${value && !value.endsWith("@") ? " " : ""}@[${note.title}](brigadier-note:${note.id}) `,
                  );
                  setNoteMenu(false);
                  textarea.current?.focus();
                }}
              >
                {note.title}
                <small>{note.projectId ? "Project" : "Global"}</small>
              </button>
            ))}
            {!notes.length && <span>No notes yet</span>}
          </div>
        )}
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
      </PromptInputActions>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </KitPromptInput>
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
