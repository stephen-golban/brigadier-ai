import {
  CaretRightIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  MinusIcon,
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
} from "@phosphor-icons/react";
import { Button } from "./controls/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./controls/collapsible";
import type { GitStatus } from "../workspaceApi";

type Change = GitStatus["changes"][number];
type Props = {
  changes: Change[];
  staged: boolean;
  tree: boolean;
  busy: boolean;
  selectedPath?: string | null;
  onOpen(path: string, kind: "file" | "diff", staged?: boolean): void;
  onStage(path: string): void;
  onDiscard(path: string): void;
};
const statusNames: Record<string, string> = {
  M: "Modified",
  A: "Added",
  U: "Untracked",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
};

export function ChangesFileList(props: Props) {
  function row(change: Change, depth: number) {
    const code =
      change.index === "?"
        ? "U"
        : props.staged
          ? change.index
          : change.worktree;
    const directory = change.path.slice(
      0,
      Math.max(0, change.path.lastIndexOf("/")),
    );
    return (
      <div
        key={change.path}
        role="listitem"
        className={`group/scm relative flex h-8 min-w-0 items-center gap-1 rounded-md hover:bg-hover focus-within:bg-hover ${props.selectedPath === change.path ? "bg-selected" : ""}`}
        style={{ paddingLeft: depth * 12 }}
      >
        <Button
          variant="ghost"
          className="h-8 min-w-0 flex-1 justify-start gap-2 px-2"
          title={change.path}
          aria-label={`Open changes in ${change.path}`}
          data-scm-file
          onClick={() => props.onOpen(change.path, "diff", props.staged)}
        >
          <FileIcon className="size-4 shrink-0 text-text-tertiary" />
          <span
            className={`truncate text-[13px] ${code === "D" ? "line-through text-text-tertiary" : "text-text-secondary"}`}
          >
            {change.path.split("/").pop()}
          </span>
          {!props.tree && directory && (
            <span className="min-w-0 truncate text-xs text-text-tertiary">
              {directory}
            </span>
          )}
        </Button>
        <div className="absolute right-6 flex items-center rounded-md bg-canvas opacity-0 pointer-events-none group-hover/scm:pointer-events-auto group-hover/scm:opacity-100 group-focus-within/scm:pointer-events-auto group-focus-within/scm:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title="Open file"
            aria-label={`Open file ${change.path}`}
            onClick={() => props.onOpen(change.path, "file")}
          >
            <ArrowSquareOutIcon className="size-3.5" />
          </Button>
          {!props.staged && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={props.busy}
              title="Discard changes"
              aria-label={`Discard ${change.path}`}
              onClick={() => props.onDiscard(change.path)}
            >
              <ArrowCounterClockwiseIcon className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={props.busy}
            title={props.staged ? "Unstage" : "Stage"}
            aria-label={`${props.staged ? "Unstage" : "Stage"} ${change.path}`}
            onClick={() => props.onStage(change.path)}
          >
            {props.staged ? (
              <MinusIcon className="size-3.5" />
            ) : (
              <PlusIcon className="size-3.5" />
            )}
          </Button>
        </div>
        <span
          className={`w-5 shrink-0 text-center text-xs ${code === "U" || code === "A" ? "text-ok" : code === "D" ? "text-error" : "text-attention"}`}
          title={statusNames[code] ?? "Conflict"}
        >
          {code}
        </span>
      </div>
    );
  }
  function folder(entries: Change[], prefix = "", depth = 0): React.ReactNode {
    const dirs = new Map<string, Change[]>(),
      leaves: Change[] = [];
    for (const change of entries) {
      const remainder = change.path.slice(prefix.length),
        slash = remainder.indexOf("/");
      if (slash < 0) leaves.push(change);
      else {
        const name = remainder.slice(0, slash);
        const group = dirs.get(name) ?? [];
        group.push(change);
        dirs.set(name, group);
      }
    }
    return (
      <>
        {[...dirs]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, files]) => (
            <Collapsible defaultOpen key={prefix + name}>
              <CollapsibleTrigger
                className="group/folder flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-text-secondary hover:bg-hover"
                style={{ paddingLeft: 8 + depth * 12 }}
                aria-label={`Folder ${prefix}${name}`}
              >
                <CaretRightIcon className="size-3 shrink-0 group-aria-expanded/folder:rotate-90" />
                <FolderIcon className="size-4 shrink-0" />
                <span className="truncate">{name}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                {folder(files, `${prefix}${name}/`, depth + 1)}
              </CollapsibleContent>
            </Collapsible>
          ))}
        {leaves.map((change) => row(change, depth))}
      </>
    );
  }
  return (
    <div
      role="list"
      aria-label={props.staged ? "Staged Changes files" : "Changes files"}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        const rows = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "[data-scm-file]",
          ),
        ];
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
        rows[next]?.focus();
      }}
    >
      {props.tree
        ? folder(props.changes)
        : props.changes.map((change) => row(change, 0))}
    </div>
  );
}
