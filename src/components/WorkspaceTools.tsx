import { FolderIcon } from "./NavigationIcons";
import { SearchIcon } from "./SearchIcon";
import { Details, DetailsSummary } from "./controls/details";
import { Input } from "./controls/input";
import { Button } from "./controls/button";
import { SessionReview } from "./SessionReview";
import { useEffect, useRef, useState } from "react";
import {
  FileIcon,
  CaretRightIcon,
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
  return (
    <section
      className="workspace-tools-panel relative flex min-h-0 flex-1 flex-col"
      aria-label="Workspace tools"
    >
      <div className="workspace-mode-bar hidden">
        {(
          [
            ["files", "Explorer", FolderIcon],
            ["changes", "Source Control", GitBranchIcon],
            ["search", "Search", SearchIcon],
          ] as const
        ).map(([value, label, Icon]) => (
          <Button
            key={value}
            isIconOnly
            className="icon-button size-8 p-0"
            aria-label={label}
            title={label}
            aria-pressed={mode === value}
            onClick={() => onMode(value)}
          >
            <Icon size={19} />
          </Button>
        ))}
        <span className="grow" />
        <Button
          isIconOnly
          className="icon-button size-8 p-0"
          aria-label="Close workspace"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div
        className="workspace-root flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-text-tertiary"
        title={root}
      >
        <FolderIcon />
        <span>{root.split("/").pop()}</span>
        <span className="grow" />
        {mode !== "changes" && <span>{status?.branch}</span>}
      </div>
      <div
        className="workspace-tool-body min-h-0 flex-1 overflow-auto p-3"
        data-mode={mode}
      >
        <div hidden={mode !== "files"}>
          <div className="section-heading mb-2 flex items-center gap-2 text-text-secondary">
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
          <div className="section-heading mb-2 flex items-center gap-2 text-text-secondary">
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
                  <Button
                    className="tree-row flex h-8 w-full items-center gap-2 rounded-md text-text-secondary hover:bg-hover [&_svg]:size-4"
                    key={n.id}
                    onClick={() => onNote(n)}
                  >
                    <NotebookIcon />
                    <span>{n.title || "Untitled note"}</span>
                    {n.alwaysInclude && <small>Always included</small>}
                  </Button>
                ))}
            </section>
          ))}
          {!data.notes.length && (
            <p className="panel-empty p-3 text-text-disabled">
              Create a note from the tab bar’s + menu.
            </p>
          )}
        </div>
      </div>
    </section>
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
      {error && (
        <p className="inline-error my-2 text-[13px] text-error">{error}</p>
      )}
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
            <Button
              className={`tree-row flex h-8 w-full items-center gap-2 rounded-md text-text-secondary hover:bg-hover [&_svg]:size-4 ${code ? "git-" + code : ""}`}
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
            </Button>
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
    <section className="project-search flex flex-col gap-3 [&_form]:flex [&_form]:flex-col [&_form]:gap-2">
      <div className="section-heading mb-2 flex items-center gap-2 text-text-secondary">
        <b>Search</b>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Input
          aria-label="Search project"
          placeholder="Search"
          value={query.text}
          onChange={(e) => change({ text: e.target.value })}
        />
        <div className="search-flags flex flex-wrap gap-2">
          {(
            [
              ["caseSensitive", "Match case", "Aa"],
              ["wholeWord", "Match whole word", "ab"],
              ["regex", "Use regular expression", ".*"],
            ] as const
          ).map(([flag, label, text]) => (
            <Button
              key={flag}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={query[flag]}
              onClick={() => change({ [flag]: !query[flag] })}
            >
              {text}
            </Button>
          ))}
          <Button
            type="button"
            aria-pressed={query.replacement !== null}
            onClick={() =>
              change({ replacement: query.replacement === null ? "" : null })
            }
          >
            Replace
          </Button>
        </div>
        {query.replacement !== null && (
          <Input
            aria-label="Replace with"
            placeholder="Replace"
            value={query.replacement}
            onChange={(e) => change({ replacement: e.target.value })}
          />
        )}
        <label>
          Files to include
          <Input
            aria-label="Files to include"
            placeholder="e.g. src/**, *.ts"
            value={query.include}
            onChange={(e) => change({ include: e.target.value })}
          />
        </label>
        <label>
          Files to exclude
          <Input
            aria-label="Files to exclude"
            placeholder="e.g. dist, *.test.ts"
            value={query.exclude}
            onChange={(e) => change({ exclude: e.target.value })}
          />
        </label>
        <Button type="submit" className="act" disabled={!query.text || busy}>
          {busy
            ? "Searching…"
            : query.replacement !== null
              ? "Preview replacement"
              : "Search"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="inline-error my-2 text-[13px] text-error">
          {error}
        </p>
      )}
      {results && (
        <>
          <p className="search-summary text-text-secondary">
            {results.hits.length} results in {results.files} files
            {results.truncated ? " · Limit reached; narrow your search" : ""}
          </p>
          {results.replacements.length > 0 && (
            <>
              <Button
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
              </Button>
              {results.replacements.map((c) => (
                <Details key={c.path} className="replace-preview">
                  <DetailsSummary>
                    {c.path} · {c.count} replacements
                  </DetailsSummary>
                  <b>Before</b>
                  <pre>{c.before}</pre>
                  <b>After</b>
                  <pre>{c.after}</pre>
                </Details>
              ))}
            </>
          )}
          {results.hits.map((hit, i) => (
            <Button
              key={`${hit.path}:${hit.line}:${hit.column}:${i}`}
              className="search-result flex w-full items-center gap-2 text-left text-text-secondary"
              onClick={() => onOpen(hit.path, hit.line)}
            >
              <span>
                {hit.path}:{hit.line}
              </span>
              <code>{hit.text}</code>
            </Button>
          ))}
        </>
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </section>
  );
}
