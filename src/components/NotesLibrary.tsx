import { useState } from "react";
import { FileText, Plus, Save, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { ActionDialog, type PendingAction } from "./ActionDialog";
import { Markdown } from "./Markdown";
import { workbenchApi, type Note, type WorkbenchData } from "../workbenchApi";
import {
  isTrashed,
  navigationApi,
  type NavigationData,
} from "../navigationApi";
import { errorMessage } from "../workspaceApi";

export function NotesLibrary({
  data,
  navigation,
  initialId,
  onData,
  onClose,
}: {
  data: WorkbenchData;
  navigation: NavigationData;
  initialId?: string;
  onData: (data: WorkbenchData) => void;
  onClose: () => void;
}) {
  const notes = data.notes.filter((n) => !isTrashed(navigation, "note", n.id));
  const [note, setNote] = useState<Note | null>(
    () => notes.find((n) => n.id === initialId) ?? notes[0] ?? null,
  );
  const [saved, setSaved] = useState(note);
  const [query, setQuery] = useState(""),
    [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [action, setAction] = useState<PendingAction | null>(null);
  const dirty =
    !!note &&
    (!saved ||
      note.title !== saved.title ||
      note.content !== saved.content ||
      note.alwaysInclude !== saved.alwaysInclude);
  const choose = (next: Note | null) => {
    setNote(next);
    setSaved(next);
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
    if (!note || busy || !note.title.trim()) return;
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
      const names = new Set(notes.map((n) => n.title));
      let title = "Untitled note",
        count = 2;
      while (names.has(title)) title = `Untitled note ${count++}`;
      setSaved(null);
      setNote({
        id: crypto.randomUUID(),
        title,
        content: "",
        language: "markdown",
        projectId: null,
        alwaysInclude: false,
        revision: 0,
      });
      setError("");
      setPreview(false);
    });
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) leave(onClose);
        }}
      >
        <DialogContent
          className="flex h-[min(80vh,720px)] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
          onInteractOutside={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              void save();
            }
          }}
        >
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle>Notes</DialogTitle>
            <DialogDescription>
              All your notes, available across projects.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1">
            <aside className="flex w-48 shrink-0 flex-col border-r border-border p-3 sm:w-64">
              <Input
                aria-label="Search notes"
                placeholder="Search notes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button
                variant="ghost"
                className="my-2 justify-start"
                onClick={create}
                disabled={busy}
              >
                <Plus />
                New note
              </Button>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                {notes
                  .filter((n) =>
                    n.title.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((n) => (
                    <Button
                      variant={note?.id === n.id ? "secondary" : "ghost"}
                      className="w-full justify-start"
                      key={n.id}
                      disabled={busy}
                      onClick={() => leave(() => choose(n))}
                    >
                      <FileText />
                      <span className="truncate">{n.title}</span>
                    </Button>
                  ))}
                {!notes.length && (
                  <p className="p-2 text-sm text-muted-foreground">
                    No notes yet.
                  </p>
                )}
              </div>
              {data.notesError && (
                <p role="alert" className="text-xs text-destructive">
                  {data.notesError}
                </p>
              )}
            </aside>
            <section className="flex min-w-0 flex-1 flex-col gap-3 p-4">
              {note ? (
                <>
                  <Input
                    aria-label="Note title"
                    value={note.title}
                    maxLength={200}
                    disabled={busy}
                    onChange={(e) =>
                      setNote({ ...note, title: e.target.value })
                    }
                    className="text-lg font-medium"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={preview ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => setPreview(!preview)}
                    >
                      {preview ? "Edit" : "Preview"}
                    </Button>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={note.alwaysInclude}
                        disabled={busy}
                        onChange={(e) =>
                          setNote({ ...note, alwaysInclude: e.target.checked })
                        }
                      />
                      Always include in prompts
                    </label>
                    <span className="grow" />
                    {saved && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Move note to Trash"
                        disabled={busy}
                        onClick={() => {
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
                          });
                        }}
                      >
                        <Trash2 />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={busy || !dirty || !note.title.trim()}
                      onClick={() => void save()}
                    >
                      <Save />
                      {busy ? "Saving…" : "Save"}
                    </Button>
                  </div>
                  {preview ? (
                    <div className="min-h-0 flex-1 overflow-auto">
                      <Markdown text={note.content} />
                    </div>
                  ) : (
                    <Textarea
                      aria-label="Note content"
                      value={note.content}
                      disabled={busy}
                      onChange={(e) =>
                        setNote({ ...note, content: e.target.value })
                      }
                      className="min-h-0 flex-1 resize-none font-mono text-sm [field-sizing:fixed]"
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {dirty ? "Unsaved changes · ⌘S to save" : "Saved"}
                  </p>
                </>
              ) : (
                <div className="m-auto text-center text-sm text-muted-foreground">
                  <FileText className="mx-auto mb-3 size-8" />
                  <p>Select a note or create one.</p>
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>
      {action && (
        <ActionDialog action={action} onClose={() => setAction(null)} />
      )}
    </>
  );
}
