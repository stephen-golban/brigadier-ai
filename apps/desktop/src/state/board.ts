import { create } from "zustand";

import type {
  Approval,
  ConversationView,
  EventEnvelope,
  MessageQueue,
  Notice,
  OrchestratorLogEntry,
  Plan,
  ProviderEvent,
  Question,
  RawEntry,
  RunState,
  StreamingMessage,
  Task,
  UserRequest,
} from "@/ipc/generated";

/** Newest entries kept per open worker transcript; older ones load on demand. */
export const WORKER_ENTRIES = 3_000;

/** Newest orchestrator log entries kept for the Inspector. */
export const ORCHESTRATOR_ENTRIES = 5_000;

/** Notices kept per conversation, newest last. */
const NOTICES = 20;

/** The loaded part of a worker's transcript, oldest first. */
export type WorkerTranscript = {
  entries: RawEntry[];
  hasMore: boolean;
  loading: boolean;
};

/**
 * The open conversation's live state: its tasks, cards, queue, run state and streaming text.
 * Only the open conversation has a board, so only its events cost anything.
 */
export type Board = {
  conversationId: string;
  loaded: boolean;
  tasks: Record<string, Task>;
  approvals: Record<string, Approval>;
  questions: Record<string, Question>;
  plans: Record<string, Plan>;
  /** What each user message set in motion, by request id (the message's id). */
  requests: Record<string, UserRequest>;
  queue: MessageQueue;
  run: RunState;
  runError: string | null;
  /** The request the running turn serves. */
  runRequest: string | null;
  /** The last message of the branch the thread shows. */
  head: string | null;
  /** What the orchestrator (or a Chat's model) is doing right now, in a few words. */
  doing: string | null;
  streaming: StreamingMessage | null;
  notices: Notice[];
  /** What each worker is doing right now, in a few words (from its live events). */
  activity: Record<string, string>;
  /** Transcripts of the worker cards opened so far, by task id. */
  transcripts: Record<string, WorkerTranscript>;
};

/** The Inspector's Orchestrator tab: one conversation's orchestrator log. */
export type OrchestratorLog = {
  conversationId: string;
  entries: OrchestratorLogEntry[];
  hasMore: boolean;
  loading: boolean;
};

type BoardState = {
  board: Board | null;
  orchestrator: OrchestratorLog | null;
};

export const useBoard = create<BoardState>()(() => ({ board: null, orchestrator: null }));

const EMPTY_QUEUE: MessageQueue = { items: [], paused: false };

export function emptyBoard(conversationId: string): Board {
  return {
    conversationId,
    loaded: false,
    tasks: {},
    approvals: {},
    questions: {},
    plans: {},
    requests: {},
    queue: EMPTY_QUEUE,
    run: "idle",
    runError: null,
    runRequest: null,
    head: null,
    doing: null,
    streaming: null,
    notices: [],
    activity: {},
    transcripts: {},
  };
}

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

/**
 * Board events that replace an object outright, so applying one again is harmless. A view is
 * read at an unknown point in the event stream, so these are re-applied on top of it.
 */
const REPLAYED = new Set<EventEnvelope["event"]["type"]>([
  "taskUpdated",
  "approvalUpdated",
  "questionUpdated",
  "planUpdated",
  "queueChanged",
  "runStateChanged",
  "requestUpdated",
  "messageAppended",
  "branchSwitched",
]);

/** Conversation view reads in flight, each collecting the board events that arrive meanwhile. */
const viewLoads = new Set<{ conversationId: string; events: EventEnvelope[] }>();

/**
 * Starts collecting a conversation's board events while its view is read. The returned
 * function stops collecting and returns them, to pass to `boardFromView`.
 */
export function collectBoardEvents(conversationId: string): () => EventEnvelope[] {
  const load = { conversationId, events: [] as EventEnvelope[] };
  viewLoads.add(load);
  return () => {
    viewLoads.delete(load);
    return load.events;
  };
}

/**
 * Replaces the board's snapshot with a fresh read, keeping opened transcripts. Events that
 * arrived while it was read are applied again, since the read may predate them.
 */
export function boardFromView(
  view: ConversationView,
  previous: Board | null,
  arrived: readonly EventEnvelope[],
): Board {
  const keep = previous?.conversationId === view.conversation.id ? previous : null;
  const board: Board = {
    conversationId: view.conversation.id,
    loaded: true,
    tasks: byId(view.tasks),
    approvals: byId(view.approvals),
    questions: byId(view.questions),
    plans: byId(view.plans),
    requests: byId(view.requests),
    queue: view.queue,
    run: view.run,
    runError: keep?.runError ?? null,
    runRequest: view.runRequest,
    head: view.head,
    doing: keep?.doing ?? null,
    streaming: view.streaming,
    notices: view.notices.slice(-NOTICES),
    activity: keep?.activity ?? {},
    transcripts: keep?.transcripts ?? {},
  };
  return arrived.reduce(applyToBoard, board);
}

/** A few words on what a worker event shows it doing, or `undefined` to keep the last one. */
function activityOf(event: ProviderEvent): string | null | undefined {
  switch (event.type) {
    case "turnStarted":
      return "Working…";
    case "reasoningDelta":
    case "reasoning":
      return "Thinking…";
    case "messageDelta":
      return "Writing…";
    case "message":
      return event.role === "assistant" ? firstLine(event.text) : undefined;
    case "command":
      return event.command ? `$ ${firstLine(event.command)}` : undefined;
    case "toolCall":
      return event.name;
    case "fileChanges":
      return `Editing ${event.changes.length} file${event.changes.length === 1 ? "" : "s"}`;
    case "approvalRequested":
      return "Waiting for approval";
    case "error":
      return event.error.willRetry ? `Retrying: ${event.error.kind}` : `Error: ${event.error.kind}`;
    case "turnCompleted":
    case "exited":
      return null;
    default:
      return undefined;
  }
}

function firstLine(text: string): string {
  const line = text.trimStart().split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function appendEntry(transcript: WorkerTranscript, entry: RawEntry): WorkerTranscript {
  const last = transcript.entries.at(-1);
  if (last && last.streamSeq >= entry.streamSeq) return transcript;
  const entries = [...transcript.entries, entry];
  // Trim in steps, so a long transcript is not re-sliced (and re-folded) on every event.
  const trimmed = entries.length > WORKER_ENTRIES + WORKER_ENTRIES / 5;
  return {
    ...transcript,
    entries: trimmed ? entries.slice(-WORKER_ENTRIES) : entries,
    hasMore: transcript.hasMore || trimmed,
  };
}

/**
 * Stores an updated task or card at its place in the thread. As in the daemon's board, an
 * object's position is the conversation stream sequence of the event that first recorded it;
 * the event itself doesn't carry it.
 */
function placed<T extends { id: string; position: number }>(
  items: Record<string, T>,
  item: T,
  envelope: EventEnvelope,
  board: Board,
): Record<string, T> {
  const known = items[item.id];
  const position =
    known?.position ??
    (envelope.stream === `conversation:${board.conversationId}` ? envelope.streamSeq : item.position);
  return { ...items, [item.id]: { ...item, position } };
}

function applyToBoard(board: Board, envelope: EventEnvelope): Board {
  const { event, streamSeq, atMs } = envelope;
  switch (event.type) {
    case "messageAppended":
      // A new message continues the branch shown; the final message replaces the text that
      // streamed for it.
      return {
        ...board,
        head: event.message.id,
        streaming: board.streaming?.messageId === event.message.id ? null : board.streaming,
      };
    case "branchSwitched":
      return { ...board, head: event.head };
    case "messageDelta": {
      const current = board.streaming;
      const streaming =
        current?.messageId === event.messageId
          ? { ...current, text: current.text + event.text }
          : { messageId: event.messageId, text: event.text, requestId: board.runRequest };
      return { ...board, streaming };
    }
    case "orchestratorLogged": {
      if (event.entry.type !== "provider") return board;
      const doing = doingOf(event.entry.event, board.doing);
      return doing === board.doing ? board : { ...board, doing };
    }
    case "runStateChanged":
      return {
        ...board,
        doing: event.state === "running" || event.state === "starting" ? board.doing : null,
        run: event.state,
        runError: event.error,
        runRequest: event.requestId,
        // A turn that ended without a final message leaves nothing streaming.
        streaming: event.state === "running" || event.state === "starting" ? board.streaming : null,
      };
    case "conversationNotice":
      return { ...board, notices: [...board.notices, event.notice].slice(-NOTICES) };
    case "taskUpdated":
      return { ...board, tasks: placed(board.tasks, event.task, envelope, board) };
    case "approvalUpdated":
      return { ...board, approvals: placed(board.approvals, event.approval, envelope, board) };
    case "questionUpdated":
      return { ...board, questions: placed(board.questions, event.question, envelope, board) };
    case "planUpdated":
      return { ...board, plans: placed(board.plans, event.plan, envelope, board) };
    case "requestUpdated":
      return { ...board, requests: { ...board.requests, [event.request.id]: event.request } };
    case "queueChanged":
      return { ...board, queue: event.queue };
    case "workerEvent": {
      const { taskId } = event;
      let next = board;
      const activity = activityOf(event.event);
      if (activity !== undefined && (board.activity[taskId] ?? null) !== activity) {
        const { [taskId]: _previous, ...rest } = board.activity;
        next = {
          ...next,
          activity: activity === null ? rest : { ...rest, [taskId]: activity },
        };
      }
      const transcript = board.transcripts[taskId];
      if (transcript) {
        const updated = appendEntry(transcript, { streamSeq, atMs, event: event.event });
        if (updated !== transcript) {
          next = { ...next, transcripts: { ...next.transcripts, [taskId]: updated } };
        }
      }
      return next;
    }
    default:
      return board;
  }
}

/** What a Brigadier tool call or CLI tool of the orchestrator is doing, by tool name. */
const TOOL_DOING: Readonly<Record<string, string>> = {
  delegate_task: "Delegating to a worker",
  message_worker: "Messaging a worker",
  stop_worker: "Stopping a worker",
  ask_user: "Asking you",
  read_report: "Reading a report",
  read_artifact: "Reading a report",
  query_brain: "Checking the project notes",
  propose_plan: "Writing a plan",
  request_approval: "Asking for your approval",
  accept_task: "Accepting a worker's change",
  finish_session: "Finishing the session",
  list_tasks: "Checking on the workers",
  WebSearch: "Searching the web",
  WebFetch: "Reading a web page",
};

/** The orchestrator's current activity after one of its provider events. */
function doingOf(event: ProviderEvent, current: string | null): string | null {
  switch (event.type) {
    case "toolCall": {
      if (event.status !== "inProgress") return null;
      // MCP tools arrive namespaced (`mcp__brigadier__delegate_task`, `brigadier.delegate_task`).
      const name = event.name.split(/__|\./).at(-1) ?? event.name;
      return TOOL_DOING[name] ?? "Using a tool";
    }
    case "reasoning":
    case "message":
    case "turnCompleted":
    case "exited":
      return null;
    default:
      return current;
  }
}

function applyToLog(log: OrchestratorLog, envelope: EventEnvelope): OrchestratorLog {
  const { event, streamSeq, atMs } = envelope;
  if (event.type !== "orchestratorLogged") return log;
  const last = log.entries.at(-1);
  if (last && last.streamSeq >= streamSeq) return log;
  const entries = [...log.entries, { streamSeq, atMs, entry: event.entry }];
  const trimmed = entries.length > ORCHESTRATOR_ENTRIES;
  return {
    ...log,
    entries: trimmed ? entries.slice(-ORCHESTRATOR_ENTRIES) : entries,
    hasMore: log.hasMore || trimmed,
  };
}

/**
 * Routes a batch of events to the open conversation's board and the Inspector's orchestrator
 * log, in one update. Everything else is ignored here: other conversations have no board.
 */
export function applyBoardEvents(envelopes: readonly EventEnvelope[]): void {
  for (const load of viewLoads) {
    const stream = `conversation:${load.conversationId}`;
    for (const envelope of envelopes) {
      if (envelope.stream === stream && REPLAYED.has(envelope.event.type)) {
        load.events.push(envelope);
      }
    }
  }
  const { board, orchestrator } = useBoard.getState();
  if (!board && !orchestrator) return;
  const conversationStream = board ? `conversation:${board.conversationId}` : null;
  const boardLogStream = board ? `orch:${board.conversationId}` : null;
  const orchestratorStream = orchestrator ? `orch:${orchestrator.conversationId}` : null;
  let nextBoard = board;
  let nextLog = orchestrator;
  for (const envelope of envelopes) {
    const { stream } = envelope;
    // The open conversation's own log says what its model is doing right now.
    if (nextBoard && stream === boardLogStream) nextBoard = applyToBoard(nextBoard, envelope);
    if (nextBoard && stream === conversationStream) {
      nextBoard = applyToBoard(nextBoard, envelope);
    } else if (
      nextBoard &&
      stream.startsWith("task:") &&
      nextBoard.tasks[stream.slice("task:".length)]
    ) {
      nextBoard = applyToBoard(nextBoard, envelope);
    } else if (nextLog && stream === orchestratorStream) {
      nextLog = applyToLog(nextLog, envelope);
    }
  }
  if (nextBoard !== board || nextLog !== orchestrator) {
    useBoard.setState({ board: nextBoard, orchestrator: nextLog });
  }
}

/** Updates the open board if it is still the given conversation's. */
export function updateBoard(conversationId: string, update: (board: Board) => Board): void {
  useBoard.setState((state) =>
    state.board?.conversationId === conversationId ? { board: update(state.board) } : state,
  );
}
