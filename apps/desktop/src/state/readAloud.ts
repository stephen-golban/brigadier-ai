import { type SpeechSynthesisAdapter, WebSpeechSynthesisAdapter } from "@assistant-ui/react";
import { useSyncExternalStore } from "react";

/**
 * "Read aloud" under an answer, with the system's voices: one answer at a time, as ChatGPT
 * reads one. Reading another stops the first.
 */

const voice = new WebSpeechSynthesisAdapter();
const listeners = new Set<() => void>();
let current: { id: string; utterance: SpeechSynthesisAdapter.Utterance } | null = null;

function changed(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What is read of an answer's Markdown: its words, not its marks, links or code fences. */
export function spokenText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~`|]/g, "")
    .trim();
}

/** Reads `text` as answer `id`, stopping whatever was being read. */
export function readAloud(id: string, text: string): void {
  current?.utterance.cancel();
  const utterance = voice.speak(spokenText(text));
  current = { id, utterance };
  utterance.subscribe(() => {
    if (utterance.status.type === "ended" && current?.utterance === utterance) {
      current = null;
      changed();
    }
  });
  changed();
}

export function stopReading(): void {
  current?.utterance.cancel();
  current = null;
  changed();
}

/** Whether answer `id` is being read now. */
export function useReading(id: string): boolean {
  return useSyncExternalStore(subscribe, () => current?.id === id);
}
