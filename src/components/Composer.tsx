import { useEffect, useRef, useState } from "react";
import { composerApi, serializeComposerWrite, type ComposerCommand, type ComposerState } from "../composerApi";
import { useDurableComposer } from "./composer/useDurableComposer";
import { desktop, errorMessage } from "../workspaceApi";
import { ComposerActions as PromptInputActions } from "./assistant-ui/elements/composer";
import { Button } from "./controls/button";
import { SessionContext } from "./SessionContext";
import { useMessageEdit, type MessageEditProps } from "./EditMessage";
import { PromptInput } from "./PromptInput";
import { SendIcon } from "./icons";
import { isSubmitKey } from "../keys";
import type { SessionRuntime } from "../feedStore";
import type { SessionId, WorktreeCleanup } from "../wire";

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

/** A single Send/Stop control backed by a durable, serialized desktop queue. */
export function Composer({ session, busy, onSend, onResume, editing, onCancelEdit, onRewound }: ComposerProps) {
  const sessionId = session?.sessionId ?? null;
  const durable = useDurableComposer(sessionId, session?.projectId ?? null);
  const edit = useMessageEdit({ editing, onCancelEdit, onRewound });
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [commands, setCommands] = useState<ComposerCommand[]>([]);
  const [commandResult, setCommandResult] = useState<string | null>(null);
  const [queueEdit, setQueueEdit] = useState<{ id: string; text: string } | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const generation = useRef(0);
  const request = useRef<{ id: string; text: string; attachmentIds: string[] } | null>(null);
  useEffect(() => {
    generation.current++; setSending(false); setQueueBusy(false);
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
  const stopping = !!state?.stopping;
  const waiting = state?.waiting;
  const waitingLabel = waiting ? `Waiting for ${waiting.provider} usage${waiting.reset_at !== null ? ` · resets ${new Date(waiting.reset_at * 1000).toLocaleString()}` : " · reset time unknown"}` : null;
  const pending = state?.queue.filter(item => item.status !== "sent") ?? [];
  const apply = async (action: () => Promise<ComposerState>) => {
    if (!sessionId || queueBusy) return;
    const active = generation.current;
    setQueueBusy(true); durable.setError(null);
    try { const next = await serializeComposerWrite(sessionId, action); if (generation.current === active) durable.accept(next); }
    catch (error) { if (generation.current === active) durable.setError(errorMessage(error)); }
    finally { if (generation.current === active) setQueueBusy(false); }
  };
  const send = async () => {
    if (!sessionId || !live || busy || sending || uploading || !durable.loaded || (!text.trim() && !durable.draft.attachmentIds.length)) return;
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
  const stop = () => { if (sessionId) { const active = generation.current; setQueueBusy(true); void composerApi.stop(sessionId).then(next => { if (generation.current === active) durable.accept(next); }).catch(error => { if (generation.current === active) durable.setError(errorMessage(error)); }).finally(() => { if (generation.current === active) setQueueBusy(false); }); } };
  const resume = async () => {
    if (!sessionId || queueBusy) return;
    if (!desktop && !live && session?.providerSessionId) await onResume(sessionId);
    await apply(() => composerApi.resume(sessionId));
  };
  const canResume = !!session && (!!state?.paused || (!!session.providerSessionId && !live));
  return <>
    {(pending.length > 0 || state?.paused || state?.stopping || waiting) && <div className="composer-queue" aria-label="Message queue">
      <div className="composer-queue-header"><span>{stopping ? "Stopping task…" : state?.paused ? state.stopped ? "Queue paused because you stopped" : "Queue paused" : waitingLabel ?? `${pending.length} queued message${pending.length === 1 ? "" : "s"}`}</span>{canResume && <Button type="button" size="sm" disabled={queueBusy || stopping} onClick={() => void resume()}>▶ Resume</Button>}</div>
      {pending.map(item => <div className="composer-queue-row" key={item.id}>
        <span aria-hidden="true">↳</span>
        <div className="composer-queue-copy">
          {queueEdit?.id === item.id ? <><textarea className="composer-queue-edit" aria-label="Edit queued message" value={queueEdit.text} onChange={event => setQueueEdit({ id: item.id, text: event.target.value })} /><Button type="button" disabled={queueBusy || (!queueEdit.text.trim() && !item.attachmentIds.length)} onClick={() => { const text = queueEdit.text; void apply(() => composerApi.update(sessionId!, item.id, text, item.attachmentIds)).then(() => setQueueEdit(null)); }}>Save</Button><Button type="button" onClick={() => setQueueEdit(null)}>Cancel</Button></> : <details><summary>{item.text || `${item.attachmentIds.length} attachment${item.attachmentIds.length === 1 ? "" : "s"}`}</summary><pre>{item.text}</pre>{item.attachmentIds.length > 0 && <small>{item.attachmentIds.length} saved attachment{item.attachmentIds.length === 1 ? "" : "s"}</small>}</details>}
          {item.status !== "queued" && <small>{item.status === "unknown" ? "Delivery unconfirmed. Inspect the conversation before resolving." : item.status === "sending" ? "Sending…" : "Failed"}{item.error ? ` · ${item.error}` : ""}</small>}
          {item.status === "unknown" && <div className="composer-queue-actions"><Button type="button" disabled={queueBusy} onClick={() => void apply(() => composerApi.resolve(sessionId!, item.id, "delivered"))}>Verified delivered</Button><Button type="button" disabled={queueBusy} onClick={() => void apply(() => composerApi.resolve(sessionId!, item.id, "not-delivered"))}>Verified not delivered</Button></div>}
        </div>
        {(item.status === "queued" || item.status === "failed") && <div className="composer-queue-actions"><Button type="button" disabled={queueBusy} aria-label="Edit queued message" onClick={() => setQueueEdit({ id: item.id, text: item.text })}>Edit</Button><Button type="button" disabled={queueBusy} aria-label="Remove queued message" onClick={() => void apply(() => composerApi.remove(sessionId!, item.id))}>×</Button></div>}
      </div>)}
    </div>}
    <PromptInput sessionId={sessionId} attachmentProjectId={session?.projectId} attachments={editing ? [] : durable.attachments} onAttachments={editing ? undefined : durable.setFiles} onUploadChange={setUploading} commands={commands}
      header={<>{editing && <div className="composer-edit-banner"><span>{edit.rewound ? "Conversation rewound · ready to send" : "Editing message"}</span><Button type="button" disabled={edit.busy || Boolean(edit.confirmation)} onClick={onCancelEdit}>Cancel edit</Button></div>}{editing && edit.error && <p role="alert" className="composer-error">{edit.error}</p>}{editing && edit.confirmation}</>}
      value={text} aria-label="Message" placeholder={durable.loaded ? live ? working ? "Add a follow-up to the queue" : "Do anything" : "Continue this task to send a message" : "Loading draft…"} focusKey={sessionId ?? undefined}
      disabled={!durable.loaded || busy || sending || (Boolean(editing) && edit.disabled)} onText={editing ? edit.setText : durable.setText}
      onKeyDown={event => { if (isSubmitKey(event)) { event.preventDefault(); void send(); } }}>
      <PromptInputActions className="flex-1 flex-wrap justify-end">
        <span className="status-chip text-text-secondary" role="status">{stopping ? "Stopping…" : state?.stopped ? "Stopped" : waitingLabel ? "Waiting for usage" : working ? "Working" : !durable.loaded ? "Loading" : !live ? session?.status : ""}</span>
        {canResume && !state?.paused && <Button type="button" size="sm" disabled={queueBusy} onClick={() => void resume()}>Continue</Button>}
        <span className="grow" />
        {session?.permissionMode && <span className="text-xs text-text-secondary" title="Effective permissions">{session.permissionMode === "bypass-permissions" ? "Full access" : session.permissionMode === "default" ? "Default permissions" : session.permissionMode}</span>}
        {session && <span className="session-model max-w-52 truncate text-xs text-text-secondary" title="Pinned orchestrator model">{session.model ?? "Auto"}{session.effort ? ` · ${session.effort}` : ""}</span>}
        {session && <SessionContext sessionId={session.sessionId} revision={session.lastEventSeq} busy={session.busy} />}
        <Button type="button" size="icon" className="rounded-full" variant="primary" aria-label={stopping ? "Stopping task" : working ? "Stop task" : sending ? "Preparing message" : editing ? "Send edited message" : "send this turn"}
          title={working ? "Stop task and pause the queue. Press Enter in the editor to queue a follow-up." : "Send · Enter"}
          disabled={stopping || (working ? queueBusy : !live || !durable.loaded || busy || sending || uploading || (!text.trim() && !durable.draft.attachmentIds.length) || (Boolean(editing) && edit.disabled))}
          onClick={working ? stop : () => void send()}>{working || stopping ? <span className="composer-stop-symbol" /> : sending ? <span role="status">…</span> : <SendIcon />}</Button>
      </PromptInputActions>
    </PromptInput>
    {durable.error && <p className="composer-error mx-auto mt-2 max-w-[780px]" role="alert">{durable.error}</p>}
    {commandResult && <details className="mx-auto mt-2 max-w-[780px] text-xs" open><summary>Command result</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{commandResult}</pre></details>}
  </>;
}
