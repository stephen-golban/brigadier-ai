import type { ExecutionChange } from "../../taskSettings";
import type { ChatItem } from "../../workspaceApi";
/** Bind markers to saved user messages; never manufacture or flatten conversation rows. */
export function providerChangePlacement(changes: ExecutionChange[], items: ChatItem[], historical: boolean) {
  const messages = items.filter(item => item.kind.type === "user-text" && !item.parent_id);
  const before = new Map<string, ExecutionChange[]>(), after: ExecutionChange[] = [];
  const first = items[0];
  for (const change of changes) {
    // A paged slice cannot establish where changes older than its first saved item belong.
    if (first && first.seq > 1 && first.at > change.timestamp) continue;
    const next = messages.find(item => item.at >= change.timestamp);
    if (next) before.set(next.id, [...(before.get(next.id) ?? []), change]);
    else if (!historical) after.push(change);
  }
  return { before, after };
}
