import { useVirtualizer } from "@tanstack/react-virtual";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderIcon,
  FileIcon,
  GitDiffIcon,
  TerminalIcon,
  XIcon,
  PlusIcon,
  ArrowClockwiseIcon,
  CaretRightIcon,
} from "@phosphor-icons/react";
import {
  workspaceApi,
  errorMessage,
  type WorkspaceContext,
  type FileEntry,
  type FilePreview,
  type GitStatus,
} from "../workspaceApi";
import { Markdown, CopyButton } from "./Markdown";
const TerminalView = lazy(() => import("./TerminalView"));
export interface WorkspaceTab {
  id: string;
  kind: "file" | "diff" | "terminal";
  path: string;
  staged?: boolean;
}
export function WorkspacePanel({
  context,
  rootPath,
  visible,
  tabs,
  setTabs,
  active,
  setActive,
  onClose,
  onAttach,
}: {
  context: WorkspaceContext;
  rootPath: string;
  visible: boolean;
  tabs: WorkspaceTab[];
  setTabs: (tabs: WorkspaceTab[]) => void;
  active: string | null;
  setActive: (id: string | null) => void;
  onClose: () => void;
  onAttach: (path: string, content: string) => void;
}) {
  const [mode, setMode] = useState<"files" | "changes">("files");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [width, setWidth] = useState(480);
  const open = (path: string, kind: "file" | "diff", staged = false) => {
    const id = `${kind}:${staged}:${path}`;
    if (!tabs.some((t) => t.id === id))
      setTabs([...tabs, { id, kind, path, staged }]);
    setActive(id);
  };
  useEffect(() => {
    if (!visible) return;
    let live = true;
    void workspaceApi.git(context).then(
      (s) => {
        if (live) {
          setStatus(s);
          setError(null);
        }
      },
      (e) => {
        if (live) setError(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [context.projectId, context.sessionId, revision, visible]);
  useEffect(() => {
    if (!visible) return;
    setRevision((n) => n + 1);
    const id = setInterval(() => setRevision((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [visible]);
  const selected = tabs.find((t) => t.id === active);
  return (
    <aside className="workspace-panel" style={{ width }} aria-label="Workspace">
      <div
        className="workspace-resize"
        role="separator"
        aria-label="Resize workspace"
        aria-orientation="vertical"
        tabIndex={0}
        aria-valuenow={width}
        aria-valuemin={320}
        aria-valuemax={1000}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            setWidth((w) =>
              Math.min(
                1000,
                Math.max(320, w + (e.key === "ArrowLeft" ? 32 : -32)),
              ),
            );
          }
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.dataset.start = String(e.clientX);
          e.currentTarget.dataset.width = String(width);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            setWidth(
              Math.max(
                320,
                Math.min(
                  1000,
                  Number(e.currentTarget.dataset.width) +
                    Number(e.currentTarget.dataset.start) -
                    e.clientX,
                ),
              ),
            );
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      />
      <header className="workspace-head">
        <b>Workspace</b>
        <span className="grow" />
        <button
          className="icon-button"
          title="Refresh workspace"
          aria-label="Refresh workspace"
          onClick={() => setRevision((n) => n + 1)}
        >
          <ArrowClockwiseIcon />
        </button>
        <button
          className="icon-button"
          aria-label="Close workspace"
          onClick={onClose}
        >
          <XIcon />
        </button>
      </header>
      <div className="workspace-root" title={rootPath}>
        <FolderIcon size={14} />
        <span>{rootPath.split("/").filter(Boolean).slice(-1)[0]}</span>
        <span className="grow" />
        <span>{status?.branch}</span>
      </div>
      <div className="workspace-tools">
        <button
          aria-pressed={mode === "files"}
          onClick={() => setMode("files")}
        >
          <FolderIcon />
          Files
        </button>
        <button
          aria-pressed={mode === "changes"}
          onClick={() => setMode("changes")}
        >
          <GitDiffIcon />
          Changes {status?.changes.length ?? ""}
        </button>
        <span className="grow" />
        <button
          aria-label="New terminal"
          onClick={() => {
            const id = crypto.randomUUID();
            setTabs([...tabs, { id, kind: "terminal", path: "Terminal" }]);
            setActive(id);
          }}
        >
          <PlusIcon />
          <TerminalIcon />
        </button>
      </div>
      <div className="workspace-browser">
        {mode === "files" ? (
          <Directory
            key={`${context.projectId}:${context.sessionId}`}
            context={context}
            path=""
            depth={0}
            revision={revision}
            onOpen={(path) => open(path, "file")}
          />
        ) : (
          <>
            {error ? (
              <p className="inline-error" role="alert">
                {error}
              </p>
            ) : null}
            {status?.changes.length === 0 ? (
              <p className="panel-empty">Working tree clean</p>
            ) : null}
            {(["staged", "working"] as const).map((group) => {
              const changes =
                status?.changes.filter((c) =>
                  group === "staged"
                    ? c.index !== " " && c.index !== "?"
                    : c.worktree !== " " || c.index === "?",
                ) ?? [];
              return changes.length ? (
                <section key={group} className="change-group">
                  <h3>
                    {group === "staged" ? "Staged changes" : "Working tree"}
                  </h3>
                  {changes.map((c) => (
                    <button
                      key={c.path}
                      className="tree-row"
                      onClick={() => open(c.path, "diff", group === "staged")}
                    >
                      <FileIcon />
                      <span>{c.path}</span>
                      <span className="change-code">
                        {group === "staged" ? c.index : c.worktree}
                      </span>
                    </button>
                  ))}
                </section>
              ) : null;
            })}
          </>
        )}
      </div>
      <div
        className="workspace-tabs"
        role="tablist"
        aria-label="Open workspace tabs"
      >
        {tabs.map((t, i) => (
          <div className="workspace-tab" key={t.id}>
            <button
              role="tab"
              aria-selected={active === t.id}
              onClick={() => setActive(t.id)}
            >
              {t.kind === "terminal" ? (
                <TerminalIcon />
              ) : t.kind === "diff" ? (
                <GitDiffIcon />
              ) : (
                <FileIcon />
              )}
              {t.kind === "terminal"
                ? `Terminal ${i + 1}`
                : t.path.split("/").slice(-1)[0]}
            </button>
            <button
              className="icon-button"
              aria-label={`Close ${t.path}`}
              onClick={() => {
                const rest = tabs.filter((tab) => tab.id !== t.id);
                setTabs(rest);
                if (active === t.id)
                  setActive(rest[rest.length - 1]?.id ?? null);
              }}
            >
              <XIcon size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="workspace-content">
        {tabs
          .filter((t) => t.kind === "terminal")
          .map((t) => (
            <div
              key={t.id}
              className="terminal-surface"
              hidden={active !== t.id}
            >
              <Suspense
                fallback={<p className="panel-empty">Loading terminal…</p>}
              >
                <TerminalView
                  context={context}
                  visible={visible && active === t.id}
                />
              </Suspense>
            </div>
          ))}
        {selected && selected.kind !== "terminal" ? (
          <Preview
            key={selected.id}
            context={context}
            tab={selected}
            revision={revision}
            onAttach={onAttach}
            onFile={(path) => open(path, "file")}
          />
        ) : !selected ? (
          <div className="panel-empty">
            <FileIcon size={28} />
            <p>
              Open a file, review a change,
              <br />
              or start a terminal.
            </p>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
function Directory({
  context,
  path,
  depth,
  revision,
  onOpen,
}: {
  context: WorkspaceContext;
  path: string;
  depth: number;
  revision: number;
  onOpen: (path: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void workspaceApi.entries(context, path).then(
      (e) => {
        if (current) {
          setEntries(e);
          setError(null);
        }
      },
      (e) => {
        if (current) setError(errorMessage(e));
      },
    );
    return () => {
      current = false;
    };
  }, [context.projectId, context.sessionId, path, revision]);
  return (
    <div>
      {error ? <p className="inline-error">{error}</p> : null}
      {entries.map((entry) => (
        <div key={entry.path}>
          <button
            className="tree-row"
            style={{ paddingLeft: 12 + depth * 14 }}
            aria-expanded={
              entry.directory ? expanded.has(entry.path) : undefined
            }
            onClick={() =>
              entry.directory
                ? setExpanded((old) => {
                    const next = new Set(old);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    return next;
                  })
                : onOpen(entry.path)
            }
          >
            {entry.directory ? (
              <>
                <CaretRightIcon
                  className={expanded.has(entry.path) ? "rotated" : ""}
                />
                <FolderIcon />
              </>
            ) : (
              <FileIcon />
            )}
            <span>{entry.name}</span>
          </button>
          {entry.directory && expanded.has(entry.path) ? (
            <Directory
              context={context}
              path={entry.path}
              depth={depth + 1}
              revision={revision}
              onOpen={onOpen}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
function Preview({
  context,
  tab,
  revision,
  onAttach,
  onFile,
}: {
  context: WorkspaceContext;
  tab: WorkspaceTab;
  revision: number;
  onAttach: (path: string, content: string) => void;
  onFile: (path: string) => void;
}) {
  const [file, setFile] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const callback = useRef(onAttach);
  callback.current = onAttach;
  useEffect(() => {
    let current = true;
    void (
      tab.kind === "diff"
        ? workspaceApi.diff(context, tab.path, !!tab.staged)
        : workspaceApi.file(context, tab.path)
    ).then(
      (f) => {
        if (current) {
          setFile(f);
          setError(null);
        }
      },
      (e) => {
        if (current) {
          setError(errorMessage(e));
          setFile(null);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [
    context.projectId,
    context.sessionId,
    tab.path,
    tab.kind,
    tab.staged,
    revision,
  ]);
  return (
    <div className="file-preview">
      <div className="preview-toolbar">
        <span title={tab.path}>
          {tab.path}
          {tab.kind === "diff"
            ? tab.staged
              ? " · Staged"
              : " · Working tree"
            : ""}
        </span>
        <span className="grow" />
        {file ? (
          <>
            <button
              className="act"
              onClick={() => callback.current(file.path, file.content)}
            >
              Add to chat
            </button>
            <CopyButton text={file.content} />
          </>
        ) : null}
        {/\.md$/i.test(tab.path) && tab.kind === "file" ? (
          <button
            className="act"
            aria-pressed={rendered}
            onClick={() => setRendered(!rendered)}
          >
            Preview
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : file ? (
        <>
          {rendered ? (
            <div className="file-scroll">
              <Markdown
                text={file.content}
                onFile={(path) => onFile(relativeLink(tab.path, path))}
              />
            </div>
          ) : (
            <SourcePreview text={file.content} kind={tab.kind} />
          )}
          {file.truncated ? (
            <p className="inline-error">Preview truncated at 512 KiB.</p>
          ) : null}
        </>
      ) : (
        <p className="panel-empty">Loading file…</p>
      )}
    </div>
  );
}

function diffLineClass(kind: WorkspaceTab["kind"], line: string) {
  return kind !== "diff"
    ? ""
    : line.startsWith("+")
      ? "added"
      : line.startsWith("-")
        ? "removed"
        : line.startsWith("@@")
          ? "hunk"
          : "";
}

function sourceClass(kind: WorkspaceTab["kind"]) {
  return kind === "diff" ? "diff-code" : "source-code";
}

function relativeLink(from: string, to: string) {
  if (to.startsWith("/")) return to;
  const parts = from.split("/").slice(0, -1);
  for (const part of to.replace(/#L\d+(?:-L\d+)?$/, "").split("/")) {
    if (part === "..") {
      if (!parts.length) return "../outside-workspace";
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function SourcePreview({
  text,
  kind,
}: {
  text: string;
  kind: WorkspaceTab["kind"];
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const width = useMemo(
    () => lines.reduce((max, line) => Math.max(max, line.length), 0) + 8,
    [lines],
  );
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 21,
    overscan: 10,
    useFlushSync: false,
  });
  return (
    <div className="file-scroll" ref={scroll}>
      <pre
        className={sourceClass(kind)}
        style={{
          height: virtual.getTotalSize(),
          width: `max(100%, ${width}ch)`,
          position: "relative",
          padding: 0,
        }}
      >
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.index}
            className={diffLineClass(kind, lines[row.index]!)}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: 21,
              width: "100%",
              transform: `translateY(${row.start}px)`,
            }}
          >
            <span className="line-number">{row.index + 1}</span>
            <span>{lines[row.index] || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
