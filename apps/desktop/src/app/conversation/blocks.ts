import type { CardType } from "@/app/conversation/cards/CardBody";
import type {
  Approval,
  Compaction,
  CompactionState,
  Message,
  ModelChoice,
  OrchestratorStep,
  OrchestratorStepKind,
  Plan,
  Question,
  RequestState,
  Task,
  UserRequest,
  WorkerStep,
  WorkerStepKind,
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

/** A worker's step in a block ("task-2 finished"), in the order it happened. */
export type BlockStep = {
  taskId: string;
  kind: WorkerStepKind;
  position: number;
};

/** Something the orchestrator did ("Sent message to …"), in the order it happened. */
export type BlockOrchestratorStep = {
  kind: OrchestratorStepKind;
  position: number;
};

/**
 * A Chat's model compacting its context ("Compacting context" → "Context compacted"): in the
 * turn it happened in (`inTurn`, the model compacted on its own), or after the block it
 * followed (the user asked for it between turns).
 */
export type BlockCompaction = {
  id: string;
  inTurn: boolean;
  automatic: boolean;
  state: CompactionState["type"];
  error: string | null;
  position: number;
  startedAtMs: number;
  endedAtMs: number | null;
};

/** A message the user steered into the block's running turn: a bubble inside the block. */
export type BlockSteer = {
  message: Message;
  text: string;
  position: number;
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
  /** Their steps, in order. */
  steps: BlockStep[];
  /** The orchestrator's steps, in order. */
  orchestratorSteps: BlockOrchestratorStep[];
  /** Messages steered into its turn, whose requests it shows too. */
  steers: BlockSteer[];
  /** Compactions in its turn, or after it. */
  compactions: BlockCompaction[];
  /** The requests it shows: its own (the key), then the steered ones. */
  requestIds: string[];
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
  workerSteps: readonly WorkerStep[];
  orchestratorSteps: readonly OrchestratorStep[];
  compactions: Readonly<Record<string, Compaction>>;
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

const FINAL: ReadonlySet<Task["state"]> = new Set(["landed", "done", "rejected", "stopped", "failed"]);

/** Whether a task is over: its worker is gone and it will not run again. */
export function isFinal(task: Task): boolean {
  return FINAL.has(task.state);
}

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
  | { kind: "task"; position: number; requestId: string | null; id: string }
  | { kind: "step"; position: number; requestId: string | null; step: BlockStep; atMs: number }
  | {
      kind: "orchestrator";
      position: number;
      requestId: string | null;
      step: BlockOrchestratorStep;
      atMs: number;
    }
  | {
      kind: "compaction";
      position: number;
      requestId: string | null;
      after: string | null;
      compaction: BlockCompaction;
      atMs: number;
    };

function createdAt(board: BoardDigest, item: Exclude<Placed, { kind: "message" }>): number {
  if (item.kind === "task") return board.tasks[item.id]?.createdAtMs ?? 0;
  if (item.kind === "step" || item.kind === "orchestrator" || item.kind === "compaction") return item.atMs;
  const { type, id } = item.card;
  const card =
    type === "task"
      ? board.tasks[id]
      : type === "approval"
        ? board.approvals[id]
        : type === "question"
          ? board.questions[id]
          : board.plans[id];
  return card?.createdAtMs ?? 0;
}

/**
 * Groups the messages of a branch, the board's cards and the pending sends into blocks, oldest
 * first. Items of a request whose user message is on an older, unloaded page wait for it;
 * items of a request on another branch are not shown.
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
  for (const step of board.workerSteps) {
    placed.push({
      kind: "step",
      position: step.position,
      requestId: step.requestId,
      step: { taskId: step.taskId, kind: step.kind, position: step.position },
      atMs: step.atMs,
    });
  }
  for (const step of board.orchestratorSteps) {
    placed.push({
      kind: "orchestrator",
      position: step.position,
      requestId: step.requestId,
      step: { kind: step.kind, position: step.position },
      atMs: step.atMs,
    });
  }
  for (const compaction of Object.values(board.compactions)) {
    placed.push({
      kind: "compaction",
      position: compaction.position,
      requestId: compaction.requestId,
      after: compaction.after,
      compaction: {
        id: compaction.id,
        inTurn: compaction.requestId !== null,
        automatic: compaction.automatic,
        state: compaction.state.type,
        error: compaction.state.type === "failed" ? compaction.state.error : null,
        position: compaction.position,
        startedAtMs: compaction.startedAtMs,
        endedAtMs: compaction.endedAtMs,
      },
      atMs: compaction.startedAtMs,
    });
  }
  // Workers from before steps were stored show the start they had.
  const stepped = new Set(board.workerSteps.map((step) => step.taskId));
  for (const task of Object.values(board.tasks)) {
    if (stepped.has(task.id)) continue;
    placed.push({
      kind: "step",
      position: task.position,
      requestId: task.requestId,
      step: { taskId: task.id, kind: "started", position: task.position },
      atMs: task.createdAtMs,
    });
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
  // Work from before a request was answered again belongs to its earlier attempt.
  const current = placed.filter(
    (item) =>
      item.kind === "message" ||
      item.requestId === null ||
      createdAt(board, item) >= (board.requests[item.requestId]?.startedAtMs ?? 0),
  );

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
        steps: [],
        orchestratorSteps: [],
        steers: [],
        compactions: [],
        requestIds: [key],
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
  let latest: string | null = null;
  // The block each message of the branch shows in.
  const blockOf = new Map<string, string>();
  for (const item of current) {
    // Anything older than the loaded page waits until that page loads.
    if (hasMore && item.position < oldest) continue;
    if (item.kind === "message") {
      const { message } = item;
      if (message.role === "user") {
        const key = message.requestId ?? message.id;
        latest = key;
        blockOf.set(message.id, key);
        open(key, message.createdAtMs).user = { kind: "message", message, text: item.text };
        continue;
      }
      if (message.role === "system") continue;
      const key = message.requestId ?? latest ?? `orphan:${message.id}`;
      // A request whose message is on an older page, or on a branch not shown.
      if (message.requestId && !blocks.has(key)) continue;
      blockOf.set(message.id, key);
      open(key, message.createdAtMs).texts.push({
        messageId: message.id,
        position: item.position,
        text: item.text,
        model: message.model,
      });
      continue;
    }
    // A compaction between turns follows the answer it came after, on that branch only.
    const key =
      item.kind === "compaction" && item.requestId === null && item.after !== null
        ? (blockOf.get(item.after) ?? null)
        : (item.requestId ?? latest);
    if (key === null) continue;
    if (item.requestId && !blocks.has(key)) continue;
    const block = open(key, 0);
    if (item.kind === "task") block.tasks.push(item.id);
    else if (item.kind === "step") block.steps.push(item.step);
    else if (item.kind === "orchestrator") block.orchestratorSteps.push(item.step);
    else if (item.kind === "compaction") block.compactions.push(item.compaction);
    else block.cards.push(item.card);
  }

  // What streams belongs to the turn's request.
  const streaming = board.streaming;
  if (streaming && !messages.some((message) => message.id === streaming.messageId)) {
    const key = streaming.requestId ?? latest;
    const block = key !== null ? blocks.get(key) : undefined;
    block?.texts.push({
      messageId: streaming.messageId,
      position: Number.POSITIVE_INFINITY,
      text: streaming.text,
      model: null,
    });
  }

  const result = joinSteered(
    order.map((key) => blocks.get(key) as Block),
    board.requests,
  );
  // Sent but not yet stored: the bubble, and a block that works on it.
  for (const entry of pending) {
    result.push({
      key: entry.localId,
      user: { kind: "pending", pending: entry },
      texts: [],
      cards: [],
      tasks: [],
      steps: [],
      orchestratorSteps: [],
      steers: [],
      compactions: [],
      requestIds: [entry.localId],
      state: "working",
      error: null,
      startedAtMs: entry.createdAtMs,
      endedAtMs: null,
    });
  }
  return result;
}

/**
 * A request steered into the running turn of the block just before it joins that block, as
 * ChatGPT shows a follow-up sent while it works: its message becomes a bubble inside the
 * block, its work follows, and the header times from the steer.
 */
function joinSteered(blocks: Block[], requests: BoardDigest["requests"]): Block[] {
  const joined: Block[] = [];
  for (const block of blocks) {
    const into = requests[block.key]?.steeredInto;
    const previous = joined.at(-1);
    if (!into || !previous?.requestIds.includes(into) || block.user?.kind !== "message") {
      joined.push(block);
      continue;
    }
    const texts = [...previous.texts, ...block.texts];
    // The bubble shows after the reply that was streaming when it was sent.
    const after = texts.find((text) => text.messageId === requests[block.key]?.steeredAfter);
    const live = [previous.state, block.state].filter(isLive);
    const state = live.length > 0 ? (live.includes("working") ? "working" : "waiting") : block.state;
    joined[joined.length - 1] = {
      ...previous,
      texts: texts.toSorted((a, b) => a.position - b.position),
      cards: [...previous.cards, ...block.cards],
      tasks: [...previous.tasks, ...block.tasks],
      steps: [...previous.steps, ...block.steps],
      orchestratorSteps: [...previous.orchestratorSteps, ...block.orchestratorSteps],
      compactions: [...previous.compactions, ...block.compactions],
      steers: [
        ...previous.steers,
        {
          message: block.user.message,
          text: block.user.text,
          position: Math.max(block.user.message.seq, after ? after.position + 0.5 : 0),
        },
        ...block.steers,
      ],
      requestIds: [...previous.requestIds, ...block.requestIds],
      state,
      error: state === block.state ? block.error : null,
      startedAtMs: block.startedAtMs,
      endedAtMs:
        live.length > 0 ? null : Math.max(previous.endedAtMs ?? 0, block.endedAtMs ?? 0) || null,
    };
  }
  return joined;
}

/** Whether a block still has work running or waiting. */
export function isLive(state: BlockState): boolean {
  return state === "working" || state === "waiting";
}

/** Whether a task still runs (for chips). */
export function isWorking(task: Task): boolean {
  return WORKING.has(task.state);
}

/** Whether a block has anything to show: a finished block with nothing in it hides. */
export function blockShows(block: Block): boolean {
  return (
    block.texts.length > 0 ||
    block.cards.length > 0 ||
    block.tasks.length > 0 ||
    block.orchestratorSteps.length > 0 ||
    block.compactions.length > 0 ||
    block.state !== "done"
  );
}

/**
 * A message of the thread as assistant-ui sees it: a user message or a request's block, under
 * its parent. Siblings (an edit beside the message it replaced, another answer beside the one
 * it replaced) share a parent.
 */
export type ThreadNode = {
  id: string;
  parentId: string | null;
  kind: "user" | "block";
  block: Block;
  /** The stored message the branch would end at if this node were the last one shown. */
  head: string | null;
};

export type ThreadTree = {
  nodes: ThreadNode[];
  /** The last node of the branch shown. */
  headId: string | null;
};

/**
 * The parent of `messages[at]` on its branch: its own, or (for messages from before branches
 * existed) the message before it. `null` at the start of the conversation; `undefined` when
 * the message before it is on an older page.
 */
function parentOf(messages: readonly Message[], at: number, hasMore: boolean): string | null | undefined {
  const { parentId } = messages[at] as Message;
  if (parentId !== null) return parentId === "" ? null : parentId;
  if (at > 0) return (messages[at - 1] as Message).id;
  return hasMore ? undefined : null;
}

/**
 * A node's sort order, never before its parent's: a message sent while the request before it
 * had not answered yet (queued or steered in) is older than that answer. The sort is stable
 * and parents are pushed first, so a tie keeps the parent ahead.
 */
function under(parent: { order: number } | null, order: number): number {
  return parent ? Math.max(order, parent.order) : order;
}

/**
 * The thread as assistant-ui's message tree. The branch that ends at `head` becomes blocks
 * with everything its requests did; with `branches` (a Chat), each message the user or the
 * model replaced on that branch comes along with its own continuation, so the branch picker
 * can move between them.
 */
export function buildThread(
  messages: readonly Message[],
  fullText: Readonly<Record<string, string>>,
  hasMore: boolean,
  board: BoardDigest & { head: string | null },
  pending: readonly PendingMessage[],
  /**
   * Which other versions the tree carries for the branch picker: a Chat's edits and other
   * answers (`all`), or only a session's edits (`edits`), whose answers keep their work.
   */
  branches: "all" | "edits",
): ThreadTree {
  const index = new Map(messages.map((message, at) => [message.id, at]));
  const children = new Map<string | null, Message[]>();
  messages.forEach((message, at) => {
    const parent = parentOf(messages, at, hasMore);
    if (parent === undefined) return;
    const siblings = children.get(parent);
    if (siblings) siblings.push(message);
    else children.set(parent, [message]);
  });

  // The branch shown, back from its last message as far as the loaded pages go.
  const path: Message[] = [];
  let at = index.get(board.head ?? "") ?? (messages.length > 0 ? messages.length - 1 : undefined);
  while (at !== undefined) {
    path.push(messages[at] as Message);
    const parent = parentOf(messages, at, hasMore);
    const next = parent == null ? undefined : index.get(parent);
    at = next !== undefined && next < at ? next : undefined;
  }
  path.reverse();

  // Each node sorts by its oldest message, so siblings number oldest first ("1/2" is the
  // original) and every parent comes before its children.
  const nodes: { node: ThreadNode; order: number }[] = [];
  const nodeOf = new Map<string, { id: string; order: number }>();
  // A block keeps its id whichever branch is shown: a request's first answer is
  // `request:R`, a later one (answered again) is named after its first reply.
  const blockId = (block: Block, first: string | undefined): string => {
    const oldest = children.get(block.key)?.find((child) => child.role === "assistant")?.id;
    if (first === undefined) return oldest === undefined ? `request:${block.key}` : `request:${block.key}:next`;
    return oldest === undefined || first === oldest ? `request:${block.key}` : `request:${block.key}:${first}`;
  };
  const place = (
    blocks: readonly Block[],
    parent: { id: string; order: number } | null,
  ): { id: string; order: number } | null => {
    for (const block of blocks) {
      if (block.user) {
        const message = block.user.kind === "message" ? block.user.message : null;
        const id = message?.id ?? (block.user.kind === "pending" ? block.user.pending.localId : block.key);
        const order = under(parent, message?.seq ?? Number.POSITIVE_INFINITY);
        nodes.push({ node: { id, parentId: parent?.id ?? null, kind: "user", block, head: message?.id ?? null }, order });
        if (message) nodeOf.set(message.id, { id, order });
        parent = { id, order };
      }
      if (!blockShows(block)) continue;
      const stored = block.texts.filter((text) => index.has(text.messageId));
      const id = blockId(block, stored[0]?.messageId);
      const order = under(parent, stored[0]?.position ?? (parent ? parent.order + 0.5 : 0));
      nodes.push({
        node: {
          id,
          parentId: parent?.id ?? null,
          kind: "block",
          block,
          head: stored.at(-1)?.messageId ?? (block.user?.kind === "message" ? block.user.message.id : null),
        },
        order,
      });
      for (const text of stored) nodeOf.set(text.messageId, { id, order });
      parent = { id, order };
    }
    return parent;
  };
  const headId = place(buildBlocks(path, fullText, hasMore, board, pending), null)?.id ?? null;

  const quiet: BoardDigest =
    branches === "all"
      ? { ...EMPTY_WORK, requests: board.requests }
      : { ...board, runRequest: null, streaming: null };
  for (const message of path) {
    if (branches === "edits" && message.role !== "user") continue;
    const parent = parentOf(messages, index.get(message.id) as number, hasMore);
    if (parent === undefined) continue;
    const parentNode = parent === null ? null : nodeOf.get(parent);
    if (parentNode === undefined) continue;
    const siblings = (children.get(parent) ?? []).filter(
      (other) => other.id !== message.id && other.role === message.role,
    );
    for (const sibling of siblings) {
      // The replaced message and its newest continuation.
      const chain = [sibling];
      for (let kids = children.get(sibling.id); kids?.length; kids = children.get(chain.at(-1)?.id ?? "")) {
        chain.push(kids.at(-1) as Message);
      }
      // Another answer groups under its user message, which the branch shown already has.
      const user = sibling.role === "assistant" && parent !== null ? messages[index.get(parent) as number] : undefined;
      const blocks = buildBlocks(user ? [user, ...chain] : chain, fullText, false, quiet, []).map((block) =>
        settled(user && block.user?.kind === "message" && block.user.message.id === user.id ? { ...block, user: null } : block, chain),
      );
      place(blocks, parentNode);
    }
  }
  return { nodes: nodes.toSorted((a, b) => a.order - b.order).map(({ node }) => node), headId };
}

const EMPTY_WORK: BoardDigest = {
  tasks: {},
  approvals: {},
  questions: {},
  plans: {},
  requests: {},
  workerSteps: [],
  orchestratorSteps: [],
  compactions: {},
  runRequest: null,
  streaming: null,
};

/** A block on a branch the thread does not show: finished, timed by its own replies. */
function settled(block: Block, chain: readonly Message[]): Block {
  const times = chain
    .filter((message) => block.texts.some((text) => text.messageId === message.id))
    .map((message) => message.createdAtMs);
  const user = block.user?.kind === "message" ? block.user.message.createdAtMs : undefined;
  const start = user ?? times[0] ?? block.startedAtMs;
  return { ...block, state: "done", error: null, startedAtMs: start, endedAtMs: times.at(-1) ?? start };
}
