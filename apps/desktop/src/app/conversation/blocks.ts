import type { CardType } from "@/app/conversation/cards/CardBody";
import type {
  Approval,
  Message,
  ModelChoice,
  Plan,
  Question,
  RequestState,
  Task,
  UserRequest,
} from "@/ipc/generated";
import type { Board } from "@/state/board";
import type { PendingMessage } from "@/state/store";

/**
 * One user request as the thread shows it: the user's message, then one assistant block with
 * everything the request set in motion (replies, workers, cards), however it interleaved with
 * other requests in the conversation's stream. Requests group by the id the daemon stores on
 * each item, so a reload, a restart or an older page groups exactly the same way.
 */

/** A card or worker in a block, in the order it appeared. */
export type BlockCard = {
  type: CardType;
  id: string;
  position: number;
  /** Shown outside the fold: a decision, a failure, or something that needs the user. */
  keep: boolean;
};

/** A reply of the block, as a text part of the assistant message (by index). */
export type BlockText = {
  messageId: string;
  position: number;
  text: string;
  model: ModelChoice | null;
};

export type BlockState = RequestState["type"];

export type Block = {
  key: string;
  /** The user's message; absent for replies older than any loaded user message. */
  user: { kind: "message"; message: Message; text: string } | { kind: "pending"; pending: PendingMessage } | null;
  texts: BlockText[];
  cards: BlockCard[];
  /** Workers the request started, by task number. */
  tasks: string[];
  state: BlockState;
  error: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
};

/** The parts of the board the blocks depend on (not worker activity or transcripts). */
export type BoardDigest = {
  tasks: Readonly<Record<string, Task>>;
  approvals: Readonly<Record<string, Approval>>;
  questions: Readonly<Record<string, Question>>;
  plans: Readonly<Record<string, Plan>>;
  requests: Readonly<Record<string, UserRequest>>;
  runRequest: string | null;
  streaming: Board["streaming"];
};

const WORKING: ReadonlySet<Task["state"]> = new Set([
  "queued",
  "starting",
  "running",
  "blocked",
  "reviewing",
]);

/** A worker whose card stays in view: it failed, or it waits for the user. */
function keepTask(task: Task): boolean {
  return (
    task.state === "failed" ||
    task.state === "paused" ||
    task.state === "awaitingApproval" ||
    task.state === "readyToLand"
  );
}

function keepApproval(approval: Approval): boolean {
  switch (approval.state.type) {
    case "pending":
      return true;
    case "allowed":
    case "denied":
      return approval.state.by === "user";
    case "expired":
      return false;
  }
}

function keepPlan(plan: Plan): boolean {
  switch (plan.state.type) {
    case "proposed":
    case "inReview":
    case "rejected":
      return true;
    case "approved":
      return plan.state.by === "user";
    case "superseded":
      return false;
  }
}

type Placed =
  | { kind: "message"; position: number; message: Message; text: string }
  | { kind: "card"; position: number; requestId: string | null; card: BlockCard }
  | { kind: "task"; position: number; requestId: string | null; id: string };

/**
 * Groups the loaded messages, the board's cards and the pending sends into blocks, oldest
 * first. Items of a request whose user message is on an older, unloaded page wait for it.
 */
export function buildBlocks(
  messages: readonly Message[],
  fullText: Readonly<Record<string, string>>,
  hasMore: boolean,
  board: BoardDigest,
  pending: readonly PendingMessage[],
): Block[] {
  const placed: Placed[] = messages.map((message) => ({
    kind: "message",
    position: message.seq,
    message,
    text: fullText[message.id] ?? message.text,
  }));
  for (const task of Object.values(board.tasks)) {
    placed.push({ kind: "task", position: task.position, requestId: task.requestId, id: task.id });
    // Routine workers show as chips; one that failed or waits for the user shows its card.
    if (keepTask(task)) {
      placed.push({
        kind: "card",
        position: task.position,
        requestId: task.requestId,
        card: { type: "task", id: task.id, position: task.position, keep: true },
      });
    }
  }
  for (const approval of Object.values(board.approvals)) {
    placed.push({
      kind: "card",
      position: approval.position,
      requestId: approval.requestId,
      card: { type: "approval", id: approval.id, position: approval.position, keep: keepApproval(approval) },
    });
  }
  for (const question of Object.values(board.questions)) {
    placed.push({
      kind: "card",
      position: question.position,
      requestId: question.requestId,
      card: { type: "question", id: question.id, position: question.position, keep: true },
    });
  }
  for (const plan of Object.values(board.plans)) {
    placed.push({
      kind: "card",
      position: plan.position,
      requestId: plan.requestId,
      card: { type: "plan", id: plan.id, position: plan.position, keep: keepPlan(plan) },
    });
  }
  placed.sort((a, b) => a.position - b.position);

  const oldest = messages[0]?.seq ?? Number.POSITIVE_INFINITY;
  const blocks = new Map<string, Block>();
  const order: string[] = [];
  const open = (key: string, startedAtMs: number): Block => {
    let block = blocks.get(key);
    if (!block) {
      const request = board.requests[key];
      block = {
        key,
        user: null,
        texts: [],
        cards: [],
        tasks: [],
        state: request?.state.type ?? "done",
        error: request?.state.type === "failed" ? request.state.error : null,
        startedAtMs: request?.startedAtMs ?? startedAtMs,
        endedAtMs: request?.endedAtMs ?? null,
      };
      blocks.set(key, block);
      order.push(key);
    }
    return block;
  };

  // Items from before requests existed belong to the user message before them.
  let current: string | null = null;
  for (const item of placed) {
    // Anything older than the loaded page waits until that page loads.
    if (hasMore && item.position < oldest) continue;
    if (item.kind === "message") {
      const { message } = item;
      if (message.role === "user") {
        const key = message.requestId ?? message.id;
        current = key;
        open(key, message.createdAtMs).user = { kind: "message", message, text: item.text };
        continue;
      }
      if (message.role === "system") continue;
      const key = message.requestId ?? current ?? `orphan:${message.id}`;
      if (hasMore && message.requestId && !blocks.has(key)) continue;
      open(key, message.createdAtMs).texts.push({
        messageId: message.id,
        position: item.position,
        text: item.text,
        model: message.model,
      });
      continue;
    }
    const key = item.requestId ?? current;
    if (key === null) continue;
    if (hasMore && item.requestId && !blocks.has(key)) continue;
    const block = open(key, 0);
    if (item.kind === "task") block.tasks.push(item.id);
    else block.cards.push(item.card);
  }

  // What streams belongs to the turn's request.
  const streaming = board.streaming;
  if (streaming && !messages.some((message) => message.id === streaming.messageId)) {
    const key = streaming.requestId ?? current;
    const block = key !== null ? blocks.get(key) : undefined;
    block?.texts.push({
      messageId: streaming.messageId,
      position: Number.POSITIVE_INFINITY,
      text: streaming.text,
      model: null,
    });
  }

  const result = order.map((key) => blocks.get(key) as Block);
  // Sent but not yet stored: the bubble, and a block that works on it.
  for (const entry of pending) {
    result.push({
      key: entry.localId,
      user: { kind: "pending", pending: entry },
      texts: [],
      cards: [],
      tasks: [],
      state: "working",
      error: null,
      startedAtMs: entry.createdAtMs,
      endedAtMs: null,
    });
  }
  return result;
}

/** Whether a block still has work running or waiting. */
export function isLive(state: BlockState): boolean {
  return state === "working" || state === "waiting";
}

/** Whether a task still runs (for chips). */
export function isWorking(task: Task): boolean {
  return WORKING.has(task.state);
}
