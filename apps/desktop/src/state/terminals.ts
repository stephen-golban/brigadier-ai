import type { TerminalOutput } from "@/ipc/generated";
import { request } from "@/ipc/client";

/**
 * The sessions' terminals as the app sees them: who listens to which terminal's output, and
 * which terminal each conversation has open, so closing its tab ends its shell.
 */

type Listener = (output: TerminalOutput) => void;

const listeners = new Set<Listener>();
const open = new Map<string, string>();

/** Called for every terminal's output until the returned function is called. */
export function onTerminalOutput(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** From the bridge: a terminal printed something, or its shell ended. */
export function emitTerminalOutput(output: TerminalOutput): void {
  if (output.type === "exited") {
    for (const [conversation, terminal] of open) {
      if (terminal === output.terminalId) open.delete(conversation);
    }
  }
  for (const listener of listeners) listener(output);
}

/** The conversation's terminal is `terminalId` now. */
export function noteTerminal(conversationId: string, terminalId: string): void {
  open.set(conversationId, terminalId);
}

/** Ends the conversation's shell (its Terminal tab closed). */
export function closeTerminal(conversationId: string): void {
  const terminalId = open.get(conversationId);
  if (!terminalId) return;
  open.delete(conversationId);
  request({ method: "closeTerminal", terminalId }).catch((error: unknown) => {
    console.error("closing the terminal failed", error);
  });
}
