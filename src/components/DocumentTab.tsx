import { SelectMenu } from "./SelectMenu";
import { Checkbox } from "./controls/checkbox";
import { Input } from "./controls/input";
import { Button } from "@/components/ui/button";
import { documentCommands } from "../documentCommands";
import { desktopApi } from "../desktopApi";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { workspaceApi, errorMessage } from "../workspaceApi";
import { workbenchApi, type Note } from "../workbenchApi";
import { documentKey, languageFor, type ProjectTab } from "../workbenchState";
import { Markdown } from "./Markdown";
const CodeEditor = lazy(() => import("./CodeEditor"));
const languages = [
  "plaintext",
  "markdown",
  "typescript",
  "javascript",
  "json",
  "css",
  "html",
  "rust",
  "python",
  "shell",
  "yaml",
  "sql",
];
interface Buffer {
  content: string;
  before: string | null;
  language: string;
}
// A note's save queue survives tab unmounts so a quick switch cannot drop its final edit.
const noteWrites = new Map<string, Promise<void>>();
const noteVersions = new Map<string, Note>();
function writeNote(note: Note, patch: Partial<Note>): Promise<Note> {
  const result = (noteWrites.get(note.id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const known = noteVersions.get(note.id);
      const base = known && known.revision > note.revision ? known : note;
      const saved = await workbenchApi.saveNote({ ...base, ...patch });
      noteVersions.set(note.id, saved);
      return saved;
    });
  const settled = result.then(
    () => {},
    () => {},
  );
  noteWrites.set(note.id, settled);
  void settled.then(() => {
    if (noteWrites.get(note.id) === settled) noteWrites.delete(note.id);
  });
  return result;
}
export function DocumentTab({
  tab,
  note,
  onNote,
  onSaved,
  onAttach,
  refresh,
}: {
  tab: ProjectTab;
  note?: Note;
  onNote: (n: Note) => void;
  onSaved: (path: string) => void;
  onAttach: (path: string, content: string) => void;
  refresh: () => void;
}) {
  const [buffer, setBuffer] = useState<Buffer | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [path, setPath] = useState("");
  const [saveAs, setSaveAs] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [selection, setSelection] = useState<[number, number]>([1, 1]);
  const noteRef = useRef(note);
  const noteConflict = useRef(false);
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    let recovered: Buffer | null = null;
    try {
      recovered = JSON.parse(localStorage.getItem(documentKey(tab)) ?? "null");
    } catch {
      /* recover from source */
    }
    if (
      tab.kind === "note" &&
      recovered &&
      note &&
      recovered.content !== recovered.before &&
      recovered.before !== note.content
    ) {
      noteConflict.current = true;
      setError(
        "This note changed outside Brigadier. Save As to keep your draft, or reload from disk.",
      );
    }
    if (
      recovered &&
      (tab.kind !== "note" || recovered.content !== recovered.before)
    )
      setBuffer(recovered);
    else if (tab.kind === "note") {
      setBuffer({
        content: note?.content ?? "",
        before: note?.content ?? "",
        language: note?.language ?? "markdown",
      });
    } else if (tab.kind === "untitled") {
      setBuffer({ content: "", before: null, language: "plaintext" });
    } else {
      void (
        tab.kind === "diff"
          ? tab.recorded && tab.context.sessionId
            ? desktopApi
                .diff(tab.context.sessionId, tab.path, tab.turn ?? null)
                .then((content) => ({ content, truncated: false }))
            : workspaceApi.diff(tab.context, tab.path, !!tab.staged)
          : workspaceApi.file(tab.context, tab.path)
      )
        .then((f) => {
          if (live) {
            if (f.truncated)
              setError("This file exceeds the editor limit; it is read-only.");
            setBuffer({
              content: f.content,
              before: f.content,
              language: tab.kind === "diff" ? "diff" : languageFor(tab.path),
            });
          }
        })
        .catch((e) => {
          if (live) setError(errorMessage(e));
        });
    }
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [tab.id]);
  const update = (patch: Partial<Buffer>) => {
    setSaved(false);
    setBuffer((old) => {
      if (!old) return old;
      const next = { ...old, ...patch };
      try {
        localStorage.setItem(documentKey(tab), JSON.stringify(next));
      } catch {
        setError(
          "Draft could not be saved locally. Keep this tab open and use Save As.",
        );
      }
      return next;
    });
  };
  const saveNote = async () => {
    if (noteConflict.current)
      throw new Error(
        "This note changed outside Brigadier. Save As to keep your draft, or reload from disk.",
      );
    const n = noteRef.current;
    const b = bufferRef.current;
    if (!n || !b) return;
    const captured = b.content;
    if (n.content === captured && n.language === b.language) return;
    const result = await writeNote(n, {
      content: captured,
      language: b.language,
    });
    noteRef.current = result;
    onNote(result);
    if (
      mounted.current &&
      bufferRef.current?.content === captured &&
      bufferRef.current?.language === b.language
    ) {
      setSaved(true);
      setBuffer((current) =>
        current ? { ...current, before: captured } : current,
      );
      localStorage.removeItem(documentKey(tab));
    }
  };
  // Serialize note autosaves, including edits made while an earlier save is in flight.
  const noteQueue = useRef(Promise.resolve());
  useEffect(() => {
    if (tab.kind !== "note" || !buffer || !noteRef.current) return;
    const timer = setTimeout(() => {
      noteQueue.current = noteQueue.current.then(saveNote).catch((e) => {
        if (mounted.current) setError(errorMessage(e));
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [buffer?.content, buffer?.language]);
  useEffect(
    () => () => {
      if (tab.kind === "note")
        void saveNote().catch(() => {
          /* Recovery buffer remains for retry. */
        });
    },
    [tab.id],
  );
  useEffect(() => {
    if (note && note.revision > (noteRef.current?.revision ?? 0)) {
      if (bufferRef.current?.content === bufferRef.current?.before) {
        setBuffer((current) =>
          current
            ? { ...current, content: note.content, before: note.content }
            : current,
        );
      } else if (note.content !== noteRef.current?.content) {
        noteConflict.current = true;
        setError(
          "This note changed outside Brigadier. Save As to keep your draft, or reload from disk.",
        );
      }
      noteRef.current = note;
    }
  }, [note]);
  const save = async (target?: string) => {
    if (!buffer) return false;
    if (tab.kind === "note" && !target) {
      noteQueue.current = noteQueue.current
        .then(saveNote)
        .catch((e) => setError(errorMessage(e)));
      await noteQueue.current;
      return bufferRef.current?.content === noteRef.current?.content;
    }
    if (tab.kind === "untitled" && !target) {
      setSaveAs(true);
      return false;
    }
    setSaving(true);
    setError("");
    try {
      await workbenchApi.save(
        tab.context,
        target ?? tab.path,
        buffer.content,
        target ? null : buffer.before,
      );
      localStorage.removeItem(documentKey(tab));
      setBuffer((current) =>
        current ? { ...current, before: buffer.content } : current,
      );
      setSaved(bufferRef.current?.content === buffer.content);
      if (bufferRef.current && bufferRef.current.content !== buffer.content)
        localStorage.setItem(
          documentKey(tab),
          JSON.stringify({ ...bufferRef.current, before: buffer.content }),
        );
      setSaveAs(false);
      if (target) onSaved(target);
      refresh();
      return bufferRef.current?.content === buffer.content;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const dirty =
      !!buffer &&
      tab.kind !== "diff" &&
      buffer.content !== (buffer.before ?? "");
    documentCommands.set(tab.id, { save: () => save(), dirty });
    window.dispatchEvent(new Event("workbench-document-state"));
    const key = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "s" &&
        !event.altKey
      ) {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      documentCommands.delete(tab.id);
      window.removeEventListener("keydown", key);
    };
  }, [tab.id, buffer]);
  const stage = async (lines: number[]) => {
    if (!buffer) return;
    setSaving(true);
    try {
      await workbenchApi.gitAction(tab.context, {
        action: tab.staged ? "unstage_lines" : "stage_lines",
        path: tab.path,
        expectedDiff: buffer.content,
        lines,
      });
      const f = await workspaceApi.diff(tab.context, tab.path, !!tab.staged);
      setBuffer({ ...buffer, content: f.content, before: f.content });
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const updateNote = async (patch: Partial<Note>) => {
    if (!noteRef.current) return;
    noteQueue.current = noteQueue.current
      .then(async () => {
        const n = noteRef.current!;
        const result = await writeNote(n, {
          ...patch,
          content: bufferRef.current?.content ?? n.content,
          language: bufferRef.current?.language ?? n.language,
        });
        noteRef.current = result;
        onNote(result);
      })
      .catch((e) => setError(errorMessage(e)));
  };
  const [hunk, setHunk] = useState("");
  const hunks =
    buffer?.content
      .split("\n")
      .flatMap((l, i) => (l.startsWith("@@ ") ? [i + 1] : [])) ?? [];
  return (
    <section className="document-tab flex h-full min-h-0 flex-col bg-canvas">
      <div className="document-toolbar flex shrink-0 flex-wrap items-center gap-2 p-2 text-text-secondary">
        <span title={tab.path}>
          {note?.title ?? tab.path}
          {buffer &&
          buffer.before !== null &&
          buffer.content !== buffer.before &&
          tab.kind !== "note"
            ? " •"
            : ""}
        </span>
        <span className="grow" />
        {buffer && tab.kind !== "diff" && (
          <>
            <SelectMenu
              label="Language mode"
              value={buffer.language}
              onChange={(language) => update({ language })}
              options={languages.map((l) => ({
                value: l,
                label: l === "plaintext" ? "Plain Text" : l,
              }))}
            />
            <Button
              variant="ghost"
              size="sm"
              className="act"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : tab.kind === "note" ? "Save note" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="act"
              onClick={() => setSaveAs(!saveAs)}
            >
              Save As
            </Button>
          </>
        )}
        {buffer && (
          <Button
            variant="ghost"
            size="sm"
            className="act"
            onClick={() => onAttach(tab.path, buffer.content)}
          >
            Add to chat
          </Button>
        )}
        {buffer?.language === "markdown" && (
          <Button
            variant="ghost"
            size="sm"
            className="act"
            aria-pressed={rendered}
            onClick={() => setRendered(!rendered)}
          >
            Preview
          </Button>
        )}
      </div>
      {saveAs && (
        <form
          className="save-as flex items-center gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void save(path.trim());
          }}
        >
          <label>
            Save in {tab.root}
            <Input
              autoFocus
              aria-label="New file path"
              placeholder="Relative path, e.g. notes.md"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="primary-action"
            disabled={saving || !path.trim()}
          >
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="act"
            onClick={() => {
              setSaveAs(false);
              window.dispatchEvent(new Event("workbench-save-as-cancelled"));
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      {note && (
        <div className="note-properties flex flex-wrap items-center gap-2 p-2 text-text-secondary">
          <Input
            aria-label="Note title"
            defaultValue={note.title}
            key={`${note.id}:${note.title}`}
            onBlur={(e) => {
              if (e.target.value !== noteRef.current?.title)
                void updateNote({ title: e.target.value });
            }}
          />
          <SelectMenu
            label="Note scope"
            value={note.projectId === null ? "global" : "project"}
            onChange={(value) =>
              void updateNote({
                projectId: value === "global" ? null : tab.context.projectId,
              })
            }
            options={[
              { value: "project", label: "Project note" },
              { value: "global", label: "Global note" },
            ]}
          />
          <Checkbox
            checked={note.alwaysInclude}
            onCheckedChange={(e) => void updateNote({ alwaysInclude: e })}
          >
            Always include
          </Checkbox>
          <Button
            variant="ghost"
            size="sm"
            className="act"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("brigadier-mention-note", { detail: note }),
              )
            }
          >
            Mention in chat
          </Button>
          <span>{saved ? "Saved" : "Autosaves"}</span>
        </div>
      )}
      {noteConflict.current && note && (
        <Button
          variant="ghost"
          size="sm"
          className="act"
          onClick={() => {
            noteConflict.current = false;
            setBuffer({
              content: note.content,
              before: note.content,
              language: note.language,
            });
            localStorage.removeItem(documentKey(tab));
            setError("");
          }}
        >
          Discard draft and reload from disk
        </Button>
      )}
      {error && (
        <p className="inline-error my-2 text-[13px] text-error" role="alert">
          {error}
        </p>
      )}
      {tab.kind === "diff" && !tab.recorded && buffer && hunks.length > 0 && (
        <div className="diff-actions flex items-center gap-2 p-2">
          <Button
            variant="ghost"
            size="sm"
            className="act"
            disabled={saving}
            onClick={() =>
              void stage(
                Array.from(
                  { length: selection[1] - selection[0] + 1 },
                  (_, i) => selection[0] + i,
                ),
              )
            }
          >
            {tab.staged ? "Unstage" : "Stage"} selected lines
          </Button>
          <SelectMenu
            label="Diff hunk"
            value={hunk}
            onChange={setHunk}
            options={hunks.map((line, index) => ({
              value: String(index),
              label: `Hunk ${index + 1}: ${buffer.content.split("\n")[line - 1]}`,
            }))}
          />
          <Button
            variant="ghost"
            size="sm"
            className="act"
            disabled={saving}
            onClick={() => {
              const index = Number(hunk);
              if (hunk === "" || !hunks[index]) return;
              const start = hunks[index]!;
              const end =
                (hunks[index + 1] ?? buffer.content.split("\n").length + 1) - 1;
              void stage(
                Array.from({ length: end - start }, (_, i) => start + i + 1),
              );
            }}
          >
            {tab.staged ? "Unstage" : "Stage"} hunk
          </Button>
        </div>
      )}
      {buffer ? (
        rendered ? (
          <div className="document-markdown min-h-0 flex-1 overflow-auto p-5 text-text">
            <Markdown text={buffer.content} />
          </div>
        ) : (
          <Suspense
            fallback={
              <p className="panel-empty p-3 text-text-disabled">
                Loading editor…
              </p>
            }
          >
            <CodeEditor
              id={tab.id}
              value={buffer.content}
              language={buffer.language}
              line={tab.line}
              readOnly={tab.kind === "diff" || error.includes("read-only")}
              onChange={(value) => {
                if (tab.kind !== "diff") update({ content: value });
              }}
              onSave={() => void save()}
              onSelection={(a, b) => setSelection([a, b])}
            />
          </Suspense>
        )
      ) : (
        !error && (
          <p className="panel-empty p-3 text-text-disabled">Loading file…</p>
        )
      )}
    </section>
  );
}
