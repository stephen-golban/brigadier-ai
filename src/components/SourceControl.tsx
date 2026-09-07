import { useEffect, useId, useState, type ReactNode } from "react";
import {
  CaretDownIcon,
  CaretRightIcon,
  GearSixIcon,
  ClockCounterClockwiseIcon,
  PlusIcon,
  MinusIcon,
  ArrowCounterClockwiseIcon,
  SparkleIcon,
  CheckIcon,
  DotsThreeIcon,
  FileIcon,
  GitBranchIcon,
  ArrowClockwiseIcon,
} from "@phosphor-icons/react";
import {
  errorMessage,
  type WorkspaceContext,
  type GitStatus,
} from "../workspaceApi";
import {
  workbenchApi,
  defaultSettings,
  type WorkbenchData,
  type CommitSettings,
  type GitAction,
  type GitDetails,
} from "../workbenchApi";
import type { ModelInfo } from "../wire";
import { SelectMenu } from "./SelectMenu";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import { Button } from "./ui/button";
import { ButtonGroup } from "./ui/button-group";
import { Input } from "./ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./ui/input-group";
import { Item, ItemActions, ItemGroup } from "./ui/item";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import "./SourceControl.css";
export function CommitPreferences({
  data,
  projectId,
  models,
  changed,
}: {
  data: WorkbenchData;
  projectId: string;
  models: ModelInfo[];
  changed: (data: WorkbenchData) => void;
}) {
  const [scope, setScope] = useState<"project" | "global">("project");
  const [error, setError] = useState("");
  const override = data.projects[projectId];
  const settings =
    (scope === "global" ? data.global : (override ?? data.global)) ??
    defaultSettings;
  const save = (next: CommitSettings | null) =>
    void workbenchApi
      .saveSettings(scope === "global" ? null : projectId, next)
      .then(changed)
      .catch((e) => setError(errorMessage(e)));
  return (
    <div className="commit-preferences">
      <div className="segmented">
        <button
          aria-pressed={scope === "global"}
          onClick={() => setScope("global")}
        >
          Global defaults
        </button>
        <button
          aria-pressed={scope === "project"}
          onClick={() => setScope("project")}
        >
          This project
        </button>
      </div>
      {scope === "project" && (
        <label>
          <input
            type="checkbox"
            checked={!override}
            onChange={(e) => save(e.target.checked ? null : { ...data.global })}
          />
          Use global defaults
        </label>
      )}
      <fieldset disabled={scope === "project" && !override}>
        <SelectMenu
          label="Commit message model"
          value={settings.model}
          searchable
          options={[
            {
              value: "auto",
              label: "Auto",
              description: "Cheapest available model from this CLI",
            },
            { value: "session", label: "Session model" },
            ...models.map((m) => ({ value: m.id, label: m.label })),
          ]}
          onChange={(model) => save({ ...settings, model })}
        />
        <label>
          <input
            type="checkbox"
            checked={settings.coAuthor}
            onChange={(e) => save({ ...settings, coAuthor: e.target.checked })}
          />
          Include “Co-authored-by”
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.smartCommit}
            onChange={(e) =>
              save({ ...settings, smartCommit: e.target.checked })
            }
          />
          Smart commit when nothing is staged
        </label>
        <label>
          Untracked files
          <select
            value={settings.untracked}
            onChange={(e) =>
              save({
                ...settings,
                untracked: e.target.value as CommitSettings["untracked"],
              })
            }
          >
            <option value="mixed">With Changes</option>
            <option value="separate">Separate group</option>
            <option value="hidden">Hidden</option>
          </select>
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
export function SourceControl({
  context,
  status,
  refresh,
  onOpen,
  data,
  onData,
  models,
  children,
}: {
  context: WorkspaceContext;
  status: GitStatus | null;
  refresh: () => void;
  onOpen: (
    path: string,
    kind: "file" | "diff",
    staged?: boolean,
    line?: number,
  ) => void;
  data: WorkbenchData;
  onData: (d: WorkbenchData) => void;
  models: ModelInfo[];
  children?: ReactNode;
}) {
  const messageId = useId();
  const referenceId = useId();
  const key = `commit:${context.projectId}:${context.sessionId ?? ""}`;
  const [entry, setEntry] = useState({
    key,
    value: localStorage.getItem(key) ?? "",
  });
  const message =
    entry.key === key ? entry.value : (localStorage.getItem(key) ?? "");
  const setMessage = (value: string) => {
    setEntry({ key, value });
    localStorage.setItem(key, value);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [menu, setMenu] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [details, setDetails] = useState<GitDetails | null>(null);
  const [ref, setRef] = useState("");
  const [gitDialog, setGitDialog] = useState<"branch" | "history" | null>(null);
  const settings = data.projects[context.projectId] ?? data.global;
  useEffect(() => {
    setDetails(null);
    setError("");
    setRef("");
    setMenu(false);
    setGitDialog(null);
    setPrefs(false);
  }, [context.projectId, context.sessionId]);
  useEffect(() => {
    if (!menu && !gitDialog) return;
    let live = true;
    void workbenchApi
      .gitDetails(context)
      .then((next) => {
        if (live) setDetails(next);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [menu, gitDialog, context.projectId, context.sessionId]);
  const run = async (request: GitAction) => {
    setBusy(true);
    setError("");
    try {
      await workbenchApi.gitAction(context, request);
      refresh();
      if (request.action.startsWith("commit") || request.action === "amend")
        setMessage("");
      if (details)
        void workbenchApi
          .gitDetails(context)
          .then(setDetails)
          .catch(() => {});
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const staged =
    status?.changes.filter((c) => c.index !== " " && c.index !== "?") ?? [];
  const ask = (title: string, body: string, request: GitAction) =>
    setConfirm({
      title,
      body,
      confirmLabel: title,
      onCancel: () => setConfirm(null),
      onConfirm: async () => {
        setConfirm(null);
        await run(request);
      },
    });
  const commit = (action = "commit") => {
    const attributed =
      settings.coAuthor && !/^Co-authored-by:/im.test(message)
        ? `${message.trim()}\n\nCo-authored-by: Claude <noreply@anthropic.com>`
        : message;
    if (!staged.length && action === "commit" && status?.changes.length) {
      if (settings.smartCommit) {
        void run({ action: "commit_all", message: attributed });
        return;
      }
      if (!settings.suggestSmartCommit) {
        setError("Stage changes before committing.");
        return;
      }
      let always = false;
      setConfirm({
        title: "No staged changes",
        body: (
          <>
            <p>Stage all changes and commit them?</p>
            <label>
              <input
                type="checkbox"
                onChange={(e) => {
                  always = e.target.checked;
                }}
              />
              Always stage changes when nothing is staged
            </label>
            <button
              className="act"
              onClick={() => {
                void workbenchApi
                  .saveSettings(context.projectId, {
                    ...settings,
                    suggestSmartCommit: false,
                  })
                  .then(onData);
                setConfirm(null);
              }}
            >
              Never ask again
            </button>
          </>
        ),
        confirmLabel: "Yes, commit all",
        onCancel: () => setConfirm(null),
        onConfirm: async () => {
          if (always)
            onData(
              await workbenchApi.saveSettings(context.projectId, {
                ...settings,
                smartCommit: true,
              }),
            );
          setConfirm(null);
          await run({ action: "commit_all", message: attributed });
        },
      });
      return;
    }
    if (action === "amend")
      ask(
        "Amend last commit",
        "Replace the last commit with these staged changes and message?",
        { action, message: attributed },
      );
    else void run({ action, message: attributed });
  };
  const groups = [
    { name: "Staged Changes", staged: true, changes: staged },
    {
      name: "Changes",
      staged: false,
      changes:
        status?.changes.filter((c) =>
          c.index === "?" ? settings.untracked === "mixed" : c.worktree !== " ",
        ) ?? [],
    },
    ...(settings.untracked === "separate"
      ? [
          {
            name: "Untracked Changes",
            staged: false,
            changes: status?.changes.filter((c) => c.index === "?") ?? [],
          },
        ]
      : []),
  ];
  return (
    <section className="source-control scm-panel" aria-label="Source Control">
      <header className="scm-header">
        <Button
          variant="ghost"
          size="sm"
          className="scm-branch"
          title={status?.branch ?? "Repository"}
          onClick={() => setGitDialog("branch")}
        >
          <GitBranchIcon />
          <span>{status?.branch ?? "Repository"}</span>
          <CaretDownIcon className="scm-chevron" />
        </Button>
        {!!((status?.ahead ?? 0) + (status?.behind ?? 0)) && (
          <span
            className="scm-sync"
            title={`${status?.ahead ?? 0} outgoing, ${status?.behind ?? 0} incoming commits`}
          >
            {status?.ahead ?? 0}↑ {status?.behind ?? 0}↓
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="scm-icon"
          title="Refresh"
          aria-label="Refresh"
          onClick={refresh}
        >
          <ArrowClockwiseIcon />
        </Button>
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="scm-icon"
              aria-label="Git actions"
              title="Git actions"
            >
              <DotsThreeIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="scm-menu">
            <DropdownMenuLabel>Repository</DropdownMenuLabel>
            {(["fetch", "pull", "push", "sync"] as const).map((action) => (
              <DropdownMenuItem
                key={action}
                disabled={busy}
                onSelect={() => void run({ action })}
              >
                {action[0]!.toUpperCase() + action.slice(1)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={busy}>
                Publish branch
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="scm-menu">
                {(details?.remotes.length ? details.remotes : ["origin"]).map(
                  (remote) => (
                    <DropdownMenuItem
                      key={remote}
                      onSelect={() =>
                        void run({ action: "publish", reference: remote })
                      }
                    >
                      {remote}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setGitDialog("branch")}>
              <GitBranchIcon />
              Branches and references…
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={busy}>
                Stashes
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="scm-menu">
                <DropdownMenuItem
                  onSelect={() => void run({ action: "stash" })}
                >
                  Stash changes
                </DropdownMenuItem>
                {!!details?.stashes.length && <DropdownMenuSeparator />}
                {details?.stashes.map((stash) => (
                  <DropdownMenuSub key={stash}>
                    <DropdownMenuSubTrigger
                      className="scm-stash-label"
                      title={stash}
                    >
                      {stash}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="scm-menu">
                      {[
                        ["stash_apply", "Apply"],
                        ["stash_pop", "Pop"],
                        ["stash_drop", "Drop"],
                      ].map(([action, label]) => (
                        <DropdownMenuItem
                          key={action}
                          variant={
                            action === "stash_drop" ? "destructive" : "default"
                          }
                          onSelect={() =>
                            action === "stash_drop"
                              ? ask("Drop stash", `Remove ${stash}?`, {
                                  action,
                                  reference: stash.split(":")[0],
                                })
                              : void run({
                                  action: action!,
                                  reference: stash.split(":")[0],
                                })
                          }
                        >
                          {label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={() => setGitDialog("history")}>
              <ClockCounterClockwiseIcon />
              Source Control history
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() =>
                ask(
                  "Undo last commit",
                  "Keep the last commit’s changes staged and remove that commit from this branch?",
                  { action: "undo_commit" },
                )
              }
            >
              <ArrowCounterClockwiseIcon />
              Undo Last Commit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPrefs(true)}>
              <GearSixIcon />
              Commit settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="scm-scroll" aria-label="Changed files">
        {status === null ? (
          <div className="scm-empty" role="status">
            Loading changes…
          </div>
        ) : status.changes.length === 0 ? (
          <div className="scm-empty">
            <CheckIcon size={24} />
            <strong>No pending changes</strong>
            <span>Your working tree is clean.</span>
          </div>
        ) : (
          groups.map((group) => (
            <Collapsible
              key={group.name}
              defaultOpen
              className="scm-group"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (busy) return;
                try {
                  const moved = JSON.parse(
                    e.dataTransfer.getData("application/brigadier-git"),
                  );
                  if (
                    typeof moved.path === "string" &&
                    typeof moved.staged === "boolean" &&
                    moved.staged !== group.staged
                  )
                    void run({
                      action: group.staged ? "stage" : "unstage",
                      path: moved.path,
                    });
                } catch {
                  /* unrelated drop */
                }
              }}
            >
              <div className="scm-group-heading">
                <CollapsibleTrigger
                  className="scm-group-toggle"
                  aria-label={group.name}
                >
                  <CaretRightIcon className="scm-disclosure" />
                  <span>{group.name}</span>
                  <span className="scm-count">{group.changes.length}</span>
                </CollapsibleTrigger>
                <Button
                  variant="ghost"
                  size="icon"
                  className="scm-icon"
                  disabled={busy || !group.changes.length}
                  aria-label={
                    group.staged ? "Unstage all changes" : "Stage all changes"
                  }
                  title={
                    group.staged ? "Unstage all changes" : "Stage all changes"
                  }
                  onClick={() =>
                    void run({ action: group.staged ? "unstage" : "stage" })
                  }
                >
                  {group.staged ? <MinusIcon /> : <PlusIcon />}
                </Button>
              </div>
              <CollapsibleContent>
                <ItemGroup aria-label={`${group.name} files`}>
                  {group.changes.map((change) => {
                    const code =
                      change.index === "?"
                        ? "U"
                        : group.staged
                          ? change.index
                          : change.worktree;
                    const directory = change.path.includes("/")
                      ? change.path.slice(0, change.path.lastIndexOf("/"))
                      : "";
                    return (
                      <Item
                        key={change.path}
                        role="listitem"
                        size="sm"
                        className="scm-file-row"
                        draggable={!busy}
                        onDragStart={(e) =>
                          e.dataTransfer.setData(
                            "application/brigadier-git",
                            JSON.stringify({
                              path: change.path,
                              staged: group.staged,
                            }),
                          )
                        }
                      >
                        <button
                          className="scm-file-open"
                          title={change.path}
                          onClick={() =>
                            onOpen(change.path, "diff", group.staged)
                          }
                          onContextMenu={(e) => {
                            e.preventDefault();
                            onOpen(change.path, "file");
                          }}
                        >
                          <FileIcon className="scm-file-icon" />
                          <span className="scm-file-name">
                            {change.path.split("/").pop()}
                          </span>
                          {directory && (
                            <span className="scm-file-path">{directory}</span>
                          )}
                        </button>
                        <span
                          className="scm-file-status"
                          data-status={code}
                          title={statusLabel(code)}
                        >
                          {code}
                        </span>
                        <ItemActions className="scm-file-actions">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="scm-icon"
                            disabled={busy}
                            aria-label={`${group.staged ? "Unstage" : "Stage"} ${change.path}`}
                            title={group.staged ? "Unstage" : "Stage"}
                            onClick={() =>
                              void run({
                                action: group.staged ? "unstage" : "stage",
                                path: change.path,
                              })
                            }
                          >
                            {group.staged ? <MinusIcon /> : <PlusIcon />}
                          </Button>
                          {!group.staged && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="scm-icon"
                              disabled={busy}
                              aria-label={`Discard ${change.path}`}
                              title="Discard changes"
                              onClick={() =>
                                ask(
                                  "Discard changes",
                                  `Discard uncommitted changes in ${change.path}? A recoverable copy will be moved to Trash.`,
                                  { action: "discard", path: change.path },
                                )
                              }
                            >
                              <ArrowCounterClockwiseIcon />
                            </Button>
                          )}
                        </ItemActions>
                      </Item>
                    );
                  })}
                </ItemGroup>
                {!group.changes.length && (
                  <p className="scm-group-empty">
                    {group.staged
                      ? "No staged changes"
                      : "No changes in this group"}
                  </p>
                )}
              </CollapsibleContent>
            </Collapsible>
          ))
        )}
        {children}
      </div>

      <footer className="scm-composer">
        {error && (
          <p className="scm-error" role="alert">
            {error}
          </p>
        )}
        <div className="scm-composer-heading">
          <label htmlFor={messageId}>Commit message</label>
          <Button
            variant="ghost"
            size="icon"
            className="scm-icon"
            aria-label="Commit settings"
            title="Commit settings"
            onClick={() => setPrefs(true)}
          >
            <GearSixIcon />
          </Button>
        </div>
        <InputGroup className="scm-message-group">
          <InputGroupTextarea
            id={messageId}
            aria-label="Commit message"
            placeholder="Describe your changes…"
            value={message}
            rows={3}
            className="scm-message"
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === "Enter" &&
                message.trim() &&
                !busy &&
                status?.changes.length
              ) {
                e.preventDefault();
                commit();
              }
            }}
          />
          <InputGroupAddon align="block-end" className="scm-message-toolbar">
            <InputGroupButton
              disabled={busy || !staged.length}
              aria-label="Generate commit message"
              title="Generate a message from staged changes"
              onClick={() => {
                const targetKey = key;
                setBusy(true);
                setError("");
                workbenchApi
                  .generate(context, settings.model)
                  .then((r) => {
                    localStorage.setItem(targetKey, r.message);
                    setEntry({ key: targetKey, value: r.message });
                  })
                  .catch((e) => setError(errorMessage(e)))
                  .finally(() => setBusy(false));
              }}
            >
              <SparkleIcon />
              Generate
            </InputGroupButton>
            <span className="scm-staged-count">{staged.length} staged</span>
          </InputGroupAddon>
        </InputGroup>
        <ButtonGroup className="scm-commit-buttons" aria-label="Commit actions">
          <Button
            className="scm-commit"
            disabled={busy || !message.trim() || !status?.changes.length}
            onClick={() => commit()}
          >
            <CheckIcon />
            {busy ? "Working…" : "Commit"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="scm-commit-options"
                size="icon"
                aria-label="Commit options"
                disabled={busy || !message.trim()}
              >
                <CaretDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="scm-menu">
              <DropdownMenuItem
                disabled={!message.trim() || !status?.changes.length}
                onSelect={() => commit("commit_all")}
              >
                Commit All
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!message.trim()}
                onSelect={() => commit("amend")}
              >
                Commit (Amend)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </footer>

      <Dialog open={prefs} onOpenChange={setPrefs}>
        <DialogContent className="scm-dialog">
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
      <Dialog
        open={gitDialog !== null}
        onOpenChange={(open) => {
          if (!open) setGitDialog(null);
        }}
      >
        <DialogContent className="scm-dialog">
          <DialogHeader>
            <DialogTitle>
              {gitDialog === "history"
                ? "Source Control history"
                : "Branches and references"}
            </DialogTitle>
            <DialogDescription>
              {gitDialog === "history"
                ? "Recent commits in this workspace."
                : "Switch branches or work with another Git reference."}
            </DialogDescription>
          </DialogHeader>
          {gitDialog === "history" ? (
            <pre className="scm-history">
              {details?.history ||
                (details ? "No commits yet" : "Loading history…")}
            </pre>
          ) : (
            <div className="scm-branch-controls">
              <label htmlFor={referenceId}>Branch / reference</label>
              <Input
                id={referenceId}
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                list={`${referenceId}-options`}
                placeholder="Choose or enter a branch"
              />
              <datalist id={`${referenceId}-options`}>
                {details?.branches.map((branch) => (
                  <option key={branch} value={branch} />
                ))}
              </datalist>
              <div className="scm-branch-actions">
                {[
                  ["checkout", "Checkout"],
                  ["branch", "Create branch"],
                  ["merge", "Merge"],
                  ["rebase", "Rebase"],
                ].map(([action, label]) => (
                  <Button
                    key={action}
                    variant="outline"
                    size="sm"
                    disabled={busy || !ref.trim()}
                    onClick={async () => {
                      if (await run({ action: action!, reference: ref.trim() }))
                        setGitDialog(null);
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <div className="scm-branch-actions">
                {[
                  ["merge_abort", "Abort merge"],
                  ["rebase_abort", "Abort rebase"],
                  ["rebase_continue", "Continue rebase"],
                ].map(([action, label]) => (
                  <Button
                    key={action}
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run({ action: action! })}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {error && (
            <p className="scm-error" role="alert">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
      {confirm && <ConfirmDialog {...confirm} />}
    </section>
  );
}

function statusLabel(code: string) {
  return (
    (
      {
        M: "Modified",
        U: "Untracked",
        A: "Added",
        D: "Deleted",
        R: "Renamed",
        C: "Copied",
      } as Record<string, string>
    )[code] ?? code
  );
}
