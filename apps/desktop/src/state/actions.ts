import { request } from "@/ipc/client";
import type {
  Access,
  ApprovalDecision,
  Conversation,
  Density,
  Project,
  ProviderKind,
  RawApprovals,
  RawSession,
} from "@/ipc/generated";
import { applyDensity } from "@/lib/density";
import {
  emptyThread,
  mergeMessages,
  replaceCatalog,
  type InspectorTab,
  type ProvidersState,
  type RawTranscript,
  type Selection,
  type Thread,
  upsertRawSession,
  useApp,
} from "@/state/store";

/** Messages shown when a conversation opens; older ones load on demand. */
const PAGE = 200;

function updateThread(id: string, update: (thread: Thread) => Thread): void {
  useApp.setState((state) => ({
    threads: {
      ...state.threads,
      [id]: update(state.threads[id] ?? emptyThread),
    },
  }));
}

export async function loadCatalog(): Promise<void> {
  const { catalog } = await request({ method: "getCatalog" });
  replaceCatalog(catalog.projects, catalog.conversations, catalog.settings);
}

/** Loads the newest page of a conversation, replacing what was loaded. */
export async function loadMessages(id: string): Promise<void> {
  updateThread(id, (thread) => ({ ...thread, loading: true }));
  try {
    const { page } = await request({
      method: "listMessages",
      conversationId: id,
      before: null,
      limit: PAGE,
    });
    const newest = page.messages.at(-1)?.seq ?? 0;
    updateThread(id, (thread) => ({
      ...thread,
      // Keep only what the live feed delivered after the page was read. Older items may be
      // stale (e.g. after missing events) and would leave a gap below this page.
      items: mergeMessages(
        page.messages,
        thread.items.filter((message) => message.seq > newest),
      ),
      hasMore: page.hasMore,
      loading: false,
    }));
  } catch (error) {
    updateThread(id, (thread) => ({ ...thread, loading: false }));
    throw error;
  }
}

export async function loadEarlier(id: string): Promise<void> {
  const thread = useApp.getState().threads[id];
  const oldest = thread?.items[0];
  if (!thread || !oldest || thread.loading) return;
  updateThread(id, (current) => ({ ...current, loading: true }));
  try {
    const { page } = await request({
      method: "listMessages",
      conversationId: id,
      before: oldest.seq,
      limit: PAGE,
    });
    updateThread(id, (current) => ({
      ...current,
      items: mergeMessages(current.items, page.messages),
      hasMore: page.hasMore,
      loading: false,
    }));
  } catch (error) {
    updateThread(id, (current) => ({ ...current, loading: false }));
    throw error;
  }
}

/** Blob reads in flight, by message id, so each full text is requested once. */
const fullTextLoading = new Set<string>();

/** Fetches the full text of a message whose body lives in the blob store. */
export async function loadFullText(
  conversationId: string,
  messageId: string,
  hash: string,
): Promise<void> {
  if (fullTextLoading.has(messageId)) return;
  fullTextLoading.add(messageId);
  try {
    const { text } = await request({ method: "readBlobText", hash });
    updateThread(conversationId, (thread) => ({
      ...thread,
      fullText: { ...thread.fullText, [messageId]: text },
    }));
  } finally {
    fullTextLoading.delete(messageId);
  }
}

export function select(selection: Selection): void {
  useApp.setState({ selection });
  if (selection.type === "conversation") {
    const thread = useApp.getState().threads[selection.id];
    if (!thread) void loadMessages(selection.id);
  }
}

export function openConversation(id: string): void {
  const conversation = useApp.getState().conversations[id];
  if (conversation?.projectId) setProjectExpanded(conversation.projectId, true);
  select({ type: "conversation", id });
}

export function setProjectExpanded(id: string, expanded: boolean): void {
  useApp.setState((state) => ({
    expandedProjects: { ...state.expandedProjects, [id]: expanded },
  }));
}

export async function createProject(name: string): Promise<Project> {
  const { project } = await request({ method: "createProject", name });
  useApp.setState((state) => ({
    projects: { ...state.projects, [project.id]: project },
  }));
  setProjectExpanded(project.id, true);
  return project;
}

function storeConversation(conversation: Conversation): void {
  useApp.setState((state) => ({
    conversations: { ...state.conversations, [conversation.id]: conversation },
  }));
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const { conversation } = await request({
    method: "renameConversation",
    id,
    title,
  });
  storeConversation(conversation);
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const { conversation } = await request({ method: "setPinned", id, pinned });
  storeConversation(conversation);
}

/**
 * Sends a user message from the current view. A draft first becomes a real chat or session;
 * the message shows immediately and is replaced by the daemon's copy once committed.
 */
export async function sendMessage(text: string): Promise<void> {
  const { selection } = useApp.getState();
  let conversationId: string;
  if (selection.type === "conversation") {
    conversationId = selection.id;
  } else if (selection.type === "draft") {
    const { conversation } = await request({
      method: "createConversation",
      kind: selection.kind,
      projectId: selection.kind === "session" ? selection.projectId : null,
      title: null,
    });
    storeConversation(conversation);
    conversationId = conversation.id;
    updateThread(conversationId, () => emptyThread);
    // Only follow the new conversation if the user is still looking at the draft.
    if (useApp.getState().selection === selection) {
      useApp.setState({ selection: { type: "conversation", id: conversationId } });
    }
  } else {
    return;
  }

  const localId = crypto.randomUUID();
  useApp.setState((state) => ({
    pending: [
      ...state.pending,
      { localId, conversationId, text, createdAtMs: Date.now() },
    ],
  }));
  try {
    const { message } = await request({
      method: "appendMessage",
      conversationId,
      text,
    });
    updateThread(conversationId, (thread) => ({
      ...thread,
      items: mergeMessages(thread.items, [message]),
    }));
  } finally {
    useApp.setState((state) => ({
      pending: state.pending.filter((entry) => entry.localId !== localId),
    }));
  }
}

export async function setDensity(density: Density): Promise<void> {
  applyDensity(density);
  const previous = useApp.getState().settings;
  useApp.setState({ settings: { ...previous, density } });
  try {
    await request({ method: "updateSettings", settings: { ...previous, density } });
  } catch (error) {
    applyDensity(previous.density);
    useApp.setState({ settings: previous });
    throw error;
  }
}

export function setInspectorOpen(open: boolean, tab?: InspectorTab): void {
  useApp.setState((state) => ({
    inspector: { ...state.inspector, open, tab: tab ?? state.inspector.tab },
  }));
}

export function setInspectorTab(tab: InspectorTab): void {
  useApp.setState((state) => ({ inspector: { ...state.inspector, tab } }));
}

export async function refreshDiagnostics(): Promise<void> {
  const { diagnostics } = await request({ method: "getDiagnostics" });
  useApp.setState((state) => ({
    inspector: {
      ...state.inspector,
      diagnostics,
      metrics: state.inspector.metrics ?? diagnostics.metrics,
    },
  }));
}

export async function setMetricsStreaming(enabled: boolean): Promise<void> {
  await request({ method: "setMetricsStreaming", enabled });
}

export async function runProbeBurst(count = 200, intervalMs = 5) {
  const { burst } = await request({ method: "probeBurst", count, intervalMs });
  return burst;
}

// ----- providers and raw sessions (Inspector) -------------------------------------------

/** Transcript entries fetched per page. */
const RAW_PAGE = 500;

function updateProviders(update: (providers: ProvidersState) => ProvidersState): void {
  useApp.setState((state) => ({ providers: update(state.providers) }));
}

function updateTranscript(id: string, update: (transcript: RawTranscript) => RawTranscript): void {
  updateProviders((providers) => ({
    ...providers,
    transcripts: {
      ...providers.transcripts,
      [id]: update(providers.transcripts[id] ?? { entries: [], hasMore: false, loading: false }),
    },
  }));
}

/** Shows a session returned by a request right away (its event may still be in flight). */
function showRawSession(session: RawSession): void {
  updateProviders((providers) => upsertRawSession(providers, session));
  selectRawSession(session.id);
}

export async function loadProviders(): Promise<void> {
  const { view } = await request({ method: "getProviders" });
  updateProviders((providers) => ({ ...providers, view }));
}

export async function refreshProviders(): Promise<void> {
  await request({ method: "refreshProviders" });
}

/** Opens a raw session in the Providers tab (or goes back to the list with `null`). */
export function selectRawSession(id: string | null): void {
  updateProviders((providers) => ({ ...providers, selected: id }));
  if (id !== null && !useApp.getState().providers.transcripts[id]) {
    void loadRawTranscript(id);
  }
}

/** Loads the newest page of a transcript, keeping live entries that arrived meanwhile. */
export async function loadRawTranscript(id: string): Promise<void> {
  updateTranscript(id, (transcript) => ({ ...transcript, loading: true }));
  try {
    const { page } = await request({ method: "listRawEvents", id, before: null, limit: RAW_PAGE });
    const newest = page.entries.at(-1)?.streamSeq ?? 0;
    updateTranscript(id, (transcript) => ({
      entries: [
        ...page.entries,
        ...transcript.entries.filter((entry) => entry.streamSeq > newest),
      ],
      hasMore: page.hasMore,
      loading: false,
    }));
  } catch (error) {
    updateTranscript(id, (transcript) => ({ ...transcript, loading: false }));
    throw error;
  }
}

export async function loadEarlierRawEntries(id: string): Promise<void> {
  const transcript = useApp.getState().providers.transcripts[id];
  const oldest = transcript?.entries[0];
  if (!transcript || !oldest || transcript.loading) return;
  updateTranscript(id, (current) => ({ ...current, loading: true }));
  try {
    const { page } = await request({
      method: "listRawEvents",
      id,
      before: oldest.streamSeq,
      limit: RAW_PAGE,
    });
    updateTranscript(id, (current) => ({
      entries: [...page.entries, ...current.entries],
      hasMore: page.hasMore,
      loading: false,
    }));
  } catch (error) {
    updateTranscript(id, (current) => ({ ...current, loading: false }));
    throw error;
  }
}

export type StartRawSession = {
  provider: ProviderKind;
  cwd: string;
  model: string | null;
  effort: string | null;
  access: Access;
  approvals: RawApprovals;
  record: boolean;
};

export async function startRawSession(start: StartRawSession): Promise<void> {
  const { session } = await request({ method: "startRawSession", ...start });
  showRawSession(session);
}

export async function resumeRawSession(id: string): Promise<void> {
  const { session } = await request({ method: "resumeRawSession", id });
  updateProviders((providers) => upsertRawSession(providers, session));
}

export async function forkRawSession(id: string): Promise<void> {
  const { session } = await request({ method: "forkRawSession", id });
  showRawSession(session);
}

export async function sendRawSession(id: string, text: string, steer: boolean): Promise<void> {
  await request({ method: "sendRawSession", id, text, steer });
}

export async function interruptRawSession(id: string): Promise<void> {
  await request({ method: "interruptRawSession", id });
}

export async function answerApproval(
  id: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<void> {
  await request({ method: "answerApproval", id, approvalId, decision });
}

export async function stopRawSession(id: string): Promise<void> {
  await request({ method: "stopRawSession", id });
}

export async function closeRawSession(id: string): Promise<void> {
  const { session } = await request({ method: "closeRawSession", id });
  updateProviders((providers) => upsertRawSession(providers, session));
}

export async function replayFixture(fixtureId: string): Promise<void> {
  const { session } = await request({ method: "replayFixture", fixtureId });
  showRawSession(session);
}

export async function simulateUsageLimit(provider: ProviderKind): Promise<void> {
  const { session } = await request({ method: "simulateUsageLimit", provider });
  showRawSession(session);
}
