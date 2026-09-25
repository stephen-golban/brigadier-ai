import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  Search,
} from "@openai/apps-sdk-ui/components/Icon";
import {
  type FC,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useCheckoutFiles } from "@/app/conversation/Mentions";
import { SidePanelContext } from "@/app/conversation/SidePanel";
import { FileTypeIcon } from "@/components/assistant-ui/elements/file-type-icon";
import { fuzzyMatch } from "@/components/assistant-ui/elements/fuzzy-match";
import { useCheckoutRoot } from "@/components/assistant-ui/markdown-text";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { request, revealPath } from "@/ipc/client";
import type { CheckoutFile } from "@/ipc/generated";
import { formatBytes } from "@/lib/format";
import { HIGHLIGHT_CHARS, highlight, languageOf, type Token } from "@/lib/highlight";
import { tokenPx } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/store";
import { toast } from "@/state/toasts";

/**
 * ChatGPT's Files tab (⌘P): the session checkout's files as a tree with a search field, and
 * one file shown with its line numbers and colours, opened from the tree, a search result or
 * a file link in an answer.
 */

/** A file the tab shows, and the line to bring into view. */
export type FileTarget = { path: string; line: number | null };

/** Search results listed at once; typing more narrows them. */
const RESULTS = 100;

/** The folders open in each session's tree, kept while the app runs. */
const openFolders = new Map<string, Set<string>>();

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

type Row =
  | { kind: "folder"; path: string; name: string; depth: number; open: boolean }
  | { kind: "file"; path: string; name: string; depth: number };

type Folder = { folders: Map<string, Folder>; files: string[] };

function buildTree(files: readonly string[]): Folder {
  const root: Folder = { folders: new Map(), files: [] };
  for (const path of files) {
    const parts = path.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [] };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.files.push(path);
  }
  return root;
}

/** The tree's visible rows: folders first, then files, each by name; open folders expanded. */
function visibleRows(root: Folder, open: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (folder: Folder, prefix: string, depth: number) => {
    const names = [...folder.folders.keys()].toSorted((a, b) => a.localeCompare(b));
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name;
      const isOpen = open.has(path);
      rows.push({ kind: "folder", path, name, depth, open: isOpen });
      const child = folder.folders.get(name);
      if (isOpen && child) walk(child, path, depth + 1);
    }
    const files = folder.files.toSorted((a, b) => baseName(a).localeCompare(baseName(b)));
    for (const path of files) rows.push({ kind: "file", path, name: baseName(path), depth });
  };
  walk(root, "", 0);
  return rows;
}

/** The side panel's Files tab: the tree, or one file. */
export function FilesTab({ conversationId }: { conversationId: string }) {
  const { file, openFile } = useContext(SidePanelContext);
  if (file) {
    return <FileView key={`${file.path}:${file.line}`} conversationId={conversationId} target={file} />;
  }
  return (
    <FileBrowser
      conversationId={conversationId}
      onOpen={(path) => openFile({ path, line: null })}
    />
  );
}

function FileBrowser({
  conversationId,
  onOpen,
}: {
  conversationId: string;
  onOpen: (path: string) => void;
}) {
  const conversation = useApp((s) => s.conversations[conversationId]);
  const list = useCheckoutFiles(conversation ?? null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => openFolders.get(conversationId) ?? new Set(),
  );
  const [active, setActive] = useState(0);
  const tree = useMemo(() => buildTree(list?.files ?? []), [list]);
  const rows = useMemo(() => visibleRows(tree, open), [tree, open]);
  const results = useMemo(() => {
    const want = query.trim();
    if (!want || !list) return null;
    return list.files
      .flatMap((path) => {
        // The name counts first; a match only in its folders comes after.
        const byName = fuzzyMatch(baseName(path), want);
        const byPath = byName ? null : fuzzyMatch(path, want);
        const match = byName ?? byPath;
        return match ? [{ path, rank: match.rank + (byName ? 0 : 3) }] : [];
      })
      .toSorted((a, b) => a.rank - b.rank || a.path.length - b.path.length)
      .slice(0, RESULTS)
      .map((result) => result.path);
  }, [list, query]);

  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    openFolders.set(conversationId, next);
    setOpen(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border shrink-0 border-b p-2">
        <label className="border-border rounded-control flex h-control-md items-center gap-1.5 border px-2">
          <Search className="text-muted-foreground size-icon-sm shrink-0" />
          <input
            // ⌘P opens the tab to type in it at once.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={query}
            placeholder="Search files"
            aria-label="Search files"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (!results) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((index) => Math.min(results.length - 1, Math.max(0, index + step)));
              } else if (event.key === "Enter") {
                const path = results[active];
                if (path) onOpen(path);
              }
            }}
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!list ? null : list.files.length === 0 ? (
          <p className="text-muted-foreground p-2 text-sm">No files</p>
        ) : results ? (
          results.length === 0 ? (
            <p className="text-muted-foreground p-2 text-sm">No matching files</p>
          ) : (
            <ul aria-label="Matching files">
              {results.map((path, index) => (
                <li key={path}>
                  <button
                    type="button"
                    title={path}
                    data-active={index === active || undefined}
                    onClick={() => onOpen(path)}
                    onPointerMove={() => setActive(index)}
                    className="data-active:bg-muted rounded-control flex h-control-md w-full items-center gap-2 px-2 text-start text-sm"
                  >
                    <FileTypeIcon name={path} className="size-icon-sm shrink-0" />
                    <span className="shrink-0">{baseName(path)}</span>
                    <span className="text-muted-foreground min-w-0 truncate">{dirName(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <ul aria-label="Files" role="tree">
            {rows.map((row) => (
              <TreeRow
                key={`${row.kind}:${row.path}`}
                row={row}
                onToggle={toggle}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
        {list?.truncated && !results && (
          <p className="text-muted-foreground p-2 text-xs">
            Only the first {list.files.length.toLocaleString()} files are listed. Search to find
            the others.
          </p>
        )}
      </div>
    </div>
  );
}

const TreeRow = memo(function TreeRow({
  row,
  onToggle,
  onOpen,
}: {
  row: Row;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const folder = row.kind === "folder";
  return (
    <li role="treeitem" aria-expanded={folder ? row.open : undefined} aria-selected={false}>
      <button
        type="button"
        title={row.path}
        onClick={() => (folder ? onToggle(row.path) : onOpen(row.path))}
        // Each level indents by one step of the spacing scale.
        style={{ paddingInlineStart: `calc(var(--spacing) * ${2 + row.depth * 4})` }}
        className="hover:bg-muted text-muted-foreground hover:text-foreground rounded-control flex h-control-sm w-full items-center gap-1.5 pe-2 text-start text-sm"
      >
        {folder ? (
          <>
            {row.open ? (
              <ChevronDown className="size-icon-xs shrink-0" />
            ) : (
              <ChevronRight className="size-icon-xs shrink-0" />
            )}
            {row.open ? (
              <FolderOpen className="size-icon-sm shrink-0" />
            ) : (
              <Folder className="size-icon-sm shrink-0" />
            )}
          </>
        ) : (
          <FileTypeIcon name={row.path} className="ms-4 size-icon-sm shrink-0" />
        )}
        <span className="min-w-0 truncate">{row.name}</span>
      </button>
    </li>
  );
});

function useFile(conversationId: string, path: string) {
  const [state, setState] = useState<{ file: CheckoutFile | null; error: string | null }>({
    file: null,
    error: null,
  });
  useEffect(() => {
    let live = true;
    request({ method: "readFile", conversationId, path })
      .then(({ file }) => live && setState({ file, error: null }))
      .catch(
        (cause: unknown) =>
          live &&
          setState({
            file: null,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
      );
    return () => {
      live = false;
    };
  }, [conversationId, path]);
  return state;
}

/** One file: its path over its lines, numbered and coloured, the target line marked. */
function FileView({ conversationId, target }: { conversationId: string; target: FileTarget }) {
  const { openFile } = useContext(SidePanelContext);
  const root = useCheckoutRoot();
  const { file, error } = useFile(conversationId, target.path);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const mac = useApp((s) => s.info?.platform === "macos");
  const absolute = root ? `${root.replace(/\/$/, "")}/${target.path}` : target.path;
  return (
    <>
      <header className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <TooltipIconButton tooltip="Back to files" size="icon-sm" onClick={() => openFile(null)}>
          <ArrowLeft />
        </TooltipIconButton>
        <FileTypeIcon name={target.path} className="size-icon-md shrink-0" />
        <h2 className="min-w-0 flex-1 truncate text-sm" title={absolute}>
          <span className="font-medium">{baseName(target.path)}</span>
          {dirName(target.path) && (
            <span className="text-muted-foreground"> {dirName(target.path)}</span>
          )}
        </h2>
        {file && <span className="text-muted-foreground shrink-0 text-xs">{formatBytes(file.size)}</span>}
        <TooltipIconButton
          tooltip={isCopied ? "Copied" : "Copy path"}
          size="icon-sm"
          onClick={() => copyToClipboard(target.path)}
        >
          {isCopied ? <Check /> : <Copy />}
        </TooltipIconButton>
        <TooltipIconButton
          tooltip={mac ? "Reveal in Finder" : "Open in File Manager"}
          size="icon-sm"
          onClick={() =>
            revealPath(absolute).catch((cause: unknown) =>
              toast(cause instanceof Error ? cause.message : String(cause), { tone: "error" }),
            )
          }
        >
          <FolderOpen />
        </TooltipIconButton>
      </header>
      {error ? (
        <p role="alert" className="text-destructive p-4 text-sm">
          {error}
        </p>
      ) : !file ? null : file.text === null ? (
        <p className="text-muted-foreground p-4 text-sm">Binary file not shown</p>
      ) : (
        <>
          {file.truncated && (
            <p className="text-muted-foreground border-border shrink-0 border-b px-4 py-1.5 text-xs">
              Showing the first {formatBytes(file.text.length)} of {formatBytes(file.size)}
            </p>
          )}
          <CodeLines text={file.text} language={languageOf(target.path)} line={target.line} />
        </>
      )}
    </>
  );
}

const CodeLines: FC<{ text: string; language: string; line: number | null }> = ({
  text,
  language,
  line,
}) => {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  const density = useApp((s) => s.settings.density);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (text.length > HIGHLIGHT_CHARS) return;
    let live = true;
    highlight(text.replace(/\n$/, ""), language)
      .then((result) => live && setTokens(result))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [text, language]);

  // The app does not use React Compiler, so the virtualizer's unmemoizable API is fine here.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    // A line is `leading-5`: five steps of the spacing scale.
    estimateSize: () => tokenPx("--spacing") * 5,
    overscan: 20,
  });
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [density, virtualizer]);
  useLayoutEffect(() => {
    if (line !== null && line > 0) virtualizer.scrollToIndex(line - 1, { align: "center" });
  }, [line, virtualizer]);

  const gutter = `${String(lines.length).length}ch`;
  return (
    <div ref={scrollRef} data-selectable className="min-h-0 flex-1 overflow-auto py-2">
      <div
        className="relative min-w-full font-mono text-xs"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const number = item.index + 1;
          const lineTokens = tokens?.[item.index];
          return (
            <div
              key={item.key}
              data-line={number}
              data-target={number === line || undefined}
              className="data-target:bg-warning/15 absolute start-0 flex h-5 w-max min-w-full items-center leading-5 whitespace-pre"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <span
                className="text-muted-foreground shrink-0 ps-4 pe-4 text-end select-none"
                style={{ width: `calc(${gutter} + var(--spacing) * 8)` }}
              >
                {number}
              </span>
              <span className="pe-4">
                {lineTokens
                  ? lineTokens.map((token, index) => (
                      <span
                        // Tokens of a line never reorder.
                        // oxlint-disable-next-line react/no-array-index-key
                        key={index}
                        className={cn(token.italic && "italic")}
                        style={token.color ? { color: token.color } : undefined}
                      >
                        {token.content}
                      </span>
                    ))
                  : lines[item.index]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
