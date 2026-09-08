import { MoreIcon } from "./NavigationIcons";
import { Checkbox } from "./controls/checkbox";
import { DropdownContent } from "./controls/menu";
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
import { Button } from "./controls/button";
import { ButtonGroup } from "./controls/button-group";
import { Input } from "./controls/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./controls/input-group";
import { Item, ItemActions, ItemGroup } from "./controls/item";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./controls/collapsible";
import { Dropdown, Header, Separator } from "./controls/overlay";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./controls/dialog";
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
    <div className="commit-preferences flex flex-col gap-3 [&_label]:flex [&_label]:flex-col [&_label]:gap-2">
      <div className="segmented">
        <Button
          aria-pressed={scope === "global"}
          onClick={() => setScope("global")}
        >
          Global defaults
        </Button>
        <Button
          aria-pressed={scope === "project"}
          onClick={() => setScope("project")}
        >
          This project
        </Button>
      </div>
      {scope === "project" && (
        <Checkbox
          checked={!override}
          onCheckedChange={(e) => save(e ? null : { ...data.global })}
        >
          Use global defaults
        </Checkbox>
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
        <Checkbox
          checked={settings.coAuthor}
          onCheckedChange={(e) => save({ ...settings, coAuthor: e })}
        >
          Include “Co-authored-by”
        </Checkbox>
        <Checkbox
          checked={settings.smartCommit}
          onCheckedChange={(e) => save({ ...settings, smartCommit: e })}
        >
          Smart commit when nothing is staged
        </Checkbox>
        <label>
          Untracked files
          <SelectMenu
            label="Untracked files"
            value={settings.untracked}
            onChange={(value) =>
              save({
                ...settings,
                untracked: value as CommitSettings["untracked"],
              })
            }
            options={[
              { value: "mixed", label: "With Changes" },
              { value: "separate", label: "Separate group" },
              { value: "hidden", label: "Hidden" },
            ]}
          />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="inline-error my-2 text-[13px] text-error">
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
            <Checkbox
              onCheckedChange={(e) => {
                always = e;
              }}
            >
              Always stage changes when nothing is staged
            </Checkbox>
            <Button
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
            </Button>
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
    <section
      className="source-control scm-panel flex min-h-0 flex-1 flex-col bg-canvas text-text"
      aria-label="Source Control"
    >
      <header className="scm-header flex h-9 shrink-0 items-center gap-1 px-2">
        <Button
          variant="ghost"
          size="sm"
          className="scm-branch min-w-0 flex-1 justify-start text-text-secondary"
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
          className="scm-icon size-8 p-0 text-text-secondary"
          title="Refresh"
          aria-label="Refresh"
          onClick={refresh}
        >
          <ArrowClockwiseIcon />
        </Button>
        <Dropdown isOpen={menu} onOpenChange={setMenu}>
          <Button
            variant="ghost"
            size="icon"
            className="scm-icon size-8 p-0 text-text-secondary"
            aria-label="Git actions"
            title="Git actions"
          >
            <MoreIcon />
          </Button>

          <DropdownContent align="end" className="scm-menu">
            <Dropdown.Section>
              <Header>Repository</Header>
            </Dropdown.Section>
            {(["fetch", "pull", "push", "sync"] as const).map((action) => (
              <Dropdown.Item
                key={action}
                isDisabled={busy}
                onAction={() => void run({ action })}
              >
                {action[0]!.toUpperCase() + action.slice(1)}
              </Dropdown.Item>
            ))}
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item isDisabled={busy}>Publish branch</Dropdown.Item>
              <DropdownContent className="scm-menu">
                {(details?.remotes.length ? details.remotes : ["origin"]).map(
                  (remote) => (
                    <Dropdown.Item
                      key={remote}
                      onAction={() =>
                        void run({ action: "publish", reference: remote })
                      }
                    >
                      {remote}
                    </Dropdown.Item>
                  ),
                )}
              </DropdownContent>
            </Dropdown.SubmenuTrigger>
            <Separator />
            <Dropdown.Item onAction={() => setGitDialog("branch")}>
              <GitBranchIcon />
              Branches and references…
            </Dropdown.Item>
            <Dropdown.SubmenuTrigger>
              <Dropdown.Item isDisabled={busy}>Stashes</Dropdown.Item>
              <DropdownContent className="scm-menu">
                <Dropdown.Item onAction={() => void run({ action: "stash" })}>
                  Stash changes
                </Dropdown.Item>
                {!!details?.stashes.length && <Separator />}
                {details?.stashes.map((stash) => (
                  <Dropdown.SubmenuTrigger key={stash}>
                    <Dropdown.Item
                      className="scm-stash-label"
                      textValue={stash}
                    >
                      {stash}
                    </Dropdown.Item>
                    <DropdownContent className="scm-menu">
                      {[
                        ["stash_apply", "Apply"],
                        ["stash_pop", "Pop"],
                        ["stash_drop", "Drop"],
                      ].map(([action, label]) => (
                        <Dropdown.Item
                          key={action}
                          variant={
                            action === "stash_drop" ? "danger" : "default"
                          }
                          onAction={() =>
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
                        </Dropdown.Item>
                      ))}
                    </DropdownContent>
                  </Dropdown.SubmenuTrigger>
                ))}
              </DropdownContent>
            </Dropdown.SubmenuTrigger>
            <Dropdown.Item onAction={() => setGitDialog("history")}>
              <ClockCounterClockwiseIcon />
              Source Control history
            </Dropdown.Item>
            <Dropdown.Item
              isDisabled={busy}
              onAction={() =>
                ask(
                  "Undo last commit",
                  "Keep the last commit’s changes staged and remove that commit from this branch?",
                  { action: "undo_commit" },
                )
              }
            >
              <ArrowCounterClockwiseIcon />
              Undo Last Commit
            </Dropdown.Item>
            <Separator />
            <Dropdown.Item onAction={() => setPrefs(true)}>
              <GearSixIcon />
              Commit settings
            </Dropdown.Item>
          </DropdownContent>
        </Dropdown>
      </header>

      <div
        className="scm-scroll min-h-0 flex-1 overflow-y-auto p-2"
        aria-label="Changed files"
      >
        {status === null ? (
          <div className="scm-empty p-3 text-text-disabled" role="status">
            Loading changes…
          </div>
        ) : status.changes.length === 0 ? (
          <div className="scm-empty p-3 text-text-disabled">
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
              <div className="scm-group-heading flex items-center gap-1">
                <CollapsibleTrigger
                  className="scm-group-toggle min-w-0 flex-1 justify-start text-text-secondary"
                  aria-label={group.name}
                >
                  <CaretRightIcon className="scm-disclosure" />
                  <span>{group.name}</span>
                  <span className="scm-count ml-auto text-xs text-text-tertiary">
                    {group.changes.length}
                  </span>
                </CollapsibleTrigger>
                <Button
                  variant="ghost"
                  size="icon"
                  className="scm-icon size-8 p-0 text-text-secondary"
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
                        className="scm-file-row flex min-w-0 items-center gap-1 rounded-md"
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
                        <Button
                          className="scm-file-open min-w-0 flex-1 justify-start"
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
                          <span className="scm-file-name min-w-0 truncate">
                            {change.path.split("/").pop()}
                          </span>
                          {directory && (
                            <span className="scm-file-path min-w-0 truncate text-xs text-text-tertiary">
                              {directory}
                            </span>
                          )}
                        </Button>
                        <span
                          className="scm-file-status text-xs text-text-secondary"
                          data-status={code}
                          title={statusLabel(code)}
                        >
                          {code}
                        </span>
                        <ItemActions className="scm-file-actions">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="scm-icon size-8 p-0 text-text-secondary"
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
                              className="scm-icon size-8 p-0 text-text-secondary"
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
                  <p className="scm-group-empty p-3 text-text-disabled">
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

      <footer className="scm-composer shrink-0 bg-input-shell p-3">
        {error && (
          <p className="scm-error my-2 text-error" role="alert">
            {error}
          </p>
        )}
        <div className="scm-composer-heading mb-2 flex items-center justify-between text-text-secondary">
          <label htmlFor={messageId}>Commit message</label>
          <Button
            variant="ghost"
            size="icon"
            className="scm-icon size-8 p-0 text-text-secondary"
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
            className="scm-message w-full resize-y"
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
          <InputGroupAddon
            align="block-end"
            className="scm-message-toolbar justify-between text-text-secondary"
          >
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
        <ButtonGroup
          className="scm-commit-buttons mt-2 flex w-full"
          aria-label="Commit actions"
        >
          <Button
            className="scm-commit flex-1 bg-selected"
            disabled={busy || !message.trim() || !status?.changes.length}
            onClick={() => commit()}
          >
            <CheckIcon />
            {busy ? "Working…" : "Commit"}
          </Button>
          <Dropdown>
            <Button
              className="scm-commit-options"
              size="icon"
              aria-label="Commit options"
              disabled={busy || !message.trim()}
            >
              <CaretDownIcon />
            </Button>

            <DropdownContent side="top" align="end" className="scm-menu">
              <Dropdown.Item
                isDisabled={!message.trim() || !status?.changes.length}
                onAction={() => commit("commit_all")}
              >
                Commit All
              </Dropdown.Item>
              <Dropdown.Item
                isDisabled={!message.trim()}
                onAction={() => commit("amend")}
              >
                Commit (Amend)
              </Dropdown.Item>
            </DropdownContent>
          </Dropdown>
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
            <pre className="scm-history max-h-96 overflow-auto whitespace-pre-wrap text-text-secondary">
              {details?.history ||
                (details ? "No commits yet" : "Loading history…")}
            </pre>
          ) : (
            <div className="scm-branch-controls flex flex-col gap-3">
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
              <div className="scm-branch-actions flex flex-wrap gap-2">
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
              <div className="scm-branch-actions flex flex-wrap gap-2">
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
            <p className="scm-error my-2 text-error" role="alert">
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
