import { Input } from "./controls/input";
import { Button } from "./controls/button";
import { VscodePanels } from "./VscodePanels";
import { SourceControl } from "./SourceControl";
import { useEffect, useState } from "react";
import {
  Bolt,
  Branch,
  ChevronSmallRight,
  Code,
  File,
  Folder,
  Notebook,
  Search,
  Sun,
  type IconComponent,
} from "../icons";
import {
  workspaceApi,
  errorMessage,
  type FileEntry,
  type GitStatus,
  type WorkspaceContext,
} from "../workspaceApi";
import {
  type WorkbenchData,
  type Note,
} from "../workbenchApi";
import type { ModelInfo } from "../wire";
export type WorkspaceMode = "files" | "changes" | "search" | "notes";
export function WorkspaceTools({
  context,
  root,
  mode,
  status,
  refresh,
  revision,
  onOpen,
  onNote,
  selectedPath,
  data,
  onData,
  models,
  openPaths = [],
  visible = true,
}: {
  context: WorkspaceContext;
  root: string;
  mode: WorkspaceMode;
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
  /** Workspace-relative path, using the same format as onOpen. */
  selectedPath?: string | null;
  data: WorkbenchData;
  onData: (d: WorkbenchData) => void;
  models: ModelInfo[];
  reviewTurn?: string | null;
  openPaths?: string[];
  visible?: boolean;
}) {
  return (
    <section
      className="workspace-tools-panel relative flex min-h-0 flex-1 flex-col"
      aria-label="Workspace tools"
    >
      {mode === "notes" && (
        <div
          className="workspace-root flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-text-tertiary"
          title={root}
        >
          <Folder className="size-4" />
          <span>{root.split("/").pop()}</span>
          <span className="grow" />
          <span>{status?.branch}</span>
        </div>
      )}
      <div
        className={`workspace-tool-body min-h-0 flex-1 ${mode !== "notes" ? "overflow-hidden bg-canvas" : "overflow-auto p-3"}`}
        data-mode={mode}
      >
        <div hidden={mode !== "files"} className="h-full">
          <FilesTree
            key={JSON.stringify([context.projectId, context.sessionId, root])}
            context={context}
            revision={revision}
            status={status}
            selectedPath={selectedPath}
            onOpen={(p) => onOpen(p, "file")}
          />
        </div>
        {mode === "changes" && <SourceControl context={context} status={status} refresh={refresh} onOpen={onOpen}
          data={data} onData={onData} models={models} selectedPath={selectedPath}
        />}
        {mode === "search" && <VscodePanels
          active={visible} context={context} root={root} mode="search"
          status={status} revision={revision} refresh={refresh} onOpen={onOpen} openPaths={openPaths}
        />}
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
                    <Notebook />
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
// Browse only the root and explicitly opened directories. Filename search uses
// findFiles, supplemented by visited entries (which may include ignored files).
type DirectoryListing = {
  revision: number;
  entries: FileEntry[];
  error?: string;
};
type FileMatches = {
  paths: string[];
  truncated: boolean;
  error?: string;
};

function fileTreeFromPaths(paths: Set<string>): Map<string, FileEntry[]> {
  const directories = new Map<string, Map<string, FileEntry>>();
  for (const path of paths) {
    const parts = path.split("/");
    let parent = "";
    parts.forEach((name, index) => {
      const entryPath = parent ? `${parent}/${name}` : name;
      const entries = directories.get(parent) ?? new Map<string, FileEntry>();
      entries.set(entryPath, {
        name,
        path: entryPath,
        directory: index < parts.length - 1,
      });
      directories.set(parent, entries);
      parent = entryPath;
    });
  }
  return new Map(
    [...directories].map(([path, entries]) => [
      path,
      [...entries.values()].sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      ),
    ]),
  );
}

/**
 * Per-language file glyphs are gone: `@openai/apps-sdk-ui` has `File`, `FileCode`, `FileImage` and
 * a handful of media types, but nothing per-language and no `Brackets`. Every per-language glyph in
 * the table below therefore collapses to `File`, with the language carried by the colour alone —
 * the owner's decision, see the mapping table in `docs/research/apps-sdk-ui-icons.md`. Not every
 * row is a `File`: config-shaped extensions (`json`, `jsonc`, `yaml`, `yml`, `toml`) keep `Code`,
 * and `FileTypeIcon` below keeps three by-name special cases — `.gitignore` → `Branch`,
 * `claude.md` → `Sun`, `vite.config.ts` → `Bolt`. The colours below are unchanged.
 */
const fileTypes: { extensions: string[]; icon: IconComponent; color: string }[] = [
  { extensions: ["tsx"], icon: File, color: "#6cb6ff" },
  { extensions: ["ts"], icon: File, color: "#6cb6ff" },
  { extensions: ["jsx"], icon: File, color: "#e5c07b" },
  { extensions: ["js", "mjs", "cjs"], icon: File, color: "#e5c07b" },
  { extensions: ["css", "scss", "sass"], icon: File, color: "#c49bea" },
  { extensions: ["html"], icon: File, color: "#e99572" },
  {
    extensions: ["json", "jsonc", "yaml", "yml", "toml"],
    icon: Code,
    color: "#e99572",
  },
  { extensions: ["md", "mdx"], icon: File, color: "#81b9a0" },
  { extensions: ["rs"], icon: File, color: "#dfa180" },
  { extensions: ["py"], icon: File, color: "#81b9a0" },
  {
    extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"],
    icon: File,
    color: "#b49cdb",
  },
  {
    extensions: ["sh", "go", "rb", "c", "cpp", "h", "swift"],
    icon: File,
    color: "#81b9a0",
  },
  { extensions: ["txt"], icon: File, color: "#a1a1a1" },
];

function FileTypeIcon({ name }: { name: string }) {
  const filename = name.toLowerCase();
  const extension = filename.split(".").pop() ?? "";
  const type =
    filename === ".gitignore"
      ? { icon: Branch, color: "#e99572" }
      : filename === "claude.md"
        ? { icon: Sun, color: "#e99572" }
        : filename === "vite.config.ts"
          ? { icon: Bolt, color: "#b49cdb" }
          : fileTypes.find((type) => type.extensions.includes(extension));
  // Phosphor's `weight="fill"` marked the unknown-extension fallback; the set has no filled/outline
  // pair for `File`, so the single glyph carries both states and only the grey colour separates them.
  const { icon: TypeIcon, color } = type ?? {
    icon: File,
    color: "#7f7f7f",
  };
  return <TypeIcon aria-hidden="true" className="shrink-0" style={{ color }} />;
}

function FilesTree({
  context,
  revision,
  status,
  selectedPath,
  onOpen,
}: {
  context: WorkspaceContext;
  revision: number;
  status: GitStatus | null;
  selectedPath?: string | null;
  onOpen: (path: string) => void;
}) {
  const [listings, setListings] = useState<Record<string, DirectoryListing>>(
    {},
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(
    new Set(),
  );
  const [matches, setMatches] = useState<FileMatches | null>(null);
  const query = filter.trim().toLowerCase();
  useEffect(() => {
    if (!query) return;
    let live = true;
    // Query edits clear matches in the input handler; revision refreshes keep
    // the current results mounted until their replacement arrives.
    const timer = window.setTimeout(() => {
      void workspaceApi.findFiles(context, query).then(
        (result) => {
          if (live) setMatches(result);
        },
        (error) => {
          if (live)
            setMatches({
              paths: [],
              truncated: false,
              error: errorMessage(error),
            });
        },
      );
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [context.projectId, context.sessionId, filter, query, revision]);
  useEffect(() => {
    const paths = [
      ...new Set(["", ...Object.keys(listings), ...expanded]),
    ].filter((path) => listings[path]?.revision !== revision);
    if (!paths.length) return;
    let live = true;
    void Promise.all(
      paths.map(async (path) => {
        try {
          return [
            path,
            { revision, entries: await workspaceApi.entries(context, path) },
          ] as const;
        } catch (error) {
          return [
            path,
            { revision, entries: [], error: errorMessage(error) },
          ] as const;
        }
      }),
    ).then((loaded) => {
      if (live)
        setListings((old) => ({ ...old, ...Object.fromEntries(loaded) }));
    });
    return () => {
      live = false;
    };
  }, [context.projectId, context.sessionId, revision, expanded, listings]);

  // Keep existing rows mounted during refresh, including the focused button.
  const entriesAt = (path: string) => listings[path]?.entries ?? [];
  const searchReady = matches !== null;
  const matchingPaths = new Set<string>(searchReady ? matches.paths : []);
  if (query && searchReady) {
    const visit = (path: string) => {
      for (const entry of entriesAt(path)) {
        if (entry.directory) {
          visit(entry.path);
          continue;
        }
        if (!entry.path.toLowerCase().includes(query)) continue;
        matchingPaths.add(entry.path);
      }
    };
    visit("");
  }
  const filteredTree = query ? fileTreeFromPaths(matchingPaths) : null;
  const toggle = (path: string) => {
    const update = query ? setFilterCollapsed : setExpanded;
    update((old) => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const directory = (path: string, depth: number) => {
    const listing = listings[path];
    if (!query && !listing) {
      return (
        <p className="px-3 py-2 text-xs text-text-tertiary" role="status">
          Loading files…
        </p>
      );
    }
    if (!query && listing.error) {
      return (
        <p
          role="alert"
          className="inline-error px-3 py-2 text-[13px] text-error"
        >
          {path && `${path}: `}
          {listing.error}
        </p>
      );
    }
    return (
      filteredTree ? (filteredTree.get(path) ?? []) : entriesAt(path)
    ).map((entry) => {
      const changes =
        status?.changes.filter(
          (change) =>
            change.path === entry.path ||
            (entry.directory && change.path.startsWith(entry.path + "/")),
        ) ?? [];
      const code = changes.some(
        (change) => change.index === "?" || change.index === "A",
      )
        ? "U"
        : changes.some(
              (change) => change.worktree === "D" || change.index === "D",
            )
          ? "D"
          : changes.length
            ? "M"
            : "";
      const open = query
        ? !filterCollapsed.has(entry.path)
        : expanded.has(entry.path);
      const selected = !entry.directory && selectedPath === entry.path;
      return (
        <div key={entry.path}>
          <Button
            className={`tree-row flex h-7 w-full justify-start gap-1.5 rounded-[8px] border-0 pr-3 text-left text-[13px] shadow-none hover:bg-hover [&_svg]:size-4 ${selected ? "bg-selected text-text" : "bg-transparent text-text-secondary"}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            aria-label={entry.name}
            aria-expanded={entry.directory ? open : undefined}
            aria-current={selected ? "page" : undefined}
            title={
              changes.length
                ? `${entry.path} · ${changes.length} changed file(s)`
                : entry.path
            }
            onClick={() =>
              entry.directory ? toggle(entry.path) : onOpen(entry.path)
            }
          >
            {entry.directory ? (
              <ChevronSmallRight
                aria-hidden="true"
                className={`shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
              />
            ) : (
              <FileTypeIcon name={entry.name} />
            )}
            <span className="min-w-0 truncate">{entry.name}</span>
            {code && (
              <b
                aria-label={
                  code === "U"
                    ? "Added or untracked"
                    : code === "D"
                      ? "Deleted"
                      : "Modified"
                }
                className={`git-decoration ml-auto text-[11px] font-normal ${code === "U" ? "text-ok" : code === "D" ? "text-error" : "text-warn"}`}
              >
                {entry.directory ? "●" : code}
              </b>
            )}
          </Button>
          {entry.directory && open && directory(entry.path, depth + 1)}
        </div>
      );
    });
  };
  return (
    <section aria-label="Files" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 p-2">
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-tertiary"
          >
            <Search width={14} height={14} />
          </span>
          <Input
            aria-label="Filter files"
            placeholder="Filter files…"
            className="h-8 w-full rounded-[12px] border border-hairline bg-input-shell pl-8 text-[13px]"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setMatches(null);
              setFilterCollapsed(new Set());
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setFilter("");
                setMatches(null);
              }
            }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {query ? (
          !searchReady ? (
            <p role="status" className="px-3 py-2 text-xs text-text-tertiary">
              Searching files…
            </p>
          ) : (
            <>
              {matches.error && (
                <p role="alert" className="px-3 py-2 text-[13px] text-error">
                  {matches.error}
                </p>
              )}
              {directory("", 0)}
              {!matchingPaths.size && !matches.error && (
                <p
                  role="status"
                  className="px-3 py-2 text-xs text-text-tertiary"
                >
                  No matching files
                </p>
              )}
              {matches.truncated && (
                <p
                  role="status"
                  className="px-3 py-2 text-xs text-text-tertiary"
                >
                  Result limit reached. Refine your filter.
                </p>
              )}
            </>
          )
        ) : (
          <>
            {directory("", 0)}
            {listings[""]?.revision === revision &&
              !listings[""].error &&
              !entriesAt("").length && (
                <p
                  role="status"
                  className="px-3 py-2 text-xs text-text-tertiary"
                >
                  This folder is empty.
                </p>
              )}
          </>
        )}
      </div>
    </section>
  );
}
