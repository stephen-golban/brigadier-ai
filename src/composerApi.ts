/** Durable composer contract. The desktop service owns ordering, acknowledgement and recovery. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { desktop } from "./workspaceApi";
import type { ExecutionSelection } from "./taskSettings";
export interface ComposerDraft { text: string; attachmentIds: string[] }
export interface QueuedTurn extends ComposerDraft {
  execution?: ExecutionSelection | null;
  id: string;
  status: "queued" | "sending" | "sent" | "failed" | "unknown";
  turnId: string | null;
  error: string | null;
}
export interface ComposerState {
  sessionId: string;
  revision: number;
  draft: ComposerDraft;
  paused: boolean;
  stopping: boolean;
  stopped: boolean;
  waiting?: { provider: string; instance: string; reset_at: number | null; observed_at: number } | null;
  queue: QueuedTurn[];
}
export interface ComposerCommand {
  name: string;
  description: string;
  arguments: boolean;
  argumentHint?: string;
  execution: "control" | "prompt";
}
export const emptyComposer = (sessionId: string): ComposerState => ({ sessionId, revision: 0, draft: { text: "", attachmentIds: [] }, paused: false, stopping: false, stopped: false, queue: [] });
export const composerApi = {
  state: (sessionId: string): Promise<ComposerState> => desktop ? invoke("composer_state", { sessionId }) : Promise.resolve(emptyComposer(sessionId)),
  saveDraft: (sessionId: string, text: string, attachmentIds: string[]): Promise<ComposerState> => invoke("save_composer_draft", { sessionId, text, attachmentIds }),
  enqueue: (sessionId: string, requestId: string, text: string, attachmentIds: string[]): Promise<ComposerState> => invoke("enqueue_conversation_turn", { sessionId, requestId, text, attachmentIds }),
  update: (sessionId: string, requestId: string, text: string, attachmentIds: string[], execution?: ExecutionSelection): Promise<ComposerState> => invoke("update_queued_turn", { sessionId, requestId, text, attachmentIds, ...(execution ? { execution } : {}) }),
  steer: (sessionId: string, requestId: string): Promise<ComposerState> => invoke("steer_queued_turn", { sessionId, requestId }),
  remove: (sessionId: string, requestId: string): Promise<ComposerState> => invoke("remove_queued_turn", { sessionId, requestId }),
  resolve: (sessionId: string, requestId: string, outcome: "delivered" | "not-delivered"): Promise<ComposerState> => invoke("resolve_queued_turn", { sessionId, requestId, outcome }),
  resume: (sessionId: string): Promise<ComposerState> => invoke("resume_conversation_queue", { sessionId }),
  stop: (sessionId: string): Promise<ComposerState> => invoke("stop_conversation_task", { sessionId }),
  commands: (sessionId: string): Promise<ComposerCommand[]> => desktop ? invoke("composer_commands", { sessionId }) : Promise.resolve([]),
  executeCommand: (sessionId: string, command: string): Promise<unknown> => invoke("execute_composer_command", { sessionId, command }),
  subscribe: (onState: (state: ComposerState) => void): Promise<() => void> => desktop ? listen<ComposerState>("composer-state", event => onState(event.payload)) : Promise.resolve(() => {}),
};

/** Per-session promise chains survive React remounts; draft saves cannot overtake enqueue. */
const writes = new Map<string, Promise<unknown>>();
export function serializeComposerWrite<T>(sessionId: string, write: () => Promise<T>): Promise<T> {
  const previous = writes.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(write);
  writes.set(sessionId, next);
  void next.finally(() => { if (writes.get(sessionId) === next) writes.delete(sessionId); }).catch(() => {});
  return next;
}
