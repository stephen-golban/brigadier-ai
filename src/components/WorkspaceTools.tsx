import { SessionReview } from "./SessionReview";
import { useEffect, useRef, useState } from "react";
import {
  FolderIcon,
  FileIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
  GitBranchIcon,
  NotebookIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  workspaceApi,
  errorMessage,
  type FileEntry,
  type GitStatus,
  type WorkspaceContext,
} from "../workspaceApi";
import {
  workbenchApi,
  type WorkbenchData,
  type SearchQuery,
  type SearchResults,
  type Note,
} from "../workbenchApi";
import type { ModelInfo } from "../wire";
import { SourceControl } from "./SourceControl";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
export type WorkspaceMode = "files" | "changes" | "search" | "notes";
export function WorkspaceTools({
  context,
  root,
  mode,
  onMode,
  status,
  refresh,
  revision,
  onOpen,
  onNote,
  onClose,
  data,
  onData,
  models,
  reviewTurn = null,
  visible = true,
}: {
  context: WorkspaceContext;
  root: string;
  mode: WorkspaceMode;
  onMode: (mode: WorkspaceMode) => void;
  status: GitStatus | null;
  refresh: () => void;
  revision: number;
  onOpen: (
    path: string,
    kind: "file" | "diff",
    staged?: boolean,
    line?: number,
  ) => void;
  onNote: (note: Note) => void;
  onClose: () => void;
  data: WorkbenchData;
  onData: (d: WorkbenchData) => void;
  models: ModelInfo[];
  reviewTurn?: string | null;
  visible?: boolean;
}) {
  const [width, setWidth] = useState(
    () => Number(localStorage.getItem("brigadier:workspace-width")) || 350,
  );
  const resize = (width: number) => {
    const w = Math.min(800, Math.max(280, width));
    setWidth(w);
    localStorage.setItem("brigadier:workspace-width", String(w));
  };
  return (
    <aside
      className="workspace-tools-panel"
      style={{ width }}
      aria-label="Workspace"
    >
      <div
        className="workspace-resize"
        role="separator"
        aria-label="Resize workspace"
        aria-orientation="vertical"
        aria-valuemin={280}
        aria-valuemax={800}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            resize(width + (e.key === "ArrowLeft" ? 24 : -24));
          }
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.dataset.start = String(e.clientX);
          e.currentTarget.dataset.width = String(width);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            resize(
              Number(e.currentTarget.dataset.width) +
                Number(e.currentTarget.dataset.start) -
                e.clientX,
            );
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      />
      <div className="workspace-mode-bar">
        {(
          [
            ["files", "Explorer", FolderIcon],
            ["changes", "Source Control", GitBranchIcon],
            ["search", "Search", MagnifyingGlassIcon],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            className="icon-button"
            aria-label={label}
            title={label}
            aria-pressed={mode === value}
            onClick={() => onMode(value)}
          >
            <Icon size={19} />
          </button>
        ))}
        <span className="grow" />
        <button
          className="icon-button"
          aria-label="Close workspace"
          onClick={onClose}
        >
          <XIcon />
        </button>
      </div>
      <div className="workspace-root" title={root}>
        <FolderIcon />
        <span>{root.split("/").pop()}</span>
        <span className="grow" />
        {mode !== "changes" && <span>{status?.branch}</span>}
      </div>
      <div className="workspace-tool-body" data-mode={mode}>
        <div hidden={mode !== "files"}>
          <div className="section-heading">
            <b>Explorer</b>
          </div>
          <Directory
            context={context}
            path=""
            depth={0}
            revision={revision}
            status={status}
            onOpen={(p) => onOpen(p, "file")}
          />
        </div>
        <div hidden={mode !== "changes"} className="workspace-changes">
          {visible && mode === "changes" && (
            <SourceControl
              context={context}
              status={status}
              refresh={refresh}
              onOpen={onOpen}
              data={data}
              onData={onData}
              models={models}
            >
              {mode === "changes" && context.sessionId && (
                <SessionReview
                  turn={reviewTurn}
                  sessionId={context.sessionId}
                  onOpen={(path) =>
                    window.dispatchEvent(
                      new CustomEvent("workbench-recorded-diff", {
                        detail: {
                          sessionId: context.sessionId,
                          path,
                          turn: reviewTurn,
                        },
                      }),
                    )
                  }
                />
              )}
            </SourceControl>
          )}
        </div>
        <div hidden={mode !== "search"}>
          <ProjectSearch
            key={`${context.projectId}:${context.sessionId}`}
            context={context}
            onOpen={(p, l) => onOpen(p, "file", false, l)}
            refresh={refresh}
          />
        </div>
        <div hidden={mode !== "notes"}>
          <div className="section-heading">
            <b>Notepad</b>
          </div>
          {(["project", "global"] as const).map((scope) => (
            <section className="note-list" key={scope}>
              <h3>{scope === "project" ? "Project notes" : "Global notes"}</h3>
              {data.notes
                .filter((n) =>
                  scope === "project"
                    ? n.projectId === context.projectId
                    : n.projectId === null,
                )
                .map((n) => (
                  <button
                    className="tree-row"
                    key={n.id}
                    onClick={() => onNote(n)}
                  >
                    <NotebookIcon />
                    <span>{n.title || "Untitled note"}</span>
                    {n.alwaysInclude && <small>Always included</small>}
                  </button>
                ))}
            </section>
          ))}
          {!data.notes.length && (
            <p className="panel-empty">
              Create a note from the tab bar’s + menu.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
function Directory({
  context,
  path,
  depth,
  revision,
  status,
  onOpen,
}: {
  context: WorkspaceContext;
  path: string;
  depth: number;
  revision: number;
  status: GitStatus | null;
  onOpen: (path: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void workspaceApi
      .entries(context, path)
      .then((e) => {
        if (live) {
          setEntries(e);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [context.projectId, context.sessionId, path, revision]);
  return (
    <div>
      {error && <p className="inline-error">{error}</p>}
      {entries.map((e) => {
        const changes =
          status?.changes.filter(
            (c) =>
              c.path === e.path ||
              (e.directory && c.path.startsWith(e.path + "/")),
          ) ?? [];
        const code = changes.some((c) => c.index === "?" || c.index === "A")
          ? "U"
          : changes.some((c) => c.worktree === "D" || c.index === "D")
            ? "D"
            : changes.length
              ? "M"
              : "";
        return (
          <div key={e.path}>
            <button
              className={`tree-row ${code ? "git-" + code : ""}`}
              style={{ paddingLeft: 12 + depth * 14 }}
              aria-expanded={e.directory ? expanded.has(e.path) : undefined}
              title={
                changes.length
                  ? `${e.path} · ${changes.length} changed file(s)`
                  : e.path
              }
              onClick={() =>
                e.directory
                  ? setExpanded((old) => {
                      const next = new Set(old);
                      if (next.has(e.path)) next.delete(e.path);
                      else next.add(e.path);
                      return next;
                    })
                  : onOpen(e.path)
              }
            >
              {e.directory ? (
                <>
                  <CaretRightIcon
                    className={expanded.has(e.path) ? "rotated" : ""}
                  />
                  <FolderIcon />
                </>
              ) : (
                <FileIcon />
              )}
              <span>{e.name}</span>
              {code && (
                <b className="git-decoration">{e.directory ? "●" : code}</b>
              )}
            </button>
            {e.directory && expanded.has(e.path) && (
              <Directory
                context={context}
                path={e.path}
                depth={depth + 1}
                revision={revision}
                status={status}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
function ProjectSearch({
  context,
  onOpen,
  refresh,
}: {
  context: WorkspaceContext;
  onOpen: (p: string, l: number) => void;
  refresh: () => void;
}) {
  const key = `search:${context.projectId}:${context.sessionId ?? ""}`;
  const [query, setQuery] = useState<SearchQuery>(() => {
    try {
      return (
        JSON.parse(localStorage.getItem(key) ?? "null") ?? {
          text: "",
          regex: false,
          caseSensitive: false,
          wholeWord: false,
          include: "",
          exclude: "",
          replacement: null,
        }
      );
    } catch {
      return {
        text: "",
        regex: false,
        caseSensitive: false,
        wholeWord: false,
        include: "",
        exclude: "",
        replacement: null,
      };
    }
  });
  const [results, setResults] = useState<SearchResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const request = useRef(0);
  const change = (patch: Partial<SearchQuery>) => {
    request.current++;
    setBusy(false);
    setResults(null);
    const next = { ...query, ...patch };
    setQuery(next);
    localStorage.setItem(key, JSON.stringify(next));
  };
  const search = async () => {
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const r = await workbenchApi.search(context, query);
      if (request.current === id) setResults(r);
    } catch (e) {
      if (request.current === id) setError(errorMessage(e));
    } finally {
      if (request.current === id) setBusy(false);
    }
  };
  return (
    <section className="project-search">
      <div className="section-heading">
        <b>Search</b>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="Search project"
          placeholder="Search"
          value={query.text}
          onChange={(e) => change({ text: e.target.value })}
        />
        <div className="search-flags">
          {(
            [
              ["caseSensitive", "Match case", "Aa"],
              ["wholeWord", "Match whole word", "ab"],
              ["regex", "Use regular expression", ".*"],
            ] as const
          ).map(([flag, label, text]) => (
            <button
              key={flag}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={query[flag]}
              onClick={() => change({ [flag]: !query[flag] })}
            >
              {text}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={query.replacement !== null}
            onClick={() =>
              change({ replacement: query.replacement === null ? "" : null })
            }
          >
            Replace
          </button>
        </div>
        {query.replacement !== null && (
          <input
            aria-label="Replace with"
            placeholder="Replace"
            value={query.replacement}
            onChange={(e) => change({ replacement: e.target.value })}
          />
        )}
        <label>
          Files to include
          <input
            aria-label="Files to include"
            placeholder="e.g. src/**, *.ts"
            value={query.include}
            onChange={(e) => change({ include: e.target.value })}
          />
        </label>
        <label>
          Files to exclude
          <input
            aria-label="Files to exclude"
            placeholder="e.g. dist, *.test.ts"
            value={query.exclude}
            onChange={(e) => change({ exclude: e.target.value })}
          />
        </label>
        <button className="act" disabled={!query.text || busy}>
          {busy
            ? "Searching…"
            : query.replacement !== null
              ? "Preview replacement"
              : "Search"}
        </button>
      </form>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {results && (
        <>
          <p className="search-summary">
            {results.hits.length} results in {results.files} files
            {results.truncated ? " · Limit reached; narrow your search" : ""}
          </p>
          {results.replacements.length > 0 && (
            <>
              <button
                className="primary-action"
                disabled={busy || results.truncated}
                onClick={() =>
                  setConfirm({
                    title: "Replace across files",
                    body: `Replace ${results.replacements.reduce((n, c) => n + c.count, 0)} matches in ${results.replacements.length} files? Files edited since this preview will be refused.`,
                    confirmLabel: "Replace all",
                    onCancel: () => setConfirm(null),
                    onConfirm: async () => {
                      setConfirm(null);
                      setBusy(true);
                      try {
                        await workbenchApi.replace(
                          context,
                          results.replacements,
                        );
                        refresh();
                        setResults(null);
                      } catch (e) {
                        setError(errorMessage(e));
                      } finally {
                        setBusy(false);
                      }
                    },
                  })
                }
              >
                Replace all
              </button>
              {results.replacements.map((c) => (
                <details key={c.path} className="replace-preview">
                  <summary>
                    {c.path} · {c.count} replacements
                  </summary>
                  <b>Before</b>
                  <pre>{c.before}</pre>
                  <b>After</b>
                  <pre>{c.after}</pre>
                </details>
              ))}
            </>
          )}
          {results.hits.map((hit, i) => (
            <button
              key={`${hit.path}:${hit.line}:${hit.column}:${i}`}
              className="search-result"
              onClick={() => onOpen(hit.path, hit.line)}
            >
              <span>
                {hit.path}:{hit.line}
              </span>
              <code>{hit.text}</code>
            </button>
          ))}
        </>
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </section>
  );
}
