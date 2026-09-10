import { useEffect, useId, useRef, useState } from "react";
import { ArrowRotateCw, Branch, CaretDown, CaretRight, Check, DotsHorizontal, Minus, Plus, SettingsCog, Sparkle } from "../icons";
import { Button } from "./controls/button";
import { ButtonGroup } from "./controls/button-group";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./controls/input-group";
import { Input } from "./controls/input";
import { Dropdown, Separator } from "./controls/overlay";
import { DropdownContent } from "./controls/menu";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./controls/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./controls/dialog";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import { CommitPreferences } from "./CommitPreferences";
import { ChangesFileList } from "./ChangesFileList";
import {
  errorMessage,
  type GitStatus,
  type WorkspaceContext,
} from "../workspaceApi";
import {
  workbenchApi,
  type GitAction,
  type WorkbenchData,
  type GitDetails,
} from "../workbenchApi";
import type { ModelInfo } from "../wire";
export { CommitPreferences } from "./CommitPreferences";

export interface SourceControlProps {
  context: WorkspaceContext;
  status: GitStatus | null;
  refresh(): void;
  onOpen(path: string, kind: "file" | "diff", staged?: boolean): void;
  data: WorkbenchData;
  onData(data: WorkbenchData): void;
  models: ModelInfo[];
  selectedPath?: string | null;
}
// The keyed wrapper isolates pending actions, dialogs and drafts when switching sessions.
export function SourceControl(props: SourceControlProps) {
  return <RepositoryChanges key={JSON.stringify(props.context)} {...props} />;
}
function RepositoryChanges({
  context,
  status,
  refresh,
  onOpen,
  data,
  onData,
  models,
  selectedPath,
}: SourceControlProps) {
  const key = `commit:${context.projectId}:${context.sessionId ?? ""}`;
  const [message, setMessageState] = useState(
    () => localStorage.getItem(key) ?? "",
  );
  const [busy, setBusy] = useState(false),
    lock = useRef(false),
    live = useRef(true);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [menu, setMenu] = useState(false),
    [prefs, setPrefs] = useState(false);
  const [details, setDetails] = useState<GitDetails | null>(null);
  const [branchPicker, setBranchPicker] = useState(false),
    [branchFilter, setBranchFilter] = useState("");
  const [tree, setTree] = useState(
    () => localStorage.getItem("changes.view") === "tree",
  );
  const [sort, setSort] = useState<"path" | "name">(() =>
    localStorage.getItem("changes.sort") === "name" ? "name" : "path",
  );
  const messageId = useId();
  const settings = data.projects[context.projectId] ?? data.global;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const setMessage = (value: string) => {
    localStorage.setItem(key, value);
    if (live.current) setMessageState(value);
  };
  const reloadDetails = async () => {
    try {
      const next = await workbenchApi.gitDetails(context);
      if (live.current) setDetails(next);
    } catch (e) {
      if (live.current) setError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (menu || branchPicker) void reloadDetails();
  }, [menu, branchPicker]);
  const run = async (requests: GitAction[]) => {
    if (lock.current || !live.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      for (const request of requests) {
        await workbenchApi.gitAction(context, request);
        if (request.action.startsWith("commit") || request.action === "amend")
          setMessage("");
        if (live.current) refresh();
      }
      if (live.current && (menu || details)) void reloadDetails();
    } catch (e) {
      if (live.current) {
        setError(errorMessage(e));
        refresh();
      }
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const ask = (
    title: string,
    body: string,
    requests: GitAction[],
    confirmLabel = title,
  ) =>
    setConfirm({
      title,
      body,
      confirmLabel,
      onCancel: () => setConfirm(null),
      onConfirm: async () => {
        setConfirm(null);
        await run(requests);
      },
    });
  const staged =
    status?.changes.filter(
      (change) => change.index !== " " && change.index !== "?",
    ) ?? [];
  const commit = (mode: "commit" | "amend" | "commit_push" = "commit") => {
    if (busy) return;
    if (!message.trim()) {
      setError("Enter a commit message.");
      return;
    }
    let text = message.trim();
    if (settings.coAuthor && !/^Co-authored-by:/im.test(text))
      text += "\n\nCo-authored-by: Claude <noreply@anthropic.com>";
    const action =
      mode === "amend" ? "amend" : staged.length ? "commit" : "commit_all";
    const requests: GitAction[] = [
      { action, message: text },
      ...(mode === "commit_push" ? [{ action: "push" }] : []),
    ];
    if (mode === "amend") {
      ask(
        "Amend last commit",
        "Replace the last commit with this message and the staged changes?",
        requests,
        "Amend",
      );
      return;
    }
    if (!staged.length && !settings.smartCommit) {
      if (!settings.suggestSmartCommit) {
        setError("Stage changes before committing.");
        return;
      }
      ask(
        "No staged changes",
        "Stage all changes and commit them?",
        requests,
        "Stage All and Commit",
      );
      return;
    }
    void run(requests);
  };
  const generate = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await workbenchApi.generate(context, settings.model);
      setMessage(result.message);
    } catch (e) {
      if (live.current) setError(errorMessage(e));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const groups = [
    { name: "Staged Changes", staged: true, changes: staged },
    {
      name: "Changes",
      staged: false,
      changes:
        status?.changes.filter((change) =>
          change.index === "?"
            ? settings.untracked === "mixed"
            : change.worktree !== " ",
        ) ?? [],
    },
    ...(settings.untracked === "separate"
      ? [
          {
            name: "Untracked Changes",
            staged: false,
            changes:
              status?.changes.filter((change) => change.index === "?") ?? [],
          },
        ]
      : []),
  ];
  const setView = (value: boolean) => {
    setTree(value);
    localStorage.setItem("changes.view", value ? "tree" : "list");
  };
  const chooseSort = (value: "path" | "name") => {
    setSort(value);
    localStorage.setItem("changes.sort", value);
  };
  const mutation = (action: string, title: string) => (
    <Dropdown.Item
      key={action}
      isDisabled={busy || status === null}
      onAction={() => void run([{ action }])}
    >
      {title}
    </Dropdown.Item>
  );
  return (
    <section
      className="source-control flex h-full min-h-0 flex-col bg-canvas text-text"
      aria-label="Source Control"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 px-3">
        <h2 className="flex-1 text-[13px] font-medium">Changes</h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-text-tertiary"
          title="Refresh"
          aria-label="Refresh changes"
          disabled={busy}
          onClick={refresh}
        >
          <ArrowRotateCw className="size-4" />
        </Button>
        <Dropdown isOpen={menu} onOpenChange={setMenu}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-text-tertiary"
            title="Git actions"
            aria-label="Git actions"
          >
            <DotsHorizontal className="size-4" />
          </Button>
          <DropdownContent align="end">
            <Dropdown.Item onAction={() => setView(!tree)}>
              {tree ? "View as List" : "View as Tree"}
            </Dropdown.Item>
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item>Sort Changes</Dropdown.Item>
              <DropdownContent side="left">
                <Dropdown.Item onAction={() => chooseSort("name")}>
                  By Name {sort === "name" ? <Check className="ml-auto size-3.5" aria-hidden /> : null}
                </Dropdown.Item>
                <Dropdown.Item onAction={() => chooseSort("path")}>
                  By Path {sort === "path" ? <Check className="ml-auto size-3.5" aria-hidden /> : null}
                </Dropdown.Item>
              </DropdownContent>
            </Dropdown.SubmenuTrigger>
            <Separator />
            {mutation("pull", "Pull")}
            {mutation("push", "Push")}
            {mutation("fetch", "Fetch")}
            <Separator />
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item>Commit</Dropdown.Item>
              <DropdownContent side="left">
                <Dropdown.Item
                  isDisabled={
                    busy || !message.trim() || !status?.changes.length
                  }
                  onAction={() => commit()}
                >
                  Commit
                </Dropdown.Item>
                <Dropdown.Item
                  isDisabled={busy || !message.trim()}
                  onAction={() => commit("amend")}
                >
                  Commit (Amend)
                </Dropdown.Item>
                <Dropdown.Item
                  isDisabled={
                    busy || !message.trim() || !status?.changes.length
                  }
                  onAction={() => commit("commit_push")}
                >
                  Commit &amp; Push
                </Dropdown.Item>
              </DropdownContent>
            </Dropdown.SubmenuTrigger>
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item>Changes</Dropdown.Item>
              <DropdownContent side="left">
                <Dropdown.Item
                  isDisabled={
                    busy ||
                    !groups.slice(1).some((group) => group.changes.length)
                  }
                  onAction={() => void run([{ action: "stage" }])}
                >
                  Stage All Changes
                </Dropdown.Item>
                <Dropdown.Item
                  isDisabled={busy || !staged.length}
                  onAction={() => void run([{ action: "unstage" }])}
                >
                  Unstage All Changes
                </Dropdown.Item>
                <Dropdown.Item
                  isDisabled={
                    busy ||
                    !groups.slice(1).some((group) => group.changes.length)
                  }
                  variant="danger"
                  onAction={() =>
                    ask(
                      "Discard all changes",
                      "Discard all unstaged changes? Recoverable copies will be moved to Trash.",
                      groups.slice(1).flatMap((group) =>
                        group.changes.map((change) => ({
                          action: "discard",
                          path: change.path,
                        })),
                      ),
                    )
                  }
                >
                  Discard All Changes
                </Dropdown.Item>
              </DropdownContent>
            </Dropdown.SubmenuTrigger>
            <Dropdown.Item
              isDisabled={busy}
              onAction={() => setBranchPicker(true)}
            >
              Checkout Branch…
            </Dropdown.Item>
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item>Stash</Dropdown.Item>
              <DropdownContent side="left">
                <Dropdown.Item
                  isDisabled={busy || !status?.changes.length}
                  onAction={() => void run([{ action: "stash" }])}
                >
                  Stash Changes
                </Dropdown.Item>
                <Dropdown.Item
                  isDisabled={busy || !status?.changes.length}
                  onAction={() => void run([{ action: "stash_untracked" }])}
                >
                  Stash (Include Untracked)
                </Dropdown.Item>
                <Separator />
                <Dropdown.Item
                  isDisabled={busy || !details?.stashes.length}
                  onAction={() => void run([{ action: "stash_apply_latest" }])}
                >
                  Apply Latest Stash
                </Dropdown.Item>
                <Dropdown.Item
                  isDisabled={busy || !details?.stashes.length}
                  onAction={() => void run([{ action: "stash_pop_latest" }])}
                >
                  Pop Latest Stash
                </Dropdown.Item>
                {details?.stashes.map((stash) => (
                  <Dropdown.SubmenuTrigger key={stash}>
                    <Dropdown.Item textValue={stash}>{stash}</Dropdown.Item>
                    <DropdownContent side="left">
                      <Dropdown.Item
                        isDisabled={busy}
                        onAction={() =>
                          void run([
                            {
                              action: "stash_apply",
                              reference: stash.split(":")[0],
                            },
                          ])
                        }
                      >
                        Apply Stash
                      </Dropdown.Item>
                      <Dropdown.Item
                        isDisabled={busy}
                        onAction={() =>
                          void run([
                            {
                              action: "stash_pop",
                              reference: stash.split(":")[0],
                            },
                          ])
                        }
                      >
                        Pop Stash
                      </Dropdown.Item>
                    </DropdownContent>
                  </Dropdown.SubmenuTrigger>
                ))}
              </DropdownContent>
            </Dropdown.SubmenuTrigger>
            <Separator />
            <Dropdown.Item onAction={() => setPrefs(true)}>
              <SettingsCog />
              Commit settings
            </Dropdown.Item>
          </DropdownContent>
        </Dropdown>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        <div className="mb-2 flex min-h-7 items-center gap-2 px-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 min-w-0 justify-start gap-1.5 px-1 text-xs text-text-tertiary"
            disabled={busy || status === null}
            onClick={() => setBranchPicker(true)}
            title="Checkout branch"
            aria-label="Checkout branch"
          >
            <Branch className="size-3.5" />
            <span className="truncate">{status?.branch ?? "Repository"}</span>
            <CaretDown className="size-3" />
          </Button>
          {!!((status?.ahead ?? 0) + (status?.behind ?? 0)) && (
            <span
              className="ml-auto shrink-0 text-xs text-text-tertiary"
              title={`${status?.ahead ?? 0} outgoing, ${status?.behind ?? 0} incoming commits`}
            >
              {status?.ahead ?? 0}↑ {status?.behind ?? 0}↓
            </span>
          )}
        </div>
        <div className="shrink-0 px-1 pb-3" data-testid="commit-composer">
          <InputGroup className="rounded-lg border border-hairline bg-input-shell">
            <InputGroupTextarea
              id={messageId}
              aria-label="Commit message"
              placeholder="Message (⌘Enter to commit)"
              rows={2}
              className="min-h-14 w-full resize-none border-0 bg-transparent text-[13px]"
              value={message}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  message.trim() &&
                  status?.changes.length
                ) {
                  event.preventDefault();
                  commit();
                }
              }}
            />
            <InputGroupAddon className="justify-between px-2 pb-1.5 pt-0">
              <span className="text-[11px] text-text-tertiary">
                {staged.length ? `${staged.length} staged` : ""}
              </span>
              <InputGroupButton
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-1.5 text-xs text-text-secondary"
                aria-label="Generate commit message"
                title={
                  staged.length
                    ? "Generate a message from staged changes"
                    : "Stage changes to generate a commit message"
                }
                disabled={busy || !staged.length}
                onClick={() => void generate()}
              >
                <Sparkle className="size-3.5" />
                Generate
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <ButtonGroup
            className="mt-2 flex w-full !gap-0 rounded-md bg-selected"
            aria-label="Commit actions"
          >
            <Button
              className="h-8 flex-1 rounded-r-none text-[13px]"
              disabled={busy || !message.trim() || !status?.changes.length}
              onClick={() => commit()}
            >
              <Check className="size-4" />
              {busy ? "Working…" : "Commit"}
            </Button>
            <Dropdown>
              <Button
                className="h-8 w-8 rounded-l-none border-l border-hairline px-0"
                size="sm"
                aria-label="Commit options"
                disabled={busy}
              >
                <CaretDown className="size-3.5" />
              </Button>
              <DropdownContent align="end">
                <Dropdown.Item
                  isDisabled={!message.trim() || !status?.changes.length}
                  onAction={() => commit()}
                >
                  Commit
                </Dropdown.Item>
                <Dropdown.Item
                  isDisabled={!message.trim()}
                  onAction={() => commit("amend")}
                >
                  Commit (Amend)
                </Dropdown.Item>
                <Separator />
                <Dropdown.Item
                  isDisabled={!message.trim() || !status?.changes.length}
                  onAction={() => commit("commit_push")}
                >
                  Commit &amp; Push
                </Dropdown.Item>
              </DropdownContent>
            </Dropdown>
          </ButtonGroup>
          {error && (
            <p role="alert" className="mt-2 break-words text-xs text-error">
              {error}
            </p>
          )}
        </div>
        {status === null ? (
          <p role="status" className="p-3 text-xs text-text-tertiary">
            Loading changes…
          </p>
        ) : status.changes.length === 0 ? (
          <div className="flex items-center gap-2 p-3 text-xs text-text-tertiary">
            <Check className="size-4" />
            No pending changes
          </div>
        ) : (
          groups
            .filter((group) => group.changes.length)
            .map((group) => (
              <Collapsible key={group.name} defaultOpen className="mb-1">
                <div className="flex h-8 items-center gap-1">
                  <CollapsibleTrigger
                    className="group/section flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-[13px] font-medium text-text-secondary hover:bg-hover"
                    aria-label={group.name}
                  >
                    <CaretRight className="size-3 shrink-0 group-aria-expanded/section:rotate-90" />
                    <span>{group.name}</span>
                    <span className="ml-auto rounded-full bg-hover px-1.5 text-[11px] font-normal text-text-tertiary">
                      {group.changes.length}
                    </span>
                  </CollapsibleTrigger>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-text-tertiary"
                    disabled={busy}
                    aria-label={`${group.staged ? "Unstage" : "Stage"} all ${group.name.toLowerCase()}`}
                    title={group.staged ? "Unstage all" : "Stage all"}
                    onClick={() =>
                      void run(
                        group.changes.map((change) => ({
                          action: group.staged ? "unstage" : "stage",
                          path: change.path,
                        })),
                      )
                    }
                  >
                    {group.staged ? (
                      <Minus className="size-3.5" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                  </Button>
                </div>
                <CollapsibleContent>
                  <ChangesFileList
                    changes={[...group.changes].sort(
                      (a, b) =>
                        (sort === "name"
                          ? a.path.split("/").pop()!
                          : a.path
                        ).localeCompare(
                          sort === "name" ? b.path.split("/").pop()! : b.path,
                        ) || a.path.localeCompare(b.path),
                    )}
                    staged={group.staged}
                    tree={tree}
                    busy={busy}
                    selectedPath={selectedPath}
                    onOpen={onOpen}
                    onStage={(path) =>
                      void run([
                        { action: group.staged ? "unstage" : "stage", path },
                      ])
                    }
                    onDiscard={(path) =>
                      ask(
                        "Discard changes",
                        `Discard unstaged changes in ${path}? A recoverable copy will be moved to Trash.`,
                        [{ action: "discard", path }],
                        "Discard",
                      )
                    }
                  />
                </CollapsibleContent>
              </Collapsible>
            ))
        )}
      </div>
      <Dialog open={prefs} onOpenChange={setPrefs}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commit settings</DialogTitle>
            <DialogDescription>
              Choose defaults for commit messages and staging.
            </DialogDescription>
          </DialogHeader>
          <CommitPreferences
            data={data}
            projectId={context.projectId}
            models={models}
            changed={onData}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={branchPicker} onOpenChange={setBranchPicker}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Checkout branch</DialogTitle>
            <DialogDescription>
              Switch the current repository to another branch.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="Filter branches"
            placeholder="Find a branch…"
            value={branchFilter}
            onChange={(event) => setBranchFilter(event.target.value)}
          />
          <div className="max-h-72 overflow-y-auto">
            {!details ? (
              <p className="p-2 text-xs text-text-tertiary">
                Loading branches…
              </p>
            ) : (
              details.branches
                .filter((branch) =>
                  branch.toLowerCase().includes(branchFilter.toLowerCase()),
                )
                .map((branch) => (
                  <Button
                    key={branch}
                    variant="ghost"
                    className="w-full justify-start"
                    disabled={busy || branch === status?.branch}
                    onClick={() => {
                      setBranchPicker(false);
                      void run([{ action: "checkout", reference: branch }]);
                    }}
                  >
                    <Branch className="size-4" />
                    <span className="truncate">{branch}</span>
                    {branch === status?.branch && (
                      <Check className="ml-auto size-4" />
                    )}
                  </Button>
                ))
            )}
            {details &&
              !details.branches.some((branch) =>
                branch.toLowerCase().includes(branchFilter.toLowerCase()),
              ) && (
                <p className="p-2 text-xs text-text-tertiary">
                  No matching branches.
                </p>
              )}
          </div>
        </DialogContent>
      </Dialog>
      {confirm && <ConfirmDialog {...confirm} />}
    </section>
  );
}
