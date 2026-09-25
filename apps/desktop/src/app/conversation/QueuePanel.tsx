import {
  ArrowUp,
  DotsHorizontal,
  DotsVertical,
  Pencil,
  Play,
  Trash,
} from "@openai/apps-sdk-ui/components/Icon";
import { memo, type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

import { useAction } from "@/app/conversation/useAction";
import { mentionsIn, type MentionTarget } from "@/app/conversation/Mentions";
import {
  attachmentSummary,
  MessageAttachments,
} from "@/components/assistant-ui/elements/message-attachment";
import {
  MessageQueue,
  MessageQueueHeader,
  MessageQueueItem,
  MessageQueueRunning,
} from "@/components/assistant-ui/elements/message-queue";
import { ghostButton } from "@/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AttachmentRef, QueuedMessage } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import {
  deleteQueued,
  editQueued,
  moveQueued,
  resumeQueue,
  steerQueued,
} from "@/state/actions";
import { useBoard } from "@/state/board";

/** Where a dragged item would land, from the pointer's height over the rows' midpoints. */
function dropIndex(list: HTMLElement, y: number, dragged: number): number {
  const rows = [...list.querySelectorAll<HTMLElement>(":scope > [data-slot=message-queue-item]")];
  let index = 0;
  for (const [position, row] of rows.entries()) {
    if (position === dragged) continue;
    const rect = row.getBoundingClientRect();
    if (y > rect.top + rect.height / 2) index++;
  }
  return index;
}

type Drag = { id: string; from: number; to: number };

/**
 * The message queue above the composer: what waits for the running turn. Queued
 * messages can be steered into the running turn, edited, deleted and dragged into another
 * order. After an interrupt the queue pauses until resumed.
 */
export const QueuePanel = memo(function QueuePanel({
  conversationId,
  targets,
}: {
  conversationId: string;
  targets: readonly MentionTarget[];
}) {
  const queue = useBoard((s) => s.board?.queue);
  const run = useBoard((s) => s.board?.run ?? "idle");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const action = useAction();

  const running = run === "running" || run === "starting";
  const items = queue?.items ?? [];
  if (!queue || (items.length === 0 && !queue.paused)) return null;

  // While dragging, rows show in the order they would drop in.
  const shown = drag
    ? (() => {
        const order = items.filter((item) => item.id !== drag.id);
        const moved = items[drag.from];
        if (moved) order.splice(drag.to, 0, moved);
        return order;
      })()
    : items;

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string, from: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, from, to: from });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || !listRef.current) return;
    const to = dropIndex(listRef.current, event.clientY, shown.findIndex((item) => item.id === drag.id));
    if (to !== drag.to) setDrag({ ...drag, to });
  };
  const endDrag = () => {
    if (!drag) return;
    setDrag(null);
    if (drag.to !== drag.from) {
      action.run(() => moveQueued(conversationId, drag.id, drag.to));
    }
  };

  return (
    <MessageQueue aria-label="Message queue">
      {queue.paused ? (
        <MessageQueueRunning
          active={false}
          label="Queue paused because you interrupted"
          className="border-warning/50"
        >
          <Button
            size="xs"
            onClick={() => action.run(() => resumeQueue(conversationId))}
            disabled={action.busy}
          >
            <Play />
            Resume
          </Button>
        </MessageQueueRunning>
      ) : null}

      {items.length > 0 && (
        <MessageQueueHeader
          start={`${items.length} queued`}
          end={queue.paused ? "paused" : "sends when this turn finishes"}
        />
      )}

      <ol ref={listRef} className="flex flex-col gap-1">
        {shown.map((item, index) =>
          editing === item.id ? (
            <QueueEditor
              key={item.id}
              index={index}
              item={item}
              targets={targets}
              onDone={() => setEditing(null)}
              onSave={(text, attachments) =>
                editQueued(conversationId, item.id, {
                  text,
                  attachments,
                  mentions: mentionsIn(text, targets, item.mentions),
                })
              }
            />
          ) : (
            <MessageQueueItem key={item.id} index={index} dragging={drag?.id === item.id}>
              <button
                type="button"
                aria-label="Drag to reorder"
                title="Drag to reorder"
                className={cn(ghostButton, "size-icon-button-sm cursor-grab touch-none active:cursor-grabbing")}
                onPointerDown={(event) => startDrag(event, item.id, index)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={() => setDrag(null)}
              >
                <DotsVertical className="size-icon-sm" />
              </button>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm" title={item.text}>
                  {item.text || <span className="text-muted-foreground">(attachments only)</span>}
                </span>
                {item.attachments.length > 0 && (
                  <span className="text-muted-foreground truncate text-xs">
                    {attachmentSummary(item.attachments)}
                  </span>
                )}
              </span>
              <TooltipIconButton
                tooltip="Steer"
                size="icon-sm"
                disabled={action.busy || queue.paused || !running}
                onClick={() => action.run(() => steerQueued(conversationId, item.id))}
              >
                <ArrowUp />
              </TooltipIconButton>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="More actions">
                    <DotsHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditing(item.id)}>
                    <Pencil />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={index === 0}
                    onSelect={() => action.run(() => moveQueued(conversationId, item.id, index - 1))}
                  >
                    Move up
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={index === items.length - 1}
                    onSelect={() => action.run(() => moveQueued(conversationId, item.id, index + 1))}
                  >
                    Move down
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => action.run(() => deleteQueued(conversationId, item.id))}
                  >
                    <Trash />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </MessageQueueItem>
          ),
        )}
      </ol>
      {action.error && (
        <p role="alert" className="text-destructive px-1 text-xs">
          {action.error}
        </p>
      )}
    </MessageQueue>
  );
});

/** A queued message being edited: its text and attachments, saved back in place. */
function QueueEditor({
  index,
  item,
  targets,
  onSave,
  onDone,
}: {
  index: number;
  item: QueuedMessage;
  targets: readonly MentionTarget[];
  onSave: (text: string, attachments: AttachmentRef[]) => Promise<void>;
  onDone: () => void;
}) {
  const [text, setText] = useState(item.text);
  const [attachments, setAttachments] = useState(item.attachments);
  const action = useAction();
  const empty = !text.trim() && attachments.length === 0;
  const mentioned = mentionsIn(text, targets, item.mentions).filter(
    (mention) => mention.type === "task",
  ).length;
  return (
    <MessageQueueItem index={index} data-editing className="items-start py-2">
      <form
        className="flex min-w-0 flex-1 flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            await onSave(text.trim(), attachments);
            onDone();
          });
        }}
      >
        <textarea
          autoFocus
          value={text}
          rows={Math.min(8, Math.max(2, text.split("\n").length))}
          aria-label="Edit queued message"
          className="bg-background rounded-control focus-visible:ring-ring/50 w-full resize-none px-2 py-1.5 text-sm outline-none focus-visible:ring-1"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onDone();
          }}
        />
        {attachments.length > 0 && (
          <div className="flex flex-col gap-1">
            <MessageAttachments attachments={attachments} />
            <div className="flex flex-wrap gap-1">
              {attachments.map((attachment) => (
                <Button
                  key={attachment.id}
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))
                  }
                >
                  Remove {attachment.name}
                </Button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {mentioned > 0 && (
            <span className="text-muted-foreground me-auto text-xs">
              Mentions {mentioned} worker{mentioned === 1 ? "" : "s"}
            </span>
          )}
          {action.error && (
            <span role="alert" className="text-destructive me-auto text-xs">
              {action.error}
            </span>
          )}
          <Button type="button" size="xs" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="xs" disabled={action.busy || empty}>
            Save
          </Button>
        </div>
      </form>
    </MessageQueueItem>
  );
}
