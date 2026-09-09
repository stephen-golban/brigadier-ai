import { MoreIcon } from "./NavigationIcons";
import { Dropdown } from "./controls/overlay";
import { ComposerActions as PromptInputActions } from "./assistant-ui/elements/composer";
import { Button } from "./controls/button";
import { SessionContext } from "./SessionContext";
import { useMessageEdit, type MessageEditProps } from "./EditMessage";
import { PromptInput, useDraft, useAttachmentDraft } from "./PromptInput";
/**
 * Send a turn to the selected session, and the three ways to stop one.
 *
 * Shaped like the ChatGPT macOS composer: a context strip naming the project, the working
 * directory and the model, sitting on a darker rail above a rounded box that holds the text
 * area and one action row. The action row reads left to right as the reference's does: a status
 * chip on the left, then a gap, then the controls and one solid circular send button.
 *
 * `.dock-actions .grow` is that gap; Resume and Clean up worktree sit to the left of it, beside
 * the status chip, and the stop controls stay on the right.
 *
 * Interrupt is graceful and the session survives; End asks the child to exit; Kill takes the
 * process group down and leaves no provider terminal frame behind.
 *
 * Two rules from `docs/plans/ipc-contract.md` are load-bearing here:
 *   - a **resumed** session sits in `starting` until the operator sends the first turn, because
 *     the CLI announces itself once per turn — so `starting` is "ready for input", not "coming
 *     up", and the text area stays enabled for it;
 *   - `resume_session` does **not** restore the permission mode, so a resumed session says so.
 *
 * `cleanup_worktree` refuses in six distinguishable ways and this dock is where the operator
 * reads them, so each one gets its own sentence and its own buttons: see `refusalNote` below.
 */
import { useEffect, useState } from "react";

import { SendIcon } from "./icons";
import { Pickers } from "./Pickers";
import { isSubmitKey } from "../keys";
import { runIsLive } from "../wire";
import type { SessionRuntime } from "../feedStore";
import type {
  ModelInfo,
  PermissionMode,
  PlanId,
  RunView,
  SessionId,
  WorktreeCleanup,
} from "../wire";

/* ------------------------------------------------------------------ the run
 *
 * Handing the harness a goal and walking away is the whole product (`docs/vision.md` §9), so the
 * control for it sits **where the owner already types** — on the dock, above the composer — and
 * not behind a modal or a menu.
 *
 * It has exactly two states, and the second is the contract's:
 *
 *   - no live run: one field for the goal in plain English, and Start.
 *   - a live run: no field at all, and Stop. `start_run` refuses a second run on the same project
 *     with `run_already_live`, so offering the field again would be offering a button whose only
 *     outcome is an error.
 *
 * **Stop stops dispatching; it does not kill** (`docs/plans/ipc-contract.md` §"The run"). A worker
 * killed mid-order leaves a worktree whose `work_order` intent reconciles to `unknown`, which
 * blocks its phase permanently — so the label says what actually happens rather than promising a
 * halt the harness deliberately will not perform.
 */
export interface RunControlProps {
  /** Named in the placeholder, so the field says which repository it is about to point at. */
  projectName: string | null;
  /** False when there is no project selected, or the `claude` probe failed. */
  canStart: boolean;
  /** The newest plan for the selected project, live or finished, or null. */
  run: RunView | null;
  /** An IPC call started here is in flight. */
  busy: boolean;
  /** `list_models`, for the Model picker. Empty leaves only the no-pick entry, which is legal. */
  models: ModelInfo[];
  onStart: (
    goal: string,
    model: string | null,
    permissionMode: PermissionMode,
  ) => void | Promise<boolean>;
  onStop: (planId: PlanId) => void;
}

/**
 * The Model picker's empty entry, and the label is the whole point of R4.1.
 *
 * `null` is not a missing value here. It means the harness's role-based routing stays in charge —
 * judgement takes the provider's strong default, a work order takes its per-order tier — and it
 * is the better default, so it is what the control starts on. An unlabelled empty option would
 * read as a field that failed to load; this says what choosing nothing does.
 */
const NO_MODEL_PICK = "Per role (no pick)";

const MODEL_HINT =
  "No pick leaves the harness's role-based routing in charge. A chosen model applies to every child of the run: planner, lead, worker and fixer alike.";

export function RunControl({
  projectName,
  canStart,
  run,
  busy,
  models,
  onStart,
  onStop,
}: RunControlProps) {
  const [goal, setGoal] = useDraft(`run:${projectName ?? "none"}`);
  /** `""` is "no pick" and is the initial state; see `NO_MODEL_PICK`. */
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const live = runIsLive(run);

  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (!canStart || busy || sending || goal.trim() === "") return;
    // `null`, never `""` and never a sentinel: `start_run`'s `model` is an `Option<String>` and a
    // placeholder string would be handed straight to the CLI's `--model`, which refuses it.
    setSending(true);
    try {
      if (
        (await onStart(goal.trim(), model === "" ? null : model, mode)) !==
        false
      )
        setGoal("");
    } finally {
      setSending(false);
    }
  };

  /*
   * R2, 2026-09-05: this renders **the dock's own box**, not a strip of its own. `src/components/
   * Dock.tsx` owns the frame, the context strip and the chooser that selects this mode; the two
   * text fields the owner counted are now one field whose meaning is named above it. The
   * `aria-label` and the two button labels are unchanged, because `src/App.run.test.tsx` pins the
   * seam between this control and `start_run` by name and that seam did not move.
   */
  if (live && run !== null) {
    return (
      <div className="dock-box mx-auto w-full max-w-[780px]">
        <p className="dock-live">
          <span className="run-dock-status">Run live</span>
          <span className="run-dock-goal" title={run.goal}>
            {run.goal}
          </span>
        </p>
        <div className="dock-actions">
          <span className="status-chip text-text-secondary">dispatching</span>
          <span className="grow" />
          <Button
            type="button"
            className="act danger text-warn"
            disabled={busy}
            title="stop dispatching new orders; in-flight orders finish and are collected"
            onClick={() => onStop(run.plan_id)}
          >
            Stop run
          </Button>
        </div>
      </div>
    );
  }

  return (
    <PromptInput
      rows={2}
      value={goal}
      aria-label="the goal, in plain English"
      placeholder={
        projectName === null
          ? "Select a project to hand it a goal"
          : `Hand ${projectName} a goal in plain English and walk away. Return to start, Shift+Return for a new line.`
      }
      disabled={!canStart || busy || sending}
      onText={setGoal}
      onKeyDown={(e) => {
        if (isSubmitKey(e)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <PromptInputActions className="flex-1 flex-wrap justify-end">
        <span className="status-chip">
          {projectName === null
            ? "No project selected"
            : "plan · dispatch · gate · commit"}
        </span>
        <span className="grow" />
        {/*
          R4.1: these reached nothing until `start_run` grew a `model` and a `permission_mode`,
          and they were drawn only on Session, so the run silently took the CLI's default while
          the dock said otherwise. A chosen model applies to **every** child of the run.
        */}
        <Pickers
          models={models}
          model={model}
          onModel={setModel}
          mode={mode}
          onMode={setMode}
          disabled={!canStart || busy || sending}
          noPickLabel={NO_MODEL_PICK}
          modelHint={MODEL_HINT}
        />
        <Button
          type="button"
          className="rounded-full"
          variant="primary"
          disabled={!canStart || busy || goal.trim() === ""}
          onClick={submit}
        >
          Start run
        </Button>
      </PromptInputActions>
    </PromptInput>
  );
}

export interface ComposerProps extends MessageEditProps {
  session: SessionRuntime | null;
  /** An IPC call started by this dock is in flight; both secondary actions go inert. */
  busy: boolean;
  onSend: (sessionId: SessionId, text: string, attachmentIds?: string[]) => void | Promise<boolean>;
  onInterrupt: (sessionId: SessionId) => void;
  onEnd: (sessionId: SessionId) => void;
  onKill: (sessionId: SessionId) => void;
  onResume: (sessionId: SessionId) => void;
  /** Resolves to the command's answer, or to null when it failed (the caller showed the error). */
  onCleanup: (
    sessionId: SessionId,
    force: boolean,
  ) => Promise<WorktreeCleanup | null>;
}

export function Composer({
  session,
  busy,
  onSend,
  onInterrupt,
  onEnd,
  onKill,
  onResume,
  onCleanup,
  editing,
  onCancelEdit,
  onRewound,
}: ComposerProps) {
  const [draft, setDraft] = useDraft(`turn:${session?.sessionId ?? "none"}`);
  const [attachments, setAttachments] = useAttachmentDraft(`turn:${session?.sessionId ?? "none"}`);
  const [uploading, setUploading] = useState(false);
  const edit = useMessageEdit({ editing, onCancelEdit, onRewound });
  const text = editing ? edit.text : draft;
  const setText = editing ? edit.setText : setDraft;
  /** A cleanup came back `removed: false`: nothing was touched, and `blocked` says why. */
  const [refusal, setRefusal] = useState<WorktreeCleanup | null>(null);
  /** The last successful removal, so the dock can say the checkout is gone and resume is over. */
  const [removed, setRemoved] = useState<WorktreeCleanup | null>(null);
  /** `branch_moved` only: the operator acknowledged that the checkout is not what we recorded, so
   *  the force button exists. Forcing past a branch we did not expect is not a one-click action. */
  const [armed, setArmed] = useState(false);

  const sessionId = session?.sessionId ?? null;
  // All three are about one session; switching sessions must not carry any of them over.
  useEffect(() => {
    setRefusal(null);
    setRemoved(null);
    setArmed(false);
  }, [sessionId]);

  const live =
    session !== null &&
    (session.status === "running" || session.status === "starting");
  const settled =
    session !== null &&
    (session.status === "exited" || session.status === "failed");

  /** Contract §resume_session: a stored token (the front end sees `provider_session_id`) and a
   *  settled session. A removed worktree takes the `cwd` away, so Resume goes with it. */
  const canResume =
    session !== null &&
    settled &&
    session.providerSessionId !== null &&
    !session.worktreeRemoved &&
    removed === null;

  /** Contract §Worktrees: only a session that is not live and actually has a worktree. */
  const canCleanup =
    session !== null &&
    settled &&
    session.branch !== null &&
    !session.worktreeRemoved &&
    removed === null;

  const runCleanup = async (force: boolean) => {
    if (session === null) return;
    const result = await onCleanup(session.sessionId, force);
    if (result === null) return;
    setArmed(false);
    if (result.removed) {
      setRefusal(null);
      setRemoved(result);
    } else {
      setRefusal(result);
    }
  };

  const [sending, setSending] = useState(false);
  const send = async () => {
    if (session === null || !live || busy || sending || uploading || text.trim() === "")
      return;
    if (editing) {
      if (!session.busy) await edit.submit();
      return;
    }
    setSending(true);
    try {
      const accepted = attachments.length
        ? await onSend(session.sessionId, text.trim(), attachments.map(a => a.id))
        : await onSend(session.sessionId, text.trim());
      if (accepted !== false) { setText(""); setAttachments([]); }
    } finally {
      setSending(false);
    }
  };

  /* --------------------------------------------------------- the refusal note
   *
   * `cleanup_worktree` refuses six different ways and they are not interchangeable. Three are
   * answered by the same call with `force: true` (`dirty`, `commits`, `branch_moved` — the
   * `!force` guard at `crates/supervisor/src/worktree.rs:483-513`); the other three are refusals
   * `force` does not reach, and offering a force button for one of them is a button that refuses
   * again. Each reason gets its own sentence: a wrong-but-reassuring one over a blocked action is
   * worse than the block.
   */

  const worktreePath = session?.worktreePath ?? null;

  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

  const verb = (n: number, singular: string, many: string) =>
    n === 1 ? singular : many;

  const dismissButton = (label: string) => (
    <Button
      type="button"
      className="act"
      disabled={busy}
      onClick={() => setRefusal(null)}
    >
      {label}
    </Button>
  );

  const forceButton = (label: string) => (
    <Button
      type="button"
      className="act danger text-warn"
      disabled={busy}
      onClick={() => void runCleanup(true)}
    >
      {label}
    </Button>
  );

  /** Named wherever the remedy is the operator going and looking at the directory. */
  const atPath =
    worktreePath === null ? null : (
      <>
        {" "}
        It is at <code>{worktreePath}</code>.
      </>
    );

  /** A reason this build has no sentence for. Adding a `CleanupBlocked` variant without adding a
   *  case below is a type error on this call, not a blank line in the dock. */
  const unhandledReason = (blocked: never): string =>
    `Cleanup was refused (${String(blocked)}) and this build has no explanation for that reason.`;

  const refusalNote = (r: WorktreeCleanup) => {
    if (r.blocked === null) {
      // Not a shape the Rust produces today: every `removed: false` carries a reason.
      return <>Nothing was removed, and no reason was reported.</>;
    }
    switch (r.blocked) {
      case "dirty":
        return (
          <>
            Removing deletes {plural(r.dirty_files, "file")} in{" "}
            <code>{r.branch}</code> — the count includes ignored files, so{" "}
            <code>.env</code>, build output and <code>node_modules/</code> go
            with them. Nothing was removed.
            {r.commits > 0 ? (
              <>
                {" "}
                The {plural(r.commits, "commit")} no other ref keeps{" "}
                {verb(r.commits, "stays", "stay")} on the branch.
              </>
            ) : null}{" "}
            The branch <code>{r.branch}</code> survives either way; this session
            can no longer be resumed once the checkout is gone.{" "}
            {forceButton(`Delete ${plural(r.dirty_files, "file")} and remove`)}{" "}
            {dismissButton("Keep it")}
          </>
        );
      case "commits":
        return (
          <>
            Nothing uncommitted, but this worktree holds{" "}
            {plural(r.commits, "commit")} that no other branch, tag or remote
            keeps. Removing the checkout leaves them reachable only from{" "}
            <code>{r.branch}</code>, which survives — delete that branch
            afterwards and they are gone for good. Nothing was removed.{" "}
            {forceButton("Remove the checkout, keep the branch")}{" "}
            {dismissButton("Keep it")}
          </>
        );
      case "branch_moved":
        return (
          <>
            {r.live_branch === null ? (
              <>
                This worktree has a detached <code>HEAD</code>; the session
                recorded <code>{r.branch}</code>.
              </>
            ) : (
              <>
                <code>{r.live_branch}</code> is checked out here, not the{" "}
                <code>{r.branch}</code> this session recorded.
              </>
            )}{" "}
            Something moved it — the agent switched branches, or the operator
            did — so what a removal would take is not what this session put
            there. Nothing was removed. Going ahead removes the checkout
            whatever is on it
            {r.dirty_files > 0
              ? `, discarding ${plural(r.dirty_files, "file")}`
              : ""}
            .
            {r.commits > 0 ? (
              r.live_branch === null ? (
                <>
                  {" "}
                  {plural(r.commits, "commit")} here{" "}
                  {verb(r.commits, "is", "are")} kept by no ref at all: remove
                  this and nothing points at {verb(r.commits, "it", "them")} any
                  more.
                </>
              ) : (
                <>
                  {" "}
                  The {plural(r.commits, "commit")} here{" "}
                  {verb(r.commits, "stays", "stay")} on{" "}
                  <code>{r.live_branch}</code>, which survives.
                </>
              )
            ) : null}
            {atPath}{" "}
            {armed ? (
              forceButton(
                r.live_branch === null
                  ? "Remove it with a detached HEAD"
                  : `Remove it with ${r.live_branch} checked out`,
              )
            ) : (
              <Button
                type="button"
                className="act"
                disabled={busy}
                onClick={() => setArmed(true)}
              >
                I have looked at the worktree
              </Button>
            )}{" "}
            {dismissButton("Keep it")}
          </>
        );
      case "locked":
        return (
          <>
            A <code>git worktree lock</code> is held on this worktree — another
            process's claim on it. git refuses to remove a locked worktree and
            only <code>remove -f -f</code> clears a lock, which is not
            brigadier's to give, so forcing from here would refuse again.
            {atPath} Run <code>git worktree unlock</code> on it yourself once
            you know nothing is using it. Nothing was removed.{" "}
            {dismissButton("Dismiss")}
          </>
        );
      case "unregistered":
        return (
          <>
            git does not register this directory as a worktree of the repository
            — a hand-deleted admin directory, or a prune that ran before a
            repair. git can neither describe it nor remove it in that state, and
            brigadier does not <code>rm -rf</code> a directory it cannot
            describe, so forcing does not reach this.{atPath} Look at it and
            delete it yourself once you are sure. Nothing was removed.{" "}
            {dismissButton("Dismiss")}
          </>
        );
      case "left_on_disk":
        return (
          <>
            git reported the worktree removed and the directory is still there —
            the state a renamed project folder produces. The registry entry may
            be gone; the files are not, so nothing is being called removed.
            {atPath} Check it and delete it yourself. There is nothing here for
            force to do. {dismissButton("Dismiss")}
          </>
        );
      default:
        return <>{unhandledReason(r.blocked)}</>;
    }
  };

  const chipClass =
    session === null
      ? "status-chip"
      : session.busy
        ? "status-chip text-warn"
        : live
          ? "status-chip text-text-secondary"
          : "status-chip";

  /*
   * R2, 2026-09-05: the `.dock` frame and the context strip moved to `src/components/Dock.tsx`,
   * which draws them once for all three modes instead of once per composer. Everything below —
   * the box, the action row, the refusal notes and the usage line — is unchanged and still this
   * component's.
   */
  return (
    <>
      <PromptInput
        attachmentProjectId={session?.projectId}
        attachments={editing ? [] : attachments}
        onAttachments={editing ? undefined : setAttachments}
        onUploadChange={setUploading}
        header={
          <>
            {editing && (
              <div className="composer-edit-banner">
                <span>
                  {edit.rewound
                    ? "Conversation rewound · ready to send"
                    : "Editing message"}
                </span>
                <Button
                  type="button"
                  className="act"
                  disabled={edit.busy || Boolean(edit.confirmation)}
                  onClick={onCancelEdit}
                >
                  Cancel edit
                </Button>
              </div>
            )}
            {editing && edit.error && (
              <p
                role="alert"
                className="inline-error my-2 text-[13px] text-error"
              >
                {edit.error}
              </p>
            )}
            {editing && edit.confirmation}
          </>
        }
        rows={2}
        value={text}
        placeholder={live ? "Do anything" : "Select a running session"}
        focusKey={sessionId ?? undefined}
        disabled={
          !live || busy || sending || (Boolean(editing) && edit.disabled)
        }
        onText={setText}
        onKeyDown={(e) => {
          if (isSubmitKey(e)) {
            e.preventDefault();
            send();
          }
        }}
      >
        <PromptInputActions className="flex-1 flex-wrap justify-end">
          <span className={chipClass}>
            {session === null
              ? "No session selected"
              : session.busy
                ? "Turn open"
                : session.status}
          </span>

          {/* Secondary action slot, beside the status chip. */}
          {canResume ? (
            <Button
              type="button"
              className="act"
              disabled={busy}
              title="continue this conversation in the same session, with a new child process"
              onClick={() => session && onResume(session.sessionId)}
            >
              Resume
            </Button>
          ) : null}
          {canCleanup ? (
            <Button
              type="button"
              className="act"
              disabled={busy}
              title={session?.worktreePath ?? undefined}
              onClick={() => void runCleanup(false)}
            >
              Clean up worktree
            </Button>
          ) : null}

          <span className="grow" />

          {session && (
            <span className="session-model max-w-52 truncate text-xs text-text-secondary">
              {session.model ?? "Claude Code"}
            </span>
          )}
          {session && (
            <SessionContext
              sessionId={session.sessionId}
              revision={0}
              busy={session.busy}
            />
          )}
          <Dropdown native>
            <Button size="icon" aria-label="Session actions">
              <MoreIcon />
            </Button>
            <Dropdown.Popover placement="top end">
              <Dropdown.Menu aria-label="Session actions">
                <Dropdown.Item
                  id="interrupt"
                  textValue="Interrupt"
                  isDisabled={!live}
                  onAction={() => session && onInterrupt(session.sessionId)}
                >
                  Interrupt
                </Dropdown.Item>
                <Dropdown.Item
                  id="end"
                  textValue="End session"
                  isDisabled={!live}
                  onAction={() => session && onEnd(session.sessionId)}
                >
                  End session
                </Dropdown.Item>
                <Dropdown.Item
                  id="kill"
                  textValue="Kill process"
                  variant="danger"
                  isDisabled={!live}
                  onAction={() => session && onKill(session.sessionId)}
                >
                  Kill process
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <Button
            type="button"
            size="icon"
            className="rounded-full"
            variant="primary"
            aria-label={sending ? "Preparing message" : editing ? "Send edited message" : "send this turn"}
            disabled={
              !live ||
              busy ||
              sending ||
              text.trim() === "" || uploading ||
              (Boolean(editing) && (edit.disabled || session?.busy))
            }
            onClick={send}
          >
            {sending ? <span role="status" className="animate-pulse">…</span> : <SendIcon />}
          </Button>
        </PromptInputActions>
      </PromptInput>

      {session !== null && session.resumed && removed === null ? (
        <p className="dock-note mx-auto mt-2 max-w-[780px] text-xs text-text-secondary">
          Resumed in default permission mode — the mode this session ran in
          before is not stored anywhere and was not restored.
        </p>
      ) : null}

      {refusal !== null ? (
        <p className="dock-note warn mx-auto mt-2 max-w-[780px] text-xs text-text-secondary text-warn">
          {refusalNote(refusal)}
        </p>
      ) : null}

      {removed !== null ? (
        <p className="dock-note mx-auto mt-2 max-w-[780px] text-xs text-text-secondary">
          Worktree removed. The branch <code>{removed.branch}</code> is
          untouched; this session can no longer be resumed.
        </p>
      ) : null}

      {/*
        No dollar figure. `docs/vision.md` §6 and `CLAUDE.md` §2 both settle this: brigadier runs
        on the user's own subscription, so a per-turn cost in dollars is a number they are never
        billed — a lie in their own favour, and precise to four decimal places about it.
        `session.costUsd` still arrives on the wire and is still stored; it is simply not a thing
        this window tells anyone. What replaces it is the usage-window gauge, which is W2-C's and
        has no data until `rate_limit_event` reaches the front end, so the token counts stay for
        now as the only measure of what a turn spent.
      */}
      {session !== null ? (
        <div className="dock-usage mx-auto mt-2 max-w-[780px] text-xs text-text-tertiary">
          {session.usage.input_tokens} in / {session.usage.output_tokens} out ·
          cache {session.usage.cache_read_tokens} read /{" "}
          {session.usage.cache_creation_tokens} write · rows {session.rowsTotal}
          {session.rowsDropped > 0 ? ` (${session.rowsDropped} dropped)` : ""}
          {session.lastMessage !== null ? ` · ${session.lastMessage}` : ""}
        </div>
      ) : null}
    </>
  );
}
