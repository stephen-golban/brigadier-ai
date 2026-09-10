import { Checkbox } from "./controls/checkbox";
import { useState, useImperativeHandle, type Ref } from "react";
import { Notepad, Plus, Search, Trash, X } from "../icons";
import { Button } from "./controls/button";
import { Input } from "./controls/input";
import { Textarea } from "./controls/textarea";
import { ActionDialog, type PendingAction } from "./ActionDialog";
import { Markdown } from "./Markdown";
import { workbenchApi, type Note, type WorkbenchData } from "../workbenchApi";
import {
  isTrashed,
  navigationApi,
  type NavigationData,
} from "../navigationApi";
import { errorMessage } from "../workspaceApi";

export interface NotesLibraryHandle {
  leave: (next: () => void) => void;
  open: (id?: string, create?: boolean) => void;
}

export function NotesLibrary({
  ref,
  data,
  navigation,
  initialId,
  initialNew = false,
  onData,
}: {
  ref?: Ref<NotesLibraryHandle>;
  data: WorkbenchData;
  navigation: NavigationData;
  initialId?: string;
  initialNew?: boolean;
  onData: (data: WorkbenchData) => void;
}) {
  const notes = data.notes.filter((n) => !isTrashed(navigation, "note", n.id));
  const draft = (): Note => {
    const names = new Set(notes.map((n) => n.title));
    let title = "Untitled note",
      count = 2;
    while (names.has(title)) title = `Untitled note ${count++}`;
    return {
      id: crypto.randomUUID(),
      title,
      content: "",
      language: "markdown",
      projectId: null,
      alwaysInclude: false,
      revision: 0,
    };
  };
  const [note, setNote] = useState<Note | null>(() =>
    initialNew ? draft() : (notes.find((n) => n.id === initialId) ?? null),
  );
  const [paneOpen, setPaneOpen] = useState(!!note);
  const [saved, setSaved] = useState(initialNew ? null : note);
  const [query, setQuery] = useState(""),
    [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [action, setAction] = useState<PendingAction | null>(null);
  const dirty =
    paneOpen &&
    !!note &&
    (!saved ||
      note.title !== saved.title ||
      note.content !== saved.content ||
      note.alwaysInclude !== saved.alwaysInclude);
  const choose = (next: Note | null) => {
    setPaneOpen(!!next);
    if (next) {
      setNote(next);
      setSaved(next);
    }
    setError("");
  };
  const leave = (next: () => void) => {
    if (busy) return;
    if (dirty)
      setAction({
        title: "Discard unsaved changes?",
        description: "Your saved note stays unchanged.",
        label: "Discard changes",
        destructive: true,
        run: async () => next(),
      });
    else next();
  };
  const refresh = async () => onData(await workbenchApi.load());
  const save = async () => {
    if (!paneOpen || !note || busy || !note.title.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await workbenchApi.saveNote({
        ...note,
        title: note.title.trim(),
      });
      setNote(result);
      setSaved(result);
      await refresh();
      window.dispatchEvent(new Event("workbench-data-changed"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    leave(() => {
      setPaneOpen(true);
      setSaved(null);
      setNote(draft());
      setError("");
      setPreview(false);
    });
  useImperativeHandle(ref, () => ({
    leave,
    open: (id, newNote) =>
      leave(() => {
        choose(
          newNote ? draft() : (notes.find((item) => item.id === id) ?? null),
        );
        if (newNote) setSaved(null);
        setPreview(false);
      }),
  }));
  const filtered = notes.filter((item) =>
    `${item.title} ${item.content}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <section
        aria-label="Notepad"
        className="flex h-full min-h-0 flex-col bg-canvas"
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "s"
          ) {
            event.preventDefault();
            void save();
          }
        }}
      >
        <div className="notepad-split" data-open={paneOpen}>
          <div className="notepad-list min-w-0 overflow-y-auto">
            <header
              className="project-topbar flex shrink-0 items-center justify-end px-3"
              data-tauri-drag-region="deep"
            >
              <Button
                variant="primary"
                className="bg-text text-canvas hover:bg-text/90"
                onClick={create}
                disabled={busy}
              >
                <Plus /> Create
              </Button>
            </header>
            <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6 px-6 pb-12 pt-6">
              <div>
                <h1 className="text-[28px] font-medium tracking-tight">
                  Notepad
                </h1>
                <p className="mt-2 text-[15px] text-text-secondary">
                  Keep ideas and context in notes, available across your
                  projects.
                </p>
              </div>
              <div className="flex h-9 items-center gap-2 rounded-full border border-hairline bg-elevated px-3 text-text-secondary">
                <Search className="size-4" />
                <input
                  aria-label="Search notes"
                  placeholder="Search notes"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-tertiary"
                />
              </div>
              <section aria-label="Notes">
                <h2 className="mb-3 text-sm font-normal text-text-secondary">
                  Your notes
                </h2>
                <div className="flex flex-col gap-2">
                  {filtered.map((item) => (
                    <Button
                      key={item.id}
                      className={`h-auto w-full items-start justify-start gap-3 rounded-lg px-2 py-3 text-left ${paneOpen && note?.id === item.id ? "bg-selected" : ""}`}
                      onClick={() =>
                        leave(() => {
                          choose(item);
                          setPreview(false);
                        })
                      }
                    >
                      <Notepad className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] text-text">
                          {item.title}
                        </span>
                        <span className="mt-1 block truncate text-sm font-normal text-text-secondary">
                          {item.content.replace(/\s+/g, " ").trim() ||
                            "Empty note"}
                        </span>
                      </span>
                    </Button>
                  ))}
                  {!filtered.length && (
                    <p className="py-5 text-sm text-text-secondary">
                      {notes.length
                        ? "No notes found."
                        : "No notes yet. Create a note to get started."}
                    </p>
                  )}
                </div>
              </section>
              {data.notesError && (
                <p role="alert" className="text-sm text-error">
                  {data.notesError}
                </p>
              )}
            </div>
          </div>
          <aside
            className="notepad-editor overflow-hidden"
            aria-label="Note editor"
            aria-hidden={!paneOpen}
            inert={!paneOpen}
          >
            {note && (
              <div className="flex h-full min-h-0 flex-col">
                <header className="flex h-[46px] shrink-0 items-center justify-between px-6 text-sm text-text-secondary">
                  <span>{saved ? "Edit note" : "New note"}</span>
                  <Button
                    size="icon"
                    aria-label="Close note editor"
                    title="Close note editor"
                    disabled={busy}
                    onClick={() => leave(() => choose(null))}
                  >
                    <X />
                  </Button>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
                  <Input
                    aria-label="Note title"
                    autoFocus
                    value={note.title}
                    placeholder="Note title"
                    maxLength={200}
                    disabled={busy}
                    onChange={(e) =>
                      setNote({ ...note, title: e.target.value })
                    }
                    className="note-title-input text-lg font-medium"
                  />
                  <div className="flex min-h-[220px] flex-1 flex-col gap-2">
                    <div className="flex items-center justify-between text-sm text-text-secondary">
                      <span>Content</span>
                      <Button size="sm" onClick={() => setPreview(!preview)}>
                        {preview ? "Edit" : "Preview"}
                      </Button>
                    </div>
                    {preview ? (
                      <div className="min-h-[180px] flex-1 overflow-auto rounded-[12px] border border-hairline bg-elevated p-4">
                        <Markdown text={note.content} />
                      </div>
                    ) : (
                      <Textarea
                        aria-label="Note content"
                        placeholder="Write your note…"
                        value={note.content}
                        disabled={busy}
                        onChange={(e) =>
                          setNote({ ...note, content: e.target.value })
                        }
                        className="min-h-[180px] flex-1 resize-none rounded-[12px] bg-elevated p-4 font-mono text-sm [field-sizing:fixed]"
                      />
                    )}
                  </div>
                  <section className="flex flex-col gap-2">
                    <h2 className="text-sm font-normal text-text-secondary">
                      Details
                    </h2>
                    <div className="rounded-[12px] border border-hairline bg-elevated p-4">
                      <Checkbox
                        className="flex items-center justify-between gap-4 text-sm"
                        checked={note.alwaysInclude}
                        disabled={busy}
                        onCheckedChange={(value) =>
                          setNote({ ...note, alwaysInclude: value })
                        }
                      >
                        Always include in prompts
                      </Checkbox>
                    </div>
                  </section>
                  {error && (
                    <p role="alert" className="text-sm text-error">
                      {error}
                    </p>
                  )}
                </div>
                <footer className="flex min-h-[58px] shrink-0 items-center gap-3 border-t border-hairline px-6 py-3">
                  {saved && (
                    <Button
                      size="icon"
                      aria-label="Move note to Trash"
                      title="Move note to Trash"
                      disabled={busy}
                      onClick={() =>
                        setAction({
                          title: "Move note to Trash?",
                          description: dirty
                            ? "Unsaved changes will be discarded. The saved note can be restored from Trash."
                            : "You can restore this note from Trash.",
                          label: "Move to Trash",
                          destructive: true,
                          run: async () => {
                            const plan = await navigationApi.preview(
                              "note",
                              note.id,
                            );
                            await navigationApi.move(plan);
                            choose(null);
                            await refresh();
                          },
                        })
                      }
                    >
                      <Trash />
                    </Button>
                  )}
                  <span className="grow text-xs text-text-secondary">
                    {dirty ? "Unsaved changes · ⌘S to save" : "Saved"}
                  </span>
                  <Button
                    variant="primary"
                    className="bg-text text-canvas hover:bg-text/90"
                    disabled={busy || !dirty || !note.title.trim()}
                    onClick={() => void save()}
                  >
                    {busy ? "Saving…" : saved ? "Save" : "Create note"}
                  </Button>
                </footer>
              </div>
            )}
          </aside>
        </div>
      </section>
      {action && (
        <ActionDialog action={action} onClose={() => setAction(null)} />
      )}
    </>
  );
}
