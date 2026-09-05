import { useEffect, useState } from "react";
import {
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
}) {
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
  const [remote, setRemote] = useState("");
  const [history, setHistory] = useState(false);
  const settings = data.projects[context.projectId] ?? data.global;
  useEffect(() => {
    setDetails(null);
    setError("");
    setRef("");
  }, [context.projectId, context.sessionId]);
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
    <section className="source-control">
      <div className="section-heading">
        <b>Source Control</b>
        <span className="grow" />
        <button className="icon-button" title="Refresh" onClick={refresh}>
          <ArrowClockwiseIcon />
        </button>
        <button
          className="icon-button"
          aria-label="Git actions"
          aria-expanded={menu}
          onClick={() => {
            setMenu(!menu);
            if (!details)
              void workbenchApi
                .gitDetails(context)
                .then(setDetails)
                .catch((e) => setError(errorMessage(e)));
          }}
        >
          <DotsThreeIcon />
        </button>
      </div>
      <button
        className="branch-button"
        onClick={() => {
          setMenu(true);
          void workbenchApi
            .gitDetails(context)
            .then(setDetails)
            .catch((e) => setError(errorMessage(e)));
        }}
      >
        <GitBranchIcon />
        {status?.branch ?? "Repository"}
        <span className="grow" />
        {status?.ahead ?? 0}↑ {status?.behind ?? 0}↓
      </button>
      <div className="commit-input">
        <textarea
          aria-label="Commit message"
          placeholder="Message (⌘Enter to commit)"
          value={message}
          rows={3}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (
              (e.metaKey || e.ctrlKey) &&
              e.key === "Enter" &&
              message.trim() &&
              !busy
            ) {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button
          className="icon-button"
          disabled={busy || !staged.length}
          aria-label="Generate commit message"
          title="Generate a message from staged changes"
          onClick={() => {
            const targetKey = key;
            setBusy(true);
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
        </button>
      </div>
      <div className="commit-buttons">
        <button
          className="primary-action"
          disabled={busy || !message.trim() || !status?.changes.length}
          onClick={() => commit()}
        >
          <CheckIcon />
          Commit
        </button>
        <button
          className="act"
          aria-label="Commit options"
          onClick={() => setMenu(!menu)}
        >
          ⌄
        </button>
      </div>
      <button
        className="quiet-button"
        aria-expanded={prefs}
        onClick={() => setPrefs(!prefs)}
      >
        Commit settings
      </button>
      {prefs && (
        <CommitPreferences
          data={data}
          projectId={context.projectId}
          models={models}
          changed={onData}
        />
      )}
      {menu && (
        <div className="git-menu">
          {!!details?.remotes.length && (
            <label>
              Publish remote
              <select
                aria-label="Publish remote"
                value={remote || details.remotes[0]}
                onChange={(e) => setRemote(e.target.value)}
              >
                {details.remotes.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="action-grid">
            {["fetch", "pull", "push", "sync", "publish", "stash"].map(
              (action) => (
                <button
                  key={action}
                  disabled={busy}
                  onClick={() =>
                    void run({
                      action,
                      ...(action === "publish"
                        ? {
                            reference:
                              remote || details?.remotes[0] || "origin",
                          }
                        : {}),
                    })
                  }
                >
                  {action[0]!.toUpperCase() + action.slice(1)}
                </button>
              ),
            )}
            <button
              disabled={busy || !message.trim()}
              onClick={() => commit("commit_all")}
            >
              Commit All
            </button>
            <button
              disabled={busy || !message.trim()}
              onClick={() => commit("amend")}
            >
              Commit (Amend)
            </button>
            <button
              disabled={busy}
              onClick={() =>
                ask(
                  "Undo last commit",
                  "Keep the last commit’s changes staged and remove that commit from this branch?",
                  { action: "undo_commit" },
                )
              }
            >
              Undo Last Commit
            </button>
          </div>
          <label>
            Branch / reference
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              list="git-branches"
              placeholder="Choose or enter a branch"
            />
          </label>
          <datalist id="git-branches">
            {details?.branches.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
          <div className="action-grid">
            {[
              ["checkout", "Checkout"],
              ["branch", "Create branch"],
              ["merge", "Merge"],
              ["rebase", "Rebase"],
            ].map(([action, label]) => (
              <button
                key={action}
                disabled={busy || !ref.trim()}
                onClick={() =>
                  void run({ action: action!, reference: ref.trim() })
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="action-grid">
            <button onClick={() => void run({ action: "merge_abort" })}>
              Abort merge
            </button>
            <button onClick={() => void run({ action: "rebase_abort" })}>
              Abort rebase
            </button>
            <button onClick={() => void run({ action: "rebase_continue" })}>
              Continue rebase
            </button>
          </div>
          {details?.stashes.map((s) => (
            <div className="stash-row" key={s}>
              <span>{s}</span>
              {[
                ["stash_apply", "Apply"],
                ["stash_pop", "Pop"],
                ["stash_drop", "Drop"],
              ].map(([action, label]) => (
                <button
                  key={action}
                  onClick={() =>
                    action === "stash_drop"
                      ? ask("Drop stash", `Remove ${s}?`, {
                          action,
                          reference: s.split(":")[0],
                        })
                      : void run({
                          action: action!,
                          reference: s.split(":")[0],
                        })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
          <button className="quiet-button" onClick={() => setHistory(!history)}>
            Source Control history
          </button>
          {history && (
            <pre className="git-history">
              {details?.history || "No commits yet"}
            </pre>
          )}
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {groups.map((group) => (
        <section
          className="change-group"
          key={group.name}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              const moved = JSON.parse(
                e.dataTransfer.getData("application/brigadier-git"),
              );
              if (moved.staged !== group.staged)
                void run({
                  action: group.staged ? "stage" : "unstage",
                  path: moved.path,
                });
            } catch {
              /* unrelated drop */
            }
          }}
        >
          <div className="section-heading">
            <b>{group.name}</b>
            <span>{group.changes.length}</span>
            <span className="grow" />
            <button
              disabled={busy}
              className="icon-button"
              aria-label={
                group.staged ? "Unstage all changes" : "Stage all changes"
              }
              onClick={() =>
                void run({ action: group.staged ? "unstage" : "stage" })
              }
            >
              {group.staged ? <MinusIcon /> : <PlusIcon />}
            </button>
          </div>
          {group.changes.map((c) => (
            <div
              key={c.path}
              className="scm-row"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/brigadier-git",
                  JSON.stringify({ path: c.path, staged: group.staged }),
                );
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  const moved = JSON.parse(
                    e.dataTransfer.getData("application/brigadier-git"),
                  );
                  if (moved.staged !== group.staged)
                    void run({
                      action: group.staged ? "stage" : "unstage",
                      path: moved.path,
                    });
                } catch {
                  /* unrelated drop */
                }
              }}
            >
              <button
                className="tree-row"
                onClick={() => onOpen(c.path, "diff", group.staged)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onOpen(c.path, "file");
                }}
                title={c.path}
              >
                <FileIcon />
                <span>{c.path.split("/").pop()}</span>
                <small>
                  {c.path.includes("/")
                    ? c.path.split("/").slice(0, -1).join("/")
                    : ""}
                </small>
                <b
                  className="git-decoration"
                  data-status={
                    c.index === "?" ? "U" : group.staged ? c.index : c.worktree
                  }
                >
                  {c.index === "?" ? "U" : group.staged ? c.index : c.worktree}
                </b>
              </button>
              <button
                className="icon-button"
                disabled={busy}
                aria-label={`${group.staged ? "Unstage" : "Stage"} ${c.path}`}
                onClick={() =>
                  void run({
                    action: group.staged ? "unstage" : "stage",
                    path: c.path,
                  })
                }
              >
                {group.staged ? <MinusIcon /> : <PlusIcon />}
              </button>
              {!group.staged && (
                <button
                  disabled={busy}
                  className="icon-button"
                  aria-label={`Discard ${c.path}`}
                  onClick={() =>
                    ask(
                      "Discard changes",
                      `Discard uncommitted changes in ${c.path}? A recoverable copy will be moved to Trash.`,
                      { action: "discard", path: c.path },
                    )
                  }
                >
                  <ArrowCounterClockwiseIcon />
                </button>
              )}
            </div>
          ))}
        </section>
      ))}
      {status?.changes.length === 0 && (
        <p className="panel-empty">No pending changes</p>
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </section>
  );
}
