import {
  ActionBarPrimitive,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  Branch,
  Check,
  ChevronRight,
  Copy,
  Regenerate,
} from "@openai/apps-sdk-ui/components/Icon";
import { type FC, lazy, Suspense, useEffect, useState } from "react";

import { WorkerStepRow } from "@/app/conversation/Agents";
import { ForkMenu } from "@/app/conversation/ForkMenu";
import { OrchestratorSteps } from "@/app/conversation/OrchestratorSteps";
import {
  type BlockCard,
  type BlockOrchestratorStep,
  type BlockState,
  type BlockStep,
  isFinal,
  isLive,
  isWorking,
} from "@/app/conversation/blocks";
import {
  BranchPicker,
  MessageError,
  MessageText,
  StreamingMessageText,
} from "@/components/assistant-ui/thread";
import { RateItem, RateMenu } from "@/components/assistant-ui/rate-menu";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useNow } from "@/hooks/use-now";
import type { ModelChoice } from "@/ipc/generated";
import { formatDuration, formatSentAt } from "@/lib/format";
import { modelName, sameModel, useModelGroups } from "@/lib/setup";
import { cn } from "@/lib/utils";
import { openConversation } from "@/state/actions";
import { useBoard } from "@/state/board";
import { selectedConversation, useApp } from "@/state/store";

const CardBody = lazy(() => import("@/app/conversation/cards/CardBody"));

/** What an assistant block carries in its message metadata (`custom.block`). */
export type BlockMeta = {
  /** Per text part, in order: the reply's position (infinite while it streams) and model. */
  texts: { position: number; model: ModelChoice | null }[];
  cards: BlockCard[];
  /** The workers' steps, in order. */
  steps: BlockStep[];
  /** The orchestrator's steps, in order. */
  orchestratorSteps: BlockOrchestratorStep[];
  /** Messages the user steered into the turn, shown as bubbles in the work. */
  steers: { position: number; text: string; atMs: number }[];
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
  /** It and the requests steered into it. */
  requestIds: string[];
  /** The message the user rates: the block's last reply. */
  answerId: string | null;
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

/** A live turn shows no header until it has worked this long (only "Thinking"), as ChatGPT. */
const HEADER_AFTER_MS = 2000;

/**
 * The row over a request's work, with a rule under it: "Working for 12s" while live, "Worked
 * for 3m 4s ›" once its work folds.
 */
const WorkHeader: FC<{
  meta: BlockMeta;
  open: boolean;
  foldable: boolean;
  onToggle: () => void;
}> = ({ meta, open, foldable, onToggle }) => {
  const elapsed = useElapsed(meta.startedAtMs, meta.endedAtMs, isLive(meta.state));
  if (meta.state === "working" && !foldable && elapsed < HEADER_AFTER_MS) return null;
  const label = headerLabel(meta.state, elapsed);
  const text = (
    <span
      className={cn(
        "text-sm",
        meta.state === "failed" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
  if (!foldable) {
    return (
      <div
        data-slot="request-work-header"
        className="border-border flex h-control-sm items-center border-b"
      >
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
      className="group border-border flex h-control-sm items-center gap-1 border-b text-start"
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
  | { kind: "card"; card: BlockCard; position: number }
  | { kind: "steer"; text: string; atMs: number; position: number }
  | { kind: "orchestrator"; steps: BlockOrchestratorStep[]; position: number }
  | { kind: "steps"; step: BlockStep["kind"]; taskIds: string[]; position: number };

/** The block's replies, cards and worker steps in order; adjacent steps of a kind share a row. */
function blockSequence(meta: BlockMeta): Entry[] {
  const entries: Entry[] = [
    ...meta.texts.map((text, index) => ({ kind: "text" as const, index, position: text.position })),
    ...meta.cards.map((card) => ({ kind: "card" as const, card, position: card.position })),
    ...meta.steers.map((steer) => ({ kind: "steer" as const, ...steer })),
    ...meta.orchestratorSteps.map((step) => ({
      kind: "orchestrator" as const,
      steps: [step],
      position: step.position,
    })),
    ...meta.steps.map((step) => ({
      kind: "steps" as const,
      step: step.kind,
      taskIds: [step.taskId],
      position: step.position,
    })),
  ].toSorted((a, b) => a.position - b.position);
  const merged: Entry[] = [];
  for (const entry of entries) {
    const previous = merged.at(-1);
    if (entry.kind === "steps" && previous?.kind === "steps" && previous.step === entry.step) {
      for (const id of entry.taskIds) if (!previous.taskIds.includes(id)) previous.taskIds.push(id);
    } else if (entry.kind === "orchestrator" && previous?.kind === "orchestrator") {
      previous.steps.push(...entry.steps);
    } else merged.push(entry);
  }
  return merged;
}

function entryKey(entry: Entry): string {
  switch (entry.kind) {
    case "text":
      return `text:${entry.index}`;
    case "card":
      return `${entry.card.type}:${entry.card.id}`;
    case "steer":
      return `steer:${entry.position}`;
    case "orchestrator":
      return `orchestrator:${entry.position}`;
    case "steps":
      return `steps:${entry.position}`;
  }
}

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

/** A reply, card or row of worker steps in the block's work. */
const SequenceEntry: FC<{ entry: Entry; streaming: boolean }> = ({ entry, streaming }) => {
  switch (entry.kind) {
    case "text":
      return (
        <div
          data-slot="aui_assistant-message-content"
          className="text-foreground leading-relaxed wrap-break-word"
        >
          <ReplyText index={entry.index} streaming={streaming} />
        </div>
      );
    case "card":
      return <CardEntry card={entry.card} />;
    case "steer":
      return <SteerBubble text={entry.text} atMs={entry.atMs} />;
    case "orchestrator":
      return <OrchestratorSteps steps={entry.steps} />;
    case "steps":
      return <WorkerStepRow kind={entry.step} taskIds={entry.taskIds} />;
  }
};

/** A follow-up the user sent while the block worked: their bubble, inside the block. */
const SteerBubble: FC<{ text: string; atMs: number }> = ({ text, atMs }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const now = useNow(60_000);
  return (
    <div
      data-slot="request-steer"
      className="group/steer flex max-w-7/10 min-w-0 flex-col items-end gap-y-1 self-end"
    >
      <div className="bg-muted text-foreground rounded-thread px-4 py-2 whitespace-pre-wrap wrap-break-word">
        {text}
      </div>
      <div className="text-muted-foreground flex items-center gap-1 opacity-0 transition-opacity group-hover/steer:opacity-100 group-focus-within/steer:opacity-100">
        <span className="pe-1 text-xs tabular-nums">{formatSentAt(atMs, now)}</span>
        <TooltipIconButton tooltip={isCopied ? "Copied" : "Copy"} onClick={() => copyToClipboard(text)}>
          {isCopied ? <Check /> : <Copy />}
        </TooltipIconButton>
      </div>
    </div>
  );
};

/** The last line of a working block: what happens right now ("Thinking", "Delegating…"). */
const ActivityRow: FC<{ requestIds: string[] }> = ({ requestIds }) => {
  const label = useBoard((s) => {
    const board = s.board;
    if (!board) return null;
    const turn =
      board.runRequest !== null &&
      requestIds.includes(board.runRequest) &&
      (board.run === "running" || board.run === "starting");
    if (turn) {
      if (board.doing) return board.doing;
      // Streaming text shows itself.
      return board.streaming?.text ? null : "Thinking";
    }
    const working = Object.values(board.tasks)
      .filter((task) => task.requestId !== null && requestIds.includes(task.requestId) && isWorking(task))
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
  const requestIds = meta?.requestIds;
  const workersActive = useBoard((s) =>
    Object.values(s.board?.tasks ?? {}).some(
      (task) => task.requestId !== null && !!requestIds?.includes(task.requestId) && !isFinal(task),
    ),
  );
  if (!meta) return null;

  const live = isLive(meta.state);
  const last = meta.texts.length - 1;
  // The final answer is streaming: the workers it waited for are all over. The work folds now,
  // as ChatGPT folds when its final answer starts.
  const answering =
    meta.state === "working" &&
    meta.steps.length > 0 &&
    !workersActive &&
    meta.texts[last]?.position === Number.POSITIVE_INFINITY;
  const done = meta.state === "done" || answering;
  const answer = done && last >= 0 ? last : null;
  const sequence = blockSequence(meta);
  const folded = sequence.filter((entry) =>
    entry.kind === "text"
      ? entry.index !== answer
      : entry.kind !== "card" || !entry.card.keep,
  );
  const kept = meta.cards.filter((card) => card.keep);
  const foldable = done && folded.length > 0;
  const header =
    foldable ||
    meta.state === "stopped" ||
    meta.state === "failed" ||
    (live && (meta.session || meta.texts.length === 0 || meta.steers.length > 0));

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      data-state={meta.state}
      className="group/answer fade-in animate-in message-contain relative flex flex-col gap-2 px-2 duration-150"
    >
      <ModelChanged model={meta.texts[last]?.model ?? null} picked={meta.picked} />
      {header && (
        <WorkHeader meta={meta} open={open} foldable={foldable} onToggle={() => setOpen(!open)} />
      )}
      {done ? (
        <>
          {open && foldable && (
            <div data-slot="request-fold" className="flex flex-col gap-3">
              {folded.map((entry) => (
                <SequenceEntry key={entryKey(entry)} entry={entry} streaming={false} />
              ))}
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
              <ReplyText index={answer} streaming={answering} />
            </div>
          )}
        </>
      ) : (
        <div data-slot="request-work" className="flex flex-col gap-3">
          {sequence.map((entry) => (
            <SequenceEntry
              key={entryKey(entry)}
              entry={entry}
              streaming={
                entry.kind === "text" &&
                meta.texts[entry.index]?.position === Number.POSITIVE_INFINITY
              }
            />
          ))}
          {meta.state === "working" && <ActivityRow requestIds={meta.requestIds} />}
        </div>
      )}
      <MessageError />
      {!live && last >= 0 && (
        <AnswerActions
          session={meta.session}
          rework={meta.rework}
          atMs={meta.endedAtMs}
          answerId={meta.answerId}
        />
      )}
      <ContinuedFrom answerId={meta.answerId} />
    </MessagePrimitive.Root>
  );
};

/** ChatGPT's line when a turn ran on another model than the one picked (a fallback). */
const ModelChanged: FC<{ model: ModelChoice | null; picked: ModelChoice | null }> = ({
  model,
  picked,
}) => {
  const groups = useModelGroups();
  if (!model || !picked || sameModel(picked, model)) return null;
  return (
    <p className="text-muted-foreground text-sm">
      Model changed from {modelName(groups, picked)} to {modelName(groups, model)}.
    </p>
  );
};

/**
 * Under the answer, always shown: copy it, rate it and, in a Chat, ask for another answer and move
 * between answers (a session's answers have neither, as in ChatGPT's Codex mode); when it
 * came shows on hover.
 */
const AnswerActions: FC<{
  session: boolean;
  rework: boolean;
  atMs: number | null;
  answerId: string | null;
}> = ({ session, rework, atMs, answerId }) => {
  const conversation = useApp(selectedConversation);
  const answer = useAuiState((s) => {
    const parts = s.message.parts;
    const part = parts[parts.length - 1];
    return part?.type === "text" ? part.text : "";
  });
  const rated = useAuiState((s) => {
    const type = s.message.metadata.submittedFeedback?.type;
    return type === "positive" ? "good" : type === "negative" ? "bad" : null;
  });
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const now = useNow(60_000);
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
      <RateMenu rated={rated}>
        <ActionBarPrimitive.FeedbackPositive asChild>
          <RateItem rating="good" />
        </ActionBarPrimitive.FeedbackPositive>
        <ActionBarPrimitive.FeedbackNegative asChild>
          <RateItem rating="bad" />
        </ActionBarPrimitive.FeedbackNegative>
      </RateMenu>
      {!session && rework && (
        <ActionBarPrimitive.Reload asChild>
          <TooltipIconButton tooltip="Try again">
            <Regenerate />
          </TooltipIconButton>
        </ActionBarPrimitive.Reload>
      )}
      {!session && <BranchPicker />}
      {conversation && answerId && (
        <ForkMenu conversationId={conversation.id} kind={conversation.kind} messageId={answerId} />
      )}
      {atMs !== null && (
        <span className="ps-1 text-xs tabular-nums opacity-0 transition-opacity group-hover/answer:opacity-100 group-focus-within/answer:opacity-100">
          {formatSentAt(atMs, now)}
        </span>
      )}
    </ActionBarPrimitive.Root>
  );
};

/** "⑂ Continued from chat" under the answer a fork was made from: back to where it came from. */
const ContinuedFrom: FC<{ answerId: string | null }> = ({ answerId }) => {
  const origin = useApp((s) => selectedConversation(s)?.forkedFrom ?? null);
  const source = useApp((s) => (origin ? s.conversations[origin.conversationId] : undefined));
  if (!origin || !answerId || origin.messageId !== answerId) return null;
  return (
    <div className="text-muted-foreground flex items-center gap-3 py-2 text-sm">
      <span className="bg-border h-px flex-1" />
      {source ? (
        <button
          type="button"
          onClick={() => openConversation(source.id)}
          className="text-link hover:text-link/80 flex items-center gap-1.5"
        >
          <Branch className="size-icon-sm" />
          Continued from chat
        </button>
      ) : (
        <span className="flex items-center gap-1.5">
          <Branch className="size-icon-sm" />
          Continued from chat
        </span>
      )}
      <span className="bg-border h-px flex-1" />
    </div>
  );
};
