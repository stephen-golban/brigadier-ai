import {
  ComposerPrimitive,
  unstable_useMentionAdapter,
  type Unstable_DirectiveFormatter,
  type Unstable_DirectiveSegment,
  type Unstable_Mention,
} from "@assistant-ui/react";
import type { FC } from "react";

import { floatingMenu, mono } from "@/components/assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";

/** A worker the composer can @-mention. */
export type MentionTarget = { id: string; number: number; title: string; state: string };

const MENTION = /@task-(\d+)\b/g;

/** Mentions are plain `@task-N` text, so they read naturally in the message and the queue. */
const taskFormatter: Unstable_DirectiveFormatter = {
  serialize: (item) => `@${item.label}`,
  parse(text) {
    const segments: Unstable_DirectiveSegment[] = [];
    let last = 0;
    for (const match of text.matchAll(MENTION)) {
      if (match.index > last) segments.push({ kind: "text", text: text.slice(last, match.index) });
      const label = match[0].slice(1);
      segments.push({ kind: "mention", type: "task", label, id: label });
      last = match.index + match[0].length;
    }
    if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
    return segments;
  },
};

/** The task ids a message mentions, from its `@task-N` text. */
export function mentionedTasks(text: string, targets: readonly MentionTarget[]): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    const target = targets.find((entry) => entry.number === Number(match[1]));
    if (target) ids.add(target.id);
  }
  return [...ids];
}

/**
 * The Mentions element (assistant-ui's composer trigger popover), on Brigadier's tokens: `@`
 * lists the conversation's workers and inserts `@task-N`. Render it inside
 * `ComposerPrimitive.Unstable_TriggerPopoverRoot`, next to the composer.
 */
export const ComposerMentions: FC<{ targets: readonly MentionTarget[] }> = ({ targets }) => {
  const items: Unstable_Mention[] = targets.map((target) => ({
    id: target.id,
    type: "task",
    label: `task-${target.number}`,
    description: target.title,
    metadata: { state: target.state },
  }));
  const mention = unstable_useMentionAdapter({
    items,
    includeModelContextTools: false,
    formatter: taskFormatter,
  });
  return (
    <ComposerPrimitive.Unstable_TriggerPopover char="@" adapter={mention.adapter}>
      <ComposerPrimitive.Unstable_TriggerPopover.Directive
        formatter={mention.directive.formatter}
        onInserted={mention.directive.onInserted}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(matches) => (
          <div
            data-slot="composer-mentions"
            className={cn(floatingMenu, "absolute start-0 bottom-full z-20 mb-2 w-full max-w-sm")}
          >
            <p className="text-muted-foreground px-2 py-1 text-xs">Mention a worker</p>
            {matches.map((item, index) => (
              <ComposerPrimitive.Unstable_TriggerPopoverItem
                key={item.id}
                item={item}
                index={index}
                className="data-highlighted:bg-accent hover:bg-accent rounded-control flex w-full items-center gap-2.5 px-2 py-1.5 text-start text-sm outline-none"
              >
                <span className={cn(mono, "text-muted-foreground shrink-0")}>@{item.label}</span>
                <span className="min-w-0 flex-1 truncate">{item.description}</span>
                <span className={cn(mono, "text-muted-foreground shrink-0")}>
                  {typeof item.metadata?.state === "string" ? item.metadata.state : ""}
                </span>
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ))}
            {matches.length === 0 && (
              <p className="text-muted-foreground px-2 py-1.5 text-sm">
                {targets.length === 0 ? "No workers in this conversation yet." : "No matching worker."}
              </p>
            )}
          </div>
        )}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
};
