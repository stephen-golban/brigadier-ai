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
    if (recovered) setBuffer(recovered);
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
          ? workspaceApi.diff(tab.context, tab.path, !!tab.staged)
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
      noteRef.current = note;
    }
  }, [note]);
  const save = async (target?: string) => {
    if (!buffer) return;
    if (tab.kind === "note" && !target) {
      noteQueue.current = noteQueue.current
        .then(saveNote)
        .catch((e) => setError(errorMessage(e)));
      return;
    }
    if (tab.kind === "untitled" && !target) {
      setSaveAs(true);
      return;
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
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
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
  const hunks =
    buffer?.content
      .split("\n")
      .flatMap((l, i) => (l.startsWith("@@ ") ? [i + 1] : [])) ?? [];
  return (
    <section className="document-tab">
      <div className="document-toolbar">
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
            <select
              aria-label="Language mode"
              value={buffer.language}
              onChange={(e) => update({ language: e.target.value })}
            >
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l === "plaintext" ? "Plain Text" : l}
                </option>
              ))}
            </select>
            <button
              className="act"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : tab.kind === "note" ? "Save note" : "Save"}
            </button>
            <button className="act" onClick={() => setSaveAs(!saveAs)}>
              Save As
            </button>
          </>
        )}
        {buffer && (
          <button
            className="act"
            onClick={() => onAttach(tab.path, buffer.content)}
          >
            Add to chat
          </button>
        )}
        {buffer?.language === "markdown" && (
          <button
            className="act"
            aria-pressed={rendered}
            onClick={() => setRendered(!rendered)}
          >
            Preview
          </button>
        )}
      </div>
      {saveAs && (
        <form
          className="save-as"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void save(path.trim());
          }}
        >
          <label>
            Save in {tab.root}
            <input
              autoFocus
              aria-label="New file path"
              placeholder="Relative path, e.g. notes.md"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <button className="primary-action" disabled={saving || !path.trim()}>
            Save
          </button>
          <button
            type="button"
            className="act"
            onClick={() => setSaveAs(false)}
          >
            Cancel
          </button>
        </form>
      )}
      {note && (
        <div className="note-properties">
          <input
            aria-label="Note title"
            defaultValue={note.title}
            key={note.id}
            onBlur={(e) => {
              if (e.target.value !== noteRef.current?.title)
                void updateNote({ title: e.target.value });
            }}
          />
          <select
            aria-label="Note scope"
            value={note.projectId === null ? "global" : "project"}
            onChange={(e) =>
              void updateNote({
                projectId:
                  e.target.value === "global" ? null : tab.context.projectId,
              })
            }
          >
            <option value="project">Project note</option>
            <option value="global">Global note</option>
          </select>
          <label>
            <input
              type="checkbox"
              checked={note.alwaysInclude}
              onChange={(e) =>
                void updateNote({ alwaysInclude: e.target.checked })
              }
            />
            Always include
          </label>
          <button
            className="act"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("brigadier-mention-note", { detail: note }),
              )
            }
          >
            Mention in chat
          </button>
          <span>{saved ? "Saved" : "Autosaves"}</span>
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {tab.kind === "diff" && buffer && hunks.length > 0 && (
        <div className="diff-actions">
          <button
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
          </button>
          <select aria-label="Diff hunk" defaultValue="">
            <option value="" disabled>
              Stage or unstage a hunk…
            </option>
            {hunks.map((line, index) => (
              <option value={index} key={line}>
                Hunk {index + 1}: {buffer.content.split("\n")[line - 1]}
              </option>
            ))}
          </select>
          <button
            className="act"
            disabled={saving}
            onClick={(e) => {
              const select = e.currentTarget
                .previousElementSibling as HTMLSelectElement;
              const index = Number(select.value);
              if (select.value === "") return;
              const start = hunks[index]!;
              const end =
                (hunks[index + 1] ?? buffer.content.split("\n").length + 1) - 1;
              void stage(
                Array.from({ length: end - start }, (_, i) => start + i + 1),
              );
            }}
          >
            {tab.staged ? "Unstage" : "Stage"} hunk
          </button>
        </div>
      )}
      {buffer ? (
        rendered ? (
          <div className="document-markdown">
            <Markdown text={buffer.content} />
          </div>
        ) : (
          <Suspense fallback={<p className="panel-empty">Loading editor…</p>}>
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
        !error && <p className="panel-empty">Loading file…</p>
      )}
    </section>
  );
}
