import { request } from "@/ipc/client";
import type { Conversation, Density, Project } from "@/ipc/generated";
import { applyDensity } from "@/lib/density";
import {
  emptyThread,
  mergeMessages,
  replaceCatalog,
  type InspectorTab,
  type Selection,
  type Thread,
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

/** Fetches the full text of a message whose body lives in the blob store. */
export async function loadFullText(
  conversationId: string,
  messageId: string,
  hash: string,
): Promise<void> {
  const { text } = await request({ method: "readBlobText", hash });
  updateThread(conversationId, (thread) => ({
    ...thread,
    fullText: { ...thread.fullText, [messageId]: text },
  }));
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
