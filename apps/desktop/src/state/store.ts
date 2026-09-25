import { create } from "zustand";

import type {
  AppInfo,
  AttachmentRef,
  Conversation,
  DaemonInfo,
  DaemonMetrics,
  Diagnostics,
  EnvironmentKind,
  EventEnvelope,
  Message,
  ModelChoice,
  PermissionLevel,
  Project,
  ProvidersView,
  RawEntry,
  RawSession,
  Settings,
} from "@/ipc/generated";
import { applyDensity, cachedDensity } from "@/lib/density";

/** What the main area shows. Drafts become real conversations on their first message. */
export type Selection =
  | { type: "none" }
  | { type: "archived" }
  | { type: "conversation"; id: string }
  | { type: "draft"; kind: "chat" }
  | { type: "draft"; kind: "session"; projectId: string };

/**
 * The composer's choices for a conversation that does not exist yet. `null` fields follow
 * the resolution order: the project's remembered choice, then the global default.
 */
export type DraftSetup = {
  /** The project these choices were made for; they reset when the project changes. */
  projectId: string | null;
  environment: EnvironmentKind | null;
  /** Local checkout: the branch commits land on. Absent: the checked-out branch. */
  branch: string | null;
  /** Local checkout, "New branch…": the branch to create from `branch`. */
  newBranch: string | null;
  /** New worktree: the base branch. Absent: the checked-out branch. */
  base: string | null;
  /** New worktree: the session branch's name. Empty: Brigadier names it. */
  sessionBranch: string;
  permission: PermissionLevel | null;
  model: ModelChoice | null;
};

export function emptyDraft(projectId: string | null): DraftSetup {
  return {
    projectId,
    environment: null,
    branch: null,
    newBranch: null,
    base: null,
    sessionBranch: "",
    permission: null,
    model: null,
  };
}

export type ConnectionState = {
  status: "connecting" | "connected" | "disconnected";
  daemon: DaemonInfo | null;
  reason: string | null;
};

/** A sent message not yet confirmed by the daemon. */
export type PendingMessage = {
  localId: string;
  conversationId: string;
  text: string;
  attachments: AttachmentRef[];
  createdAtMs: number;
};

export type Thread = {
  items: Message[];
  hasMore: boolean;
  loading: boolean;
  /** Full text of blob-backed messages, by message id. */
  fullText: Record<string, string>;
};

export type InspectorTab = "events" | "orchestrator" | "processes" | "performance" | "providers";

/** Newest inspector events kept in memory. */
export const INSPECTOR_EVENTS = 500;

/** Newest entries kept per open raw-session transcript; older ones load on demand. */
export const RAW_ENTRIES = 5_000;

/** The loaded part of a raw session's transcript, oldest first. */
export type RawTranscript = {
  entries: RawEntry[];
  hasMore: boolean;
  loading: boolean;
};

/** The Inspector's Providers tab: provider overviews, raw sessions and their transcripts. */
export type ProvidersState = {
  /** Absent until first loaded. */
  view: ProvidersView | null;
  /** The raw session shown, if any. */
  selected: string | null;
  /** Transcripts of the raw sessions opened so far, by session id. */
  transcripts: Record<string, RawTranscript>;
};

export type AppState = {
  info: AppInfo | null;
  connection: ConnectionState;
  catalogLoaded: boolean;
  projects: Record<string, Project>;
  conversations: Record<string, Conversation>;
  settings: Settings;
  threads: Record<string, Thread>;
  pending: PendingMessage[];
  selection: Selection;
  draft: DraftSetup;
  expandedProjects: Record<string, boolean>;
  windowVisible: boolean;
  coldStartMs: number | null;
  /** The summary card pinned at the top right of a session's thread is shown. */
  pinnedSummary: boolean;
  inspector: {
    open: boolean;
    tab: InspectorTab;
    /** Newest first. */
    events: EventEnvelope[];
    metrics: DaemonMetrics | null;
    diagnostics: Diagnostics | null;
  };
  providers: ProvidersState;
};

export const useApp = create<AppState>()(() => ({
  info: null,
  connection: { status: "connecting", daemon: null, reason: null },
  catalogLoaded: false,
  projects: {},
  conversations: {},
  settings: {
    density: cachedDensity(),
    defaultPermission: "approveForMe",
    defaultOrchestrator: null,
    defaultChatModel: null,
    queueEnabled: true,
    hibernateAfterMinutes: 30,
  },
  threads: {},
  pending: [],
  selection: { type: "draft", kind: "chat" },
  draft: emptyDraft(null),
  expandedProjects: {},
  windowVisible: true,
  coldStartMs: null,
  pinnedSummary: true,
  inspector: {
    open: false,
    tab: "events",
    events: [],
    metrics: null,
    diagnostics: null,
  },
  providers: { view: null, selected: null, transcripts: {} },
}));

export const emptyThread: Thread = {
  items: [],
  hasMore: false,
  loading: false,
  fullText: {},
};

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

export function replaceCatalog(
  projects: readonly Project[],
  conversations: readonly Conversation[],
  settings: Settings,
): void {
  applyDensity(settings.density);
  useApp.setState({
    catalogLoaded: true,
    projects: byId(projects),
    conversations: byId(conversations),
    settings,
  });
}

/** Inserts messages into a thread, ordered by seq, without duplicates. */
export function mergeMessages(
  existing: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const known = new Set(existing.map((message) => message.id));
  const added = incoming.filter((message) => !known.has(message.id));
  if (added.length === 0) return existing as Message[];
  return [...existing, ...added].toSorted((a, b) => a.seq - b.seq);
}

/**
 * Folds a batch of committed events into the state in one update, so a burst of events
 * costs one render.
 */
export function applyEvents(envelopes: readonly EventEnvelope[]): void {
  if (envelopes.length === 0) return;
  useApp.setState((state) => {
    let { projects, conversations, threads, pending, settings, providers } = state;
    for (const envelope of envelopes) {
      ({ projects, conversations, threads, pending, settings, providers } = applyEvent(
        envelope,
        { projects, conversations, threads, pending, settings, providers },
      ));
    }
    const newest = envelopes.toReversed();
    const events = [...newest, ...state.inspector.events].slice(
      0,
      INSPECTOR_EVENTS,
    );
    return {
      projects,
      conversations,
      threads,
      pending,
      settings,
      providers,
      inspector: { ...state.inspector, events },
    };
  });
}

type Slice = Pick<
  AppState,
  "projects" | "conversations" | "threads" | "pending" | "settings" | "providers"
>;

/** Adds or replaces a raw session in the list, newest first. */
export function upsertRawSession(
  providers: ProvidersState,
  session: RawSession,
): ProvidersState {
  const view = providers.view;
  if (!view) return providers;
  const index = view.sessions.findIndex((existing) => existing.id === session.id);
  const sessions =
    index === -1
      ? [session, ...view.sessions]
      : view.sessions.map((existing, i) => (i === index ? session : existing));
  return { ...providers, view: { ...view, sessions } };
}

function applyProviderEvent(
  { event, streamSeq, atMs }: EventEnvelope,
  providers: ProvidersState,
): ProvidersState {
  switch (event.type) {
    case "providerChecked": {
      const view = providers.view;
      if (!view) return providers;
      const others = view.providers.filter(
        (overview) => overview.provider !== event.overview.provider,
      );
      const order = ["claude", "codex"];
      const overviews = [...others, event.overview].toSorted(
        (a, b) => order.indexOf(a.provider) - order.indexOf(b.provider),
      );
      return { ...providers, view: { ...view, providers: overviews } };
    }
    case "rawSessionCreated":
      return upsertRawSession(providers, event.session);
    case "rawSessionUpdated": {
      const current = providers.view?.sessions.find((session) => session.id === event.id);
      if (!current) return providers;
      return upsertRawSession(providers, {
        ...current,
        state: event.state,
        nativeId: event.nativeId ?? current.nativeId,
        error: event.error,
        updatedAtMs: atMs,
      });
    }
    case "rawEvent": {
      const transcript = providers.transcripts[event.sessionId];
      const last = transcript?.entries.at(-1);
      if (!transcript || (last && last.streamSeq >= streamSeq)) return providers;
      const entries = [...transcript.entries, { streamSeq, atMs, event: event.event }];
      const trimmed = entries.length > RAW_ENTRIES;
      return {
        ...providers,
        transcripts: {
          ...providers.transcripts,
          [event.sessionId]: {
            ...transcript,
            entries: trimmed ? entries.slice(-RAW_ENTRIES) : entries,
            hasMore: transcript.hasMore || trimmed,
          },
        },
      };
    }
    default:
      return providers;
  }
}

function applyEvent(envelope: EventEnvelope, slice: Slice): Slice {
  const { event, streamSeq } = envelope;
  switch (event.type) {
    case "projectCreated":
      return {
        ...slice,
        projects: { ...slice.projects, [event.project.id]: event.project },
      };
    case "conversationCreated":
      return {
        ...slice,
        conversations: {
          ...slice.conversations,
          [event.conversation.id]: event.conversation,
        },
      };
    case "conversationRenamed":
    case "conversationPinned": {
      const current = slice.conversations[event.id];
      if (!current) return slice;
      const next =
        event.type === "conversationRenamed"
          ? { ...current, title: event.title }
          : { ...current, pinnedAtMs: event.pinnedAtMs };
      return {
        ...slice,
        conversations: { ...slice.conversations, [event.id]: next },
      };
    }
    case "messageAppended": {
      // The store assigns a message's position: its sequence in the conversation stream.
      const message = { ...event.message, seq: streamSeq };
      const id = message.conversationId;
      let { conversations, threads } = slice;
      const conversation = conversations[id];
      if (conversation && conversation.updatedAtMs < message.createdAtMs) {
        conversations = {
          ...conversations,
          [id]: { ...conversation, updatedAtMs: message.createdAtMs },
        };
      }
      const thread = threads[id];
      if (thread) {
        const items = mergeMessages(thread.items, [message]);
        if (items !== thread.items) {
          threads = { ...threads, [id]: { ...thread, items } };
        }
      }
      // The confirmed message replaces its optimistic copy (the event can beat the response).
      const echo = slice.pending.findIndex(
        (entry) =>
          message.role === "user" && entry.conversationId === id && entry.text === message.text,
      );
      const pending =
        echo === -1
          ? slice.pending
          : slice.pending.filter((_, index) => index !== echo);
      return { ...slice, conversations, threads, pending };
    }
    case "projectUpdated":
      return {
        ...slice,
        projects: { ...slice.projects, [event.project.id]: event.project },
      };
    case "conversationSetUp":
    case "conversationLifecycleChanged": {
      const current = slice.conversations[event.id];
      if (!current) return slice;
      const next =
        event.type === "conversationSetUp"
          ? { ...current, setup: event.setup }
          : { ...current, lifecycle: event.lifecycle };
      return {
        ...slice,
        conversations: { ...slice.conversations, [event.id]: next },
      };
    }
    case "conversationDeleted": {
      if (!slice.conversations[event.id]) return slice;
      const { [event.id]: _deleted, ...conversations } = slice.conversations;
      return { ...slice, conversations };
    }
    case "settingsChanged":
      applyDensity(event.settings.density);
      return { ...slice, settings: event.settings };
    case "rawSessionCreated":
    case "rawSessionUpdated":
    case "rawEvent":
    case "providerChecked":
      return { ...slice, providers: applyProviderEvent(envelope, slice.providers) };
    case "probe":
    // The cleanup ledger shows in the event list only.
    case "cleanupRecorded":
    case "cleanupRemoved":
    case "cleanupRequested":
    case "cleanupCompleted":
    // Conversation views (tasks, cards, queue, streaming) and the Inspector's orchestrator
    // log read these themselves.
    case "messageDelta":
    case "runStateChanged":
    case "requestUpdated":
    case "branchSwitched":
    case "workerStepped":
    case "messageRated":
    case "conversationNotice":
    case "taskUpdated":
    case "approvalUpdated":
    case "questionUpdated":
    case "planUpdated":
    case "queueChanged":
    case "workerEvent":
    case "orchestratorLogged":
      return slice;
  }
}

/** Resolves the conversation a selection points at, if any. */
export function selectedConversation(state: AppState): Conversation | null {
  return state.selection.type === "conversation"
    ? (state.conversations[state.selection.id] ?? null)
    : null;
}
