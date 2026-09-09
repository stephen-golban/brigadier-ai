import type { ChatItem } from './workspaceApi';

export const HISTORY_WINDOW = 600;
/** Sequence is an update cursor; stable IDs replace streaming rows, never duplicate them. */
export function mergeHistory(previous: ChatItem[], page: ChatItem[], direction: 'latest' | 'older' = 'latest'): ChatItem[] {
  const merged = new Map(previous.map(item => [item.id, item]));
  for (const item of page) {
    const old = merged.get(item.id);
    if (!old || item.seq >= old.seq) merged.set(item.id, old && old.seq === item.seq && old.body === item.body ? old : item);
  }
  const rows = [...merged.values()].sort((a,b) => a.seq-b.seq || a.id.localeCompare(b.id));
  return direction === 'older' ? rows.slice(0,HISTORY_WINDOW) : rows.slice(-HISTORY_WINDOW);
}
