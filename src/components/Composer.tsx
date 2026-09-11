import { useEffect, useRef, useState } from "react";
import { composerApi, serializeComposerWrite, type ComposerCommand, type ComposerState } from "../composerApi";
import { useDurableComposer } from "./composer/useDurableComposer";
import { desktop, errorMessage } from "../workspaceApi";
import { ComposerActions as PromptInputActions } from "./assistant-ui/elements/composer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { iconButton, labelledButtonIcons } from "@/lib/surfaces";
import { ExecutionControl, ModeControl, PermissionControl, providerLabel } from "./composer/ExecutionControls";
import { useTaskExecutionSettings, type ExecutionSelection } from "../taskSettings";
import { useProviderCatalog } from "../providerCatalog";
import * as feedStore from "../feedStore";
import type { ModelInfo } from "../wire";
import { useMessageEdit, type MessageEditProps } from "./EditMessage";
import { PromptInput } from "./PromptInput";
import { SessionContext } from "./SessionContext";
import { UsageWindows } from "./UsageWindows";
import { ArrowUp, X } from "../icons";
import { isSubmitKey } from "../keys";
import type { SessionRuntime } from "../feedStore";
import type { SessionId, WorktreeCleanup } from "../wire";

const EMPTY_MODELS: ModelInfo[] = [];

/** Module-scope, as `subscribeTo` requires: the registration holds it for the life of the mount. */
const selectApprovals = (s: feedStore.StoreState) => s.approvals;
export interface ComposerProps extends MessageEditProps {
  models?: ModelInfo[];
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

/**
 * Is the first pending approval's card on screen right now?
 *
 * Both surfaces belong, and they do different jobs: the **card in the thread** is where a
 * request is read and answered, in the place in the transcript it happened; this **strip** is
 * a jump affordance for a card that has scrolled out of the viewport. What did not belong was
 * showing them at the same time, each stating the same count — `01-thread-collapsed-full.png`
 * has "Waiting on you · 2 open" and "Approval needed · 2" in one screenshot. Gating the strip
 * on the card's visibility means neither ever restates the other.
 *
 * This is presentation only. It observes the card; it cannot resolve, dismiss or alter one, and
 * the approval's own non-optimistic state machine is untouched.
 */
function useApprovalVisible(requestId: string | undefined): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (requestId === undefined) { setVisible(false); return; }
    if (typeof IntersectionObserver === "undefined") { setVisible(false); return; }
    let observer: IntersectionObserver | undefined;
    // The card mounts from the transcript's own refetch, which is not this component's render.
    // Poll briefly for the element rather than assuming it is there on the first frame.
    const attach = () => {
      const card = document.getElementById(`approval-${requestId}`);
      if (!card) return false;
      observer = new IntersectionObserver(
        entries => setVisible(entries.some(entry => entry.isIntersecting)),
        { threshold: 0 },
      );
      observer.observe(card);
      return true;
    };
    if (attach()) return () => observer?.disconnect();
    const timer = setInterval(() => { if (attach()) clearInterval(timer); }, 250);
    return () => { clearInterval(timer); observer?.disconnect(); };
  }, [requestId]);
  return visible;
}

/** A single Send/Stop control backed by a durable, serialized desktop queue. */
export function Composer({ session, models = EMPTY_MODELS, busy, onSend, onResume, editing, onCancelEdit, onRewound }: ComposerProps) {
  const sessionId = session?.sessionId ?? null;
  const durable = useDurableComposer(sessionId, session?.projectId ?? null);
  const { providers, error: providerError } = useProviderCatalog(models);
  const configuration = useTaskExecutionSettings(sessionId, session ? {
    sessionId: session.sessionId, projectId: session.projectId ?? "", mode: session.model ? "custom" : "auto",
    permission: session.permissionMode === "bypass-permissions" || session.permissionMode === "full" ? "full" : session.permissionMode === "ask" ? "ask" : "approve",
    execution: { provider: session.instanceId?.startsWith("codex") ? "codex" : "claude-code", model: session.model, effort: session.effort ?? null },
    isolated: !!session.worktreePath, baseBranch: session.branch, changes: [],
  } : undefined);
  const settings = configuration.settings;
  const activeProvider = session?.instanceId?.startsWith("codex") ? "codex" : "claude-code";
  const effectiveSelection = settings?.mode === "auto" && settings.execution.provider === activeProvider
    ? { ...settings.execution, model: settings.execution.model ?? session?.model ?? null, effort: settings.execution.effort ?? session?.effort ?? null }
    : settings?.execution;
  /**
   * One field of the snapshot, not the snapshot (`docs/plans/efficiency-plan-review-2026-09-11.md`,
   * "Three whole-snapshot subscribers"). The composer reads `approvals` and nothing else out of
   * the feed store, so a frame that moved rows, a cursor or a session's `busy` no longer wakes it.
   *
   * Still non-optimistic (`docs/vision.md` §9): this is the store's own array, replaced on the
   * frame a `request-opened` or `request-resolved` lands, and the `expired` filter is what keeps a
   * resolved-without-decision row out of the answerable set while leaving it on screen elsewhere.
   */
  const feedApprovals = feedStore.useFeedSelector(selectApprovals);
  const approvals = feedApprovals.filter(item => item.sessionId === sessionId && !item.expired);
  const approvalOnScreen = useApprovalVisible(approvals[0]?.requestId);
  const edit = useMessageEdit({ editing, onCancelEdit, onRewound });
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [commands, setCommands] = useState<ComposerCommand[]>([]);
  const [commandResult, setCommandResult] = useState<string | null>(null);
  const [queueEdit, setQueueEdit] = useState<{ id: string; text: string; execution?: ExecutionSelection } | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const generation = useRef(0);
  const request = useRef<{ id: string; text: string; attachmentIds: string[] } | null>(null);
  useEffect(() => {
    generation.current++; setSending(false); setStopPending(false); setQueueBusy(false);
    setCommands([]); setCommandResult(null); setQueueEdit(null); request.current = null;
    try { request.current = JSON.parse(localStorage.getItem(`composer-request:${sessionId}`) ?? "null"); } catch { /* invalid local retry cache */ }
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void composerApi.commands(sessionId).then(result => { if (!cancelled) setCommands(result); }).catch(error => { if (!cancelled) durable.setError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [sessionId, session?.status, session?.providerSessionId]);
  const live = session !== null && (session.status === "running" || session.status === "starting");
  const text = editing ? edit.text : durable.draft.text;
  const state = durable.state;
  const working = !!session?.busy && !state?.stopped;
  const stopping = !!state?.stopping || stopPending;
  const waiting = state?.waiting;
  const waitingLabel = waiting ? `Waiting for ${waiting.provider} usage${waiting.reset_at !== null ? ` · resets ${new Date(waiting.reset_at * 1000).toLocaleString()}` : " · reset time unknown"}` : null;
  const pending = state?.queue.filter(item => item.status !== "sent") ?? [];
  const apply = async (action: () => Promise<ComposerState>) => {
    if (!sessionId || queueBusy) return;
    const active = generation.current;
    setQueueBusy(true); durable.setError(null);
    try { const next = await serializeComposerWrite(sessionId, action); if (generation.current === active) durable.accept(next); return true; }
    catch (error) { if (generation.current === active) durable.setError(errorMessage(error)); return false; }
    finally { if (generation.current === active) setQueueBusy(false); }
  };
  const send = async () => {
    if (!sessionId || busy || sending || uploading || configuration.saving || (desktop && !settings) || !durable.loaded || (!text.trim() && !durable.draft.attachmentIds.length)) return;
    if (editing) { if (!session?.busy) await edit.submit(); return; }
    const active = generation.current;
    const current = () => generation.current === active;
    setSending(true); durable.setError(null); setCommandResult(null);
    try {
      // Controls are deliberately distinct from ordinary prompt text. Selection only inserts.
      if (/^\s*\/[A-Za-z0-9_:-]+(?:\s|$)/.test(text)) {
        const invocation = text.trim();
        const name = invocation.split(/\s/, 1)[0]!.slice(1);
        const command = commands.find(command => command.name === name);
        if (!command) throw new Error(`/${name} is not supported by this session's adapter.`);
        if (!command.arguments && invocation !== `/${name}`) throw new Error(`/${name} does not accept arguments.`);
        if (durable.draft.attachmentIds.length) throw new Error("Send attachments with a message, not a control command.");
        if (command.execution === "control") {
          const result = await composerApi.executeCommand(sessionId, invocation);
          if (!current()) return;
          if (name === "stop") durable.accept(await composerApi.state(sessionId));
          else setCommandResult(typeof result === "string" ? result : JSON.stringify(result, null, 2));
          durable.clearAccepted(durable.draft); return;
        }
      }
      const draft = { text, attachmentIds: [...durable.draft.attachmentIds] };
      const previous = request.current;
      if (!previous || previous.text !== text || JSON.stringify(previous.attachmentIds) !== JSON.stringify(draft.attachmentIds)) request.current = { ...draft, id: crypto.randomUUID() };
      try { localStorage.setItem(`composer-request:${sessionId}`, JSON.stringify(request.current)); } catch { /* backend queue still owns acknowledgements */ }
      const attemptId = request.current!.id;
      if (!desktop) {
        const accepted = draft.attachmentIds.length ? await onSend(sessionId, text, draft.attachmentIds) : await onSend(sessionId, text);
        if (accepted !== false && current()) durable.clearAccepted(draft);
        return;
      }
      const accepted = await serializeComposerWrite(sessionId, () => composerApi.enqueue(sessionId, attemptId, draft.text, draft.attachmentIds));
      if (current()) {
        durable.accept(accepted);
        durable.clearAccepted(draft);
        if (request.current?.id === attemptId) request.current = null;
      }
      try { localStorage.removeItem(`composer-request:${sessionId}`); } catch { /* optional cache */ }
    } catch (error) {
      // Keep the request id and draft across an uncertain response. Retry uses the same identity.
      if (current()) durable.setError(errorMessage(error));
    } finally { if (current()) setSending(false); }
  };
  const stop = () => { if (sessionId && !stopPending) { const active = generation.current; setStopPending(true); void composerApi.stop(sessionId).then(next => { if (generation.current === active) durable.accept(next); }).catch(error => { if (generation.current === active) durable.setError(errorMessage(error)); }).finally(() => { if (generation.current === active) setStopPending(false); }); } };
  const resume = async () => {
    if (!sessionId || queueBusy) return;
    if (!desktop && !live && session?.providerSessionId) await onResume(sessionId);
    await apply(() => composerApi.resume(sessionId));
  };
  const canResume = !!session && (!!state?.paused || (session.worktreeRemoved && !live) || (!desktop && !!session.providerSessionId && !live));
  return <>
    {/*
      Owner review 2026-09-11, item 4: **the project / environment / branch rail is setup
      information and does not survive the start of a session.**

      "Started" is not a new flag. `Dock` already splits the composer three ways on it
      (`src/components/Dock.tsx`): `startup` → `StartingComposer`, which carries the resolved rail
      while the workspace is still being prepared; `session === null` → `NewSession`, which carries
      the *editable* `TaskSetupRail` because the choices are still open; and otherwise this
      component, which is reached only once a session exists. The same split is already stated on
      the dock element as `.has-session`, and every execution control below passes `started`
      unconditionally for the same reason. So rendering `ResolvedTaskRail` here at all *was* the
      defect — there is no condition to add, only a rail to drop.

      The freed slot is the queue rail's: the queued/pending block below is now the first thing in
      the dock, and its `-9px` bottom margin tucks it into the composer the way the setup rail did.
    */}
    {/*
      The two gauges, in the slot the setup rail vacated.

      **Why here.** Both answer "where do I stand before I press send", which is a question about
      the *next* turn, so they belong against the composer and not in the transcript. The dock is
      also the only surface that is always on screen while a session is live: `SessionCard`'s
      "Context" panel is the other candidate and is the wrong one, because it is a `<details>` that
      collapses below 1500px — a threshold you can only see when you remember to open a drawer is a
      threshold you get surprised by. This strip sits above the queue rail, on the same 12px,
      `--color-input` terms as `.composer-approval-strip`, so the dock reads as one stack of
      session state rather than a new panel.

      It is per-session by construction: `Composer` is the branch `Dock` takes only once a session
      exists (`src/components/Dock.tsx`), so neither gauge can render against a session that has
      not started. `.dock-usage` is the class `thread-context.css:25` already hides inside a
      `.worker-composer` — a worker's sub-composer is not where you read the parent's window.
    */}
    {session && <div className="dock-usage" aria-label="Session usage">
      <SessionContext sessionId={session.sessionId} revision={session.lastEventSeq} busy={session.busy} />
      <UsageWindows sessionId={sessionId} />
    </div>}
    {approvals.length > 0 && !approvalOnScreen && <button type="button" className="composer-approval-strip" onClick={() => document.getElementById(`approval-${approvals[0]!.requestId}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}>Approval needed{approvals.length > 1 ? ` · ${approvals.length}` : ""}<span>View action ↑</span></button>}
    {(pending.length > 0 || state?.paused || state?.stopping || waiting) && <div className="composer-queue" aria-label="Message queue">
      <div className="composer-queue-header"><span>{stopping ? "Stopping task…" : state?.paused ? state.stopped ? "Queue paused because you stopped" : "Queue paused" : waitingLabel ?? `${pending.length} queued message${pending.length === 1 ? "" : "s"}`}</span>{canResume && <Button type="button" variant="ghost" size="sm" disabled={queueBusy || stopping} onClick={() => void resume()}>Continue</Button>}</div>
      {pending.map(item => <div className="composer-queue-row" key={item.id}>
        <span aria-hidden="true">↳</span>
        <div className="composer-queue-copy">
          {queueEdit?.id === item.id ? <><textarea className="composer-queue-edit" aria-label="Edit queued message" value={queueEdit.text} onChange={event => setQueueEdit({ ...queueEdit, text: event.target.value })} /><Button type="button" variant="ghost" size="sm" disabled={queueBusy || (!queueEdit.text.trim() && !item.attachmentIds.length)} onClick={() => { const edited = queueEdit; void apply(() => composerApi.update(sessionId!, item.id, edited.text, item.attachmentIds, edited.execution)).then(ok => { if (ok) setQueueEdit(null); }); }}>Save</Button><Button type="button" variant="ghost" size="sm" onClick={() => setQueueEdit(null)}>Cancel</Button>{queueEdit.execution && <ExecutionControl mode="custom" selection={queueEdit.execution} providers={providers} started onMode={() => {}} disabled={queueBusy} onChange={execution => setQueueEdit({ ...queueEdit, execution })} />}</> : <details><summary>{item.text || `${item.attachmentIds.length} attachment${item.attachmentIds.length === 1 ? "" : "s"}`}</summary><pre>{item.text}</pre>{item.attachmentIds.length > 0 && <small>{item.attachmentIds.length} saved attachment{item.attachmentIds.length === 1 ? "" : "s"}</small>}</details>}
          {item.execution && queueEdit?.id !== item.id && <small>{providerLabel(item.execution.provider)} · {item.execution.model ?? "provider default"}{item.execution.effort ? ` · ${item.execution.effort}` : ""}</small>}
          {item.status !== "queued" && <small>{item.status === "unknown" ? "Delivery unconfirmed. Inspect the conversation before resolving." : item.status === "sending" ? "Sending…" : "Failed"}{item.error ? ` · ${item.error}` : ""}</small>}
          {item.status === "unknown" && <div className="composer-queue-actions"><Button type="button" variant="ghost" size="sm" disabled={queueBusy} onClick={() => void apply(() => composerApi.resolve(sessionId!, item.id, "delivered"))}>Verified delivered</Button><Button type="button" variant="ghost" size="sm" disabled={queueBusy} onClick={() => void apply(() => composerApi.resolve(sessionId!, item.id, "not-delivered"))}>Verified not delivered</Button></div>}
        </div>
        {(item.status === "queued" || item.status === "failed") && <div className="composer-queue-actions">{working && !stopping && <Button type="button" variant="ghost" size="sm" disabled={queueBusy} aria-label="Steer now" onClick={() => void apply(() => composerApi.steer(sessionId!, item.id))}>Steer now</Button>}<Button type="button" variant="ghost" size="sm" disabled={queueBusy} aria-label="Edit queued message" onClick={() => setQueueEdit({ id: item.id, text: item.text, execution: item.execution ?? undefined })}>Edit</Button><Button type="button" variant="ghost" size="sm" className={labelledButtonIcons} disabled={queueBusy} aria-label="Remove queued message" onClick={() => void apply(() => composerApi.remove(sessionId!, item.id))}><X className="size-3.5" /></Button></div>}
      </div>)}
    </div>}
    <PromptInput sessionId={sessionId} attachmentProjectId={session?.projectId} attachments={editing ? [] : durable.attachments} onAttachments={editing ? undefined : durable.setFiles} onUploadChange={setUploading} commands={commands}
      header={<>{editing && <div className="composer-edit-banner"><span>{edit.rewound ? "Conversation rewound · ready to send" : "Editing message"}</span><Button type="button" variant="ghost" size="sm" disabled={edit.busy || Boolean(edit.confirmation)} onClick={onCancelEdit}>Cancel edit</Button></div>}{editing && edit.error && <p role="alert" className="composer-error">{edit.error}</p>}{editing && edit.confirmation}</>}
      value={text} aria-label="Message" placeholder={durable.loaded ? state?.stopped ? "Task stopped · Continue when ready" : working ? "Add a follow-up to the queue" : "Do anything" : "Loading draft…"} focusKey={sessionId ?? undefined}
      disabled={!durable.loaded || busy || sending || (Boolean(editing) && edit.disabled)} onText={editing ? edit.setText : durable.setText}
      onKeyDown={event => { if (isSubmitKey(event)) { event.preventDefault(); void send(); } }}>
      <PromptInputActions className="composer-main-actions">
        {canResume && !state?.paused && <Button type="button" variant="ghost" size="sm" disabled={queueBusy} onClick={() => void resume()}>Continue</Button>}
        {settings && <PermissionControl value={settings.permission} disabled={configuration.saving} onChange={permission => void configuration.update({ ...settings, permission })} />}
        <span className="composer-control-spacer" />
        {settings && effectiveSelection && <><ModeControl value={settings.mode} selection={effectiveSelection} providers={providers} started disabled={configuration.saving} onChange={mode => { if (mode !== settings.mode) void configuration.update({ ...settings, mode, execution: effectiveSelection }); }} />{settings.mode === "custom" && <ExecutionControl selection={effectiveSelection} providers={providers} disabled={configuration.saving} onChange={execution => void configuration.update({ ...settings, execution })} />}</>}
        <Button type="button" variant="ghost" size="icon" className={cn(iconButton, "composer-send")} aria-label={stopping ? "Stopping task" : working ? "Stop task" : sending ? "Preparing message" : editing ? "Send edited message" : "send this turn"}
          title={working ? "Stop task and pause the queue. Press Enter in the editor to queue a follow-up." : "Send · Enter"}
          disabled={stopping || (working ? false : !durable.loaded || busy || sending || uploading || configuration.saving || (desktop && !settings) || (!text.trim() && !durable.draft.attachmentIds.length) || (Boolean(editing) && edit.disabled))}
          onClick={working ? stop : () => void send()}>{working || stopping ? <span className="composer-stop-symbol" /> : sending ? <span className="composer-spinner" /> : <ArrowUp />}</Button>
      </PromptInputActions>
    </PromptInput>
    {(configuration.error || providerError) && <p className="composer-error composer-feedback" role="alert">{configuration.error || providerError}</p>}
    {durable.error && <p className="composer-error mx-auto mt-2 max-w-[780px]" role="alert">{durable.error}</p>}
    {commandResult && <details className="mx-auto mt-2 max-w-[780px] text-xs" open><summary>Command result</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{commandResult}</pre></details>}
  </>;
}
