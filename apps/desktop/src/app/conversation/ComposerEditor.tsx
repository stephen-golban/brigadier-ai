import { type Unstable_TriggerItem, useAui } from "@assistant-ui/react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import { Chat } from "@openai/apps-sdk-ui/components/Icon";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_NORMAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
} from "lexical";
import { useCallback, useContext, useEffect, useMemo } from "react";

import { WorkerGlyph } from "@/app/conversation/Agents";
import { usePromptHistory } from "@/app/conversation/composerDraft";
import { ComposerTargetContext } from "@/app/conversation/composerTarget";
import { mentionOf } from "@/app/conversation/Mentions";
import { usePullQueued } from "@/app/conversation/QueueCard";
import {
  PASTE_AS_ATTACHMENT_CHARS,
  PASTED_TEXT_NAME,
} from "@/components/assistant-ui/elements/attachment-tile";
import {
  ChipComposerInput,
  chipFormatter,
  type MentionLook,
} from "@/components/assistant-ui/elements/composer-chips";
import { registerInserter, startDictation, stopDictation, useDictation } from "@/state/dictation";
import { NEW_CHAT_SCOPE } from "@/state/drafts";
import { useApp } from "@/state/store";

export type ComposerInputProps = {
  placeholder: string;
  autoFocus: boolean;
  running: boolean;
  /** One line (under an action card): it doesn't grow, it scrolls. */
  line?: boolean;
};

/**
 * The text field (assistant-ui's Lexical input): grows with its text up to a quarter of the
 * window, then scrolls, the top line fading under the edge once scrolled. Mentions, inline
 * code and links show as ChatGPT's chips while the text stays plain.
 */
export default function ComposerEditor({
  placeholder,
  autoFocus,
  running,
  line = false,
}: ComposerInputProps) {
  const target = useContext(ComposerTargetContext);
  const memory = target?.mentions ?? null;
  const targets = target?.targets;
  useEffect(() => memory?.setWorkers(targets ?? []), [memory, targets]);
  // One formatter per memory: a new one would rebuild every chip.
  const formatter = useMemo(
    () => chipFormatter((text, at) => memory?.match(text, at) ?? null),
    [memory],
  );
  const onMention = useCallback(
    (item: Unstable_TriggerItem) => {
      const mention = mentionOf(item);
      if (mention && mention.type !== "task") memory?.record(mention, item.label);
    },
    [memory],
  );
  return (
    <ChipComposerInput
      formatter={formatter}
      mentionLook={mentionLook}
      onMention={onMention}
      line={line}
      placeholder={placeholder}
      autoFocus={autoFocus}
      // Esc stops only on a second press (useEscToStop), as ChatGPT's does.
      cancelOnEscape={false}
      aria-label="Message input"
    >
      <ComposerKeys running={running} />
    </ChipComposerInput>
  );
}

/** A worker's glyph or a conversation's icon on its mention chip; files keep their type's. */
const mentionLook: MentionLook = ({ directiveType, directiveId, label }) => {
  const id = directiveId.slice(directiveId.indexOf(":") + 1);
  if (directiveType === "task") return { icon: <WorkerGlyph taskId={id} />, name: label };
  if (directiveType === "chat") return { icon: <Chat />, name: label };
  return null;
};

/**
 * The composer's keys and paste: ↑ in an empty field edits the last queued message, else
 * walks back through the conversation's prompts (↓ forward); ⌘Enter while the model works
 * does the opposite of the queueing setting, for this message; a long paste becomes a
 * "Pasted text" attachment and pasted files attach, as ChatGPT's do; ⌃⇧D starts dictating at
 * the caret and stops again. The `@` and `/` menus take their keys first.
 */
function ComposerKeys({ running }: { running: boolean }) {
  const [editor] = useLexicalComposerContext();
  const aui = useAui();
  const pull = usePullQueued();
  const target = useContext(ComposerTargetContext);
  const history = usePromptHistory(target?.mentions ?? null);
  const queueEnabled = useApp((s) => s.settings.queueEnabled);
  const owner = target?.conversation?.id ?? NEW_CHAT_SCOPE;
  const dictation = useDictation(owner);
  // Dictated text lands at the caret (or at the end, if the field never had one), spaced
  // from the word before it.
  useEffect(
    () =>
      registerInserter(
        owner,
        (text) =>
          new Promise<void>((resolve) => {
            editor.update(
              () => {
                let selection = $getSelection();
                if (!$isRangeSelection(selection)) {
                  $getRoot().selectEnd();
                  selection = $getSelection();
                }
                if (!$isRangeSelection(selection)) return;
                const node = selection.anchor.getNode();
                const before = $isTextNode(node)
                  ? node.getTextContent().slice(0, selection.anchor.offset)
                  : "";
                selection.insertText(before && !/\s$/.test(before) ? ` ${text}` : text);
              },
              // The composer has the text once the editor has updated: Lexical runs its update
              // listeners, assistant-ui's sync among them, before `onUpdate`. (Not a frame
              // later, since a window in the background may not draw one.)
              { onUpdate: () => resolve() },
            );
            editor.focus();
          }),
      ),
    [editor, owner],
  );
  const dictating = dictation.phase.type === "recording";
  const canDictate = dictation.available && dictation.phase.type !== "transcribing";
  useEffect(() => {
    const arrow = (key: "ArrowUp" | "ArrowDown") => (event: KeyboardEvent) => {
      if (event.isComposing) return false;
      if (key === "ArrowUp" && pull && aui.composer().getState().isEmpty) void pull(-1);
      else if (!history(key)) return false;
      event.preventDefault();
      return true;
    };
    return mergeRegister(
      editor.registerCommand(KEY_ARROW_UP_COMMAND, arrow("ArrowUp"), COMMAND_PRIORITY_NORMAL),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, arrow("ArrowDown"), COMMAND_PRIORITY_NORMAL),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!event?.metaKey || event.shiftKey || event.isComposing) return false;
          event.preventDefault();
          const composer = aui.composer();
          // Queueing on: this one steers; off: this one queues.
          if (running && composer.getState().canSend) composer.send({ steer: queueEnabled });
          return true;
        },
        COMMAND_PRIORITY_NORMAL,
      ),
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => {
          const dictate =
            event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === "KeyD";
          if (!dictate || !canDictate) return false;
          event.preventDefault();
          if (dictating) void stopDictation();
          else void startDictation(owner);
          return true;
        },
        COMMAND_PRIORITY_NORMAL,
      ),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
          const files = [...event.clipboardData.files];
          const text = event.clipboardData.getData("text/plain");
          if (files.length === 0 && text.length < PASTE_AS_ATTACHMENT_CHARS) return false;
          event.preventDefault();
          const attach =
            files.length > 0 ? files : [new File([text], PASTED_TEXT_NAME, { type: "text/plain" })];
          const composer = aui.composer();
          for (const file of attach) void composer.addAttachment(file);
          return true;
        },
        COMMAND_PRIORITY_NORMAL,
      ),
    );
  }, [editor, aui, pull, history, running, queueEnabled, owner, canDictate, dictating]);
  return null;
}
