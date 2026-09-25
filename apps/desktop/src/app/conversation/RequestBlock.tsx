import {
  ActionBarPrimitive,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { Check, ChevronRight, Copy, Regenerate } from "@openai/apps-sdk-ui/components/Icon";
import { type FC, lazy, Suspense, useEffect, useState } from "react";

import { AgentChips } from "@/app/conversation/Agents";
import { type BlockCard, type BlockState, isLive, isWorking } from "@/app/conversation/blocks";
import {
  BranchPicker,
  MessageError,
  MessageText,
  StreamingMessageText,
} from "@/components/assistant-ui/thread";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { mono } from "@/components/assistant-ui/elements/surfaces";
import { Badge } from "@/components/ui/badge";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type { ModelChoice } from "@/ipc/generated";
import { formatDuration, formatTime } from "@/lib/format";
import { modelName, sameModel, useModelGroups } from "@/lib/setup";
import { cn } from "@/lib/utils";
import { useBoard } from "@/state/board";

const CardBody = lazy(() => import("@/app/conversation/cards/CardBody"));

/** What an assistant block carries in its message metadata (`custom.block`). */
export type BlockMeta = {
  /** Per text part, in order: the reply's position (infinite while it streams) and model. */
  texts: { position: number; model: ModelChoice | null }[];
  cards: BlockCard[];
  tasks: string[];
  state: BlockState;
  startedAtMs: number;
  endedAtMs: number | null;
  /** The model the user picked, to flag a fallback. */
  picked: ModelChoice | null;
  /** A session's block always says it works; a Chat's only until its reply streams. */
  session: boolean;
  /** The request can be answered again now. */
  rework: boolean;
  /** The request this block answers (the id of its user message). */
  requestId: string;
};

/** Seconds since `from`, ticking while `live`. */
function useElapsed(from: number, to: number | null, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return Math.max(0, (live || to === null ? now : to) - from);
}

function headerLabel(state: BlockState, elapsed: number): string {
  const time = formatDuration(elapsed);
  switch (state) {
    case "working":
      return elapsed < 1000 ? "Working" : `Working for ${time}`;
    case "waiting":
      return `Waiting for you · ${time}`;
    case "done":
      return `Worked for ${time}`;
    case "stopped":
      return `You stopped after ${time}`;
    case "failed":
      return `Failed after ${time}`;
  }
}

/** The row that folds a request's work: "Working for 12s" while live, "Worked for 3m 4s" after. */
const WorkHeader: FC<{
  meta: BlockMeta;
  open: boolean;
  foldable: boolean;
  onToggle: () => void;
}> = ({ meta, open, foldable, onToggle }) => {
  const live = meta.state === "working";
  const elapsed = useElapsed(meta.startedAtMs, meta.endedAtMs, isLive(meta.state));
  const label = headerLabel(meta.state, elapsed);
  const text = (
    <span
      className={cn(
        "text-sm",
        live ? "shimmer motion-reduce:animate-none" : "text-muted-foreground",
        meta.state === "failed" && "text-destructive",
      )}
    >
      {label}
    </span>
  );
  if (!foldable) {
    return (
      <div data-slot="request-work-header" className="flex h-control-sm items-center">
        {text}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-slot="request-work-header"
      aria-expanded={open}
      onClick={onToggle}
      className="group flex h-control-sm items-center gap-1 self-start"
    >
      {text}
      <ChevronRight
        aria-hidden
        className={cn(
          "text-muted-foreground size-icon-xs transition-[rotate,opacity] duration-200 motion-reduce:transition-none",
          open ? "rotate-90" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
      />
    </button>
  );
};

type Entry =
  | { kind: "text"; index: number; position: number }
  | { kind: "card"; card: BlockCard; position: number };

function CardEntry({ card }: { card: BlockCard }) {
  return (
    <div data-slot="request-card">
      <Suspense fallback={null}>
        <CardBody type={card.type} id={card.id} />
      </Suspense>
    </div>
  );
}

/** One reply of the block; text that still streams fades in word by word. */
const ReplyText: FC<{ index: number; streaming: boolean }> = ({ index, streaming }) => (
  <MessagePrimitive.PartByIndex
    index={index}
    components={{ Text: streaming ? StreamingMessageText : MessageText }}
  />
);

/** The last line of a working block: what happens right now ("Thinking", "Delegating…"). */
const ActivityRow: FC<{ requestId: string }> = ({ requestId }) => {
  const label = useBoard((s) => {
    const board = s.board;
    if (!board) return null;
    const turn = board.runRequest === requestId && (board.run === "running" || board.run === "starting");
    if (turn) {
      if (board.doing) return board.doing;
      // Streaming text shows itself.
      return board.streaming?.text ? null : "Thinking";
    }
    const working = Object.values(board.tasks)
      .filter((task) => task.requestId === requestId && isWorking(task))
      .toSorted((a, b) => a.number - b.number);
    const [first] = working;
    if (working.length === 1 && first) return `Waiting for task-${first.number} · ${first.title}`;
    return working.length > 1 ? `Waiting for ${working.length} workers` : null;
  });
  if (!label) return null;
  return (
    <div data-slot="request-activity" className="shimmer truncate text-sm motion-reduce:animate-none">
      {label}
    </div>
  );
};

/**
 * One request's answer, as ChatGPT shows a turn. While the request works (and after it was
 * stopped or failed) its work shows in place, in order: replies, workers and cards, then what
 * happens right now. Once it is done, everything before the answer folds into "Worked for
 * 3m 4s"; the cards that matter (decisions, failures, what needs the user) stay in view.
 */
export const RequestBlock: FC = () => {
  const meta = useAuiState((s) => s.message.metadata.custom["block"]) as BlockMeta | undefined;
  const [open, setOpen] = useState(false);
  if (!meta) return null;

  const live = isLive(meta.state);
  const done = meta.state === "done";
  const last = meta.texts.length - 1;
  const answer = done && last >= 0 ? last : null;
  const sequence: Entry[] = [
    ...meta.texts.map((text, index) => ({ kind: "text" as const, index, position: text.position })),
    ...meta.cards.map((card) => ({ kind: "card" as const, card, position: card.position })),
  ].toSorted((a, b) => a.position - b.position);
  const folded = sequence.filter((entry) =>
    entry.kind === "text" ? entry.index !== answer : !entry.card.keep,
  );
  const kept = meta.cards.filter((card) => card.keep);
  const foldable = done && (folded.length > 0 || meta.tasks.length > 0);
  const header =
    foldable ||
    meta.state === "stopped" ||
    meta.state === "failed" ||
    (live && (meta.session || meta.texts.length === 0));

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      data-state={meta.state}
      className="fade-in animate-in message-contain relative flex flex-col gap-2 px-2 duration-150"
    >
      {header && (
        <WorkHeader meta={meta} open={open} foldable={foldable} onToggle={() => setOpen(!open)} />
      )}
      {done ? (
        <>
          {open && foldable && (
            <div data-slot="request-fold" className="flex flex-col gap-3">
              {meta.tasks.length > 0 && <AgentChips taskIds={meta.tasks} />}
              {folded.map((entry) =>
                entry.kind === "text" ? (
                  <div key={`text:${entry.index}`} className="leading-relaxed wrap-break-word">
                    <ReplyText index={entry.index} streaming={false} />
                  </div>
                ) : (
                  <CardEntry key={`${entry.card.type}:${entry.card.id}`} card={entry.card} />
                ),
              )}
            </div>
          )}
          {kept.map((card) => (
            <CardEntry key={`${card.type}:${card.id}`} card={card} />
          ))}
          {answer !== null && (
            <div
              data-slot="aui_assistant-message-content"
              className="text-foreground leading-relaxed wrap-break-word"
            >
              <ReplyText index={answer} streaming={false} />
            </div>
          )}
        </>
      ) : (
        <div data-slot="request-work" className="flex flex-col gap-3">
          {meta.tasks.length > 0 && <AgentChips taskIds={meta.tasks} />}
          {sequence.map((entry) =>
            entry.kind === "text" ? (
              <div
                key={`text:${entry.index}`}
                data-slot="aui_assistant-message-content"
                className="text-foreground leading-relaxed wrap-break-word"
              >
                <ReplyText
                  index={entry.index}
                  streaming={meta.texts[entry.index]?.position === Number.POSITIVE_INFINITY}
                />
              </div>
            ) : (
              <CardEntry key={`${entry.card.type}:${entry.card.id}`} card={entry.card} />
            ),
          )}
          {meta.state === "working" && <ActivityRow requestId={meta.requestId} />}
        </div>
      )}
      <MessageError />
      {!live && last >= 0 && (
        <AnswerActions
          model={meta.texts[last]?.model ?? null}
          picked={meta.picked}
          rework={meta.rework}
          atMs={meta.endedAtMs}
        />
      )}
    </MessagePrimitive.Root>
  );
};

/**
 * Under the answer: copy it, ask for another answer, move between answers, and which model
 * wrote it (flagged when it was a fallback).
 */
const AnswerActions: FC<{
  model: ModelChoice | null;
  picked: ModelChoice | null;
  rework: boolean;
  atMs: number | null;
}> = ({ model, picked, rework, atMs }) => {
  const answer = useAuiState((s) => {
    const parts = s.message.parts;
    const part = parts[parts.length - 1];
    return part?.type === "text" ? part.text : "";
  });
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const groups = useModelGroups();
  const fellBack = model !== null && picked !== null && !sameModel(picked, model);
  return (
    <ActionBarPrimitive.Root
      autohide="never"
      className="text-muted-foreground animate-in fade-in -ms-1 flex min-h-7.5 items-center gap-1 duration-200"
    >
      <TooltipIconButton tooltip={isCopied ? "Copied" : "Copy"} onClick={() => copyToClipboard(answer)}>
        {isCopied ? (
          <Check className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
        ) : (
          <Copy className="animate-in zoom-in-75 fade-in duration-150" />
        )}
      </TooltipIconButton>
      {rework && (
        <ActionBarPrimitive.Reload asChild>
          <TooltipIconButton tooltip="Try again">
            <Regenerate />
          </TooltipIconButton>
        </ActionBarPrimitive.Reload>
      )}
      <BranchPicker />
      {model && (
        <span className={cn(mono, "flex items-center gap-1.5 ps-1")}>
          {modelName(groups, model)}
          {model.effort && ` · ${model.effort}`}
          {fellBack && (
            <Badge variant="warning" title={`You picked ${modelName(groups, picked)}`}>
              fallback
            </Badge>
          )}
        </span>
      )}
      {atMs !== null && <span className="ps-1 text-xs tabular-nums">{formatTime(atMs)}</span>}
    </ActionBarPrimitive.Root>
  );
};
