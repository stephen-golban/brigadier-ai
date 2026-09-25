import { useAui, useAuiState } from "@assistant-ui/react";
import { type KeyboardEvent, useCallback, useEffect, useRef } from "react";

import type { BlobAttachmentAdapter } from "@/app/conversation/attachments";
import { loadDraft, saveDraft } from "@/state/drafts";

/** How long the composer rests before its draft is kept. */
const DRAFT_SAVE_MS = 400;
/** Prompts ↑ walks back through, as ChatGPT keeps per thread. */
const HISTORY = 20;

/**
 * Keeps the composer's draft for `scope` (see state/drafts): restores it when the composer
 * opens empty, and saves text and stored attachments once typing rests and when it closes.
 */
export function useComposerDraft(scope: string, attachments: BlobAttachmentAdapter): void {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  // Changes when an attachment is added, stored or removed.
  const held = useAuiState((s) =>
    s.composer.attachments.map((attachment) => `${attachment.id}:${attachment.status.type}`).join(),
  );
  const restored = useRef<string | null>(null);

  useEffect(() => {
    if (restored.current === scope) return;
    restored.current = scope;
    const draft = loadDraft(scope);
    const composer = aui.composer();
    if (!draft || !composer.getState().isEmpty) return;
    composer.setText(draft.text);
    for (const ref of draft.attachments) void composer.addAttachment(attachments.adopt(ref));
  }, [aui, attachments, scope]);

  const keep = useCallback(() => {
    const state = aui.composer().getState();
    saveDraft(scope, state.text, attachments.refsOf(state.attachments));
  }, [aui, attachments, scope]);

  // Once typing rests; an emptied composer (sent or cleared) lets the draft go at once.
  useEffect(() => {
    const timer = setTimeout(keep, text === "" && held === "" ? 0 : DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
  }, [keep, text, held]);

  // Leaving the conversation keeps what was typed last.
  useEffect(() => () => keep(), [keep]);
}

/**
 * ↑ in an empty composer walks back through the conversation's last prompts and ↓ forward
 * again, as ChatGPT's does; editing a recalled prompt stops the walk. Returns whether the key
 * was taken.
 */
export function usePromptHistory(): (event: KeyboardEvent<HTMLTextAreaElement>) => boolean {
  const aui = useAui();
  // How far back the composer shows, and the text it put there.
  const walk = useRef<{ back: number; shown: string } | null>(null);
  return useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
      const composer = aui.composer();
      const state = composer.getState();
      if (walk.current && state.text !== walk.current.shown) walk.current = null;
      if (!walk.current && !(event.key === "ArrowUp" && state.isEmpty)) return false;
      const prompts = aui
        .thread()
        .getState()
        .messages.filter((message) => message.role === "user")
        .map((message) =>
          message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        )
        .filter((prompt) => prompt.trim() !== "")
        .slice(-HISTORY);
      const back = (walk.current?.back ?? -1) + (event.key === "ArrowUp" ? 1 : -1);
      if (back >= prompts.length) return prompts.length > 0;
      const shown = back < 0 ? "" : (prompts[prompts.length - 1 - back] ?? "");
      walk.current = back < 0 ? null : { back, shown };
      composer.setText(shown);
      return true;
    },
    [aui],
  );
}
