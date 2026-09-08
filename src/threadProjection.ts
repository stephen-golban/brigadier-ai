import type { ChatItem } from "./workspaceApi";

export interface TraceNode {
  item: ChatItem;
  result?: ChatItem;
  updates: ChatItem[];
  children: TraceNode[];
}
export type ThreadRow =
  | { type: "message"; id: string; item: ChatItem; final?: boolean }
  | {
      type: "work";
      id: string;
      nodes: TraceNode[];
      running: boolean;
      failures: number;
      count: number;
      durationMs?: number;
    };

export function isAgent(item: ChatItem): boolean {
  return (
    item.kind.type === "subagent" ||
    (item.kind.type === "tool-call" &&
      ["agent", "task", "mcp__brigadier__create_session"].includes(
        item.kind.name.toLowerCase(),
      ))
  );
}
export function traceLabel(item: ChatItem): string {
  if (item.kind.type === "tool-call") {
    const peerLabels: Record<string, string> = {
      list_projects: "Listed projects",
      list_sessions: "Listed sessions",
      read_session: "Read session",
      wait_sessions: "Wait for sessions",
      create_session: "Created session",
      send_message: "Sent message to session",
      read_inbox: "Read session inbox",
      stop_session: "Stop session",
      close_session: "Close session",
    };
    const name = item.kind.name.replace(/^mcp__brigadier__/, "");
    if (item.kind.name.startsWith("mcp__brigadier__") && peerLabels[name])
      return peerLabels[name]!;
  }
  if (item.kind.type === "subagent")
    return item.kind.description || "Agent task";
  if (isAgent(item)) {
    try {
      const input = JSON.parse(item.body.slice(item.body.indexOf("{")));
      if (typeof input.description === "string") return input.description;
      if (typeof input.title === "string") return input.title;
    } catch {
      /* Keep raw prompts out of the summary. */
    }
    return "Agent task";
  }
  if (item.kind.type === "thinking") return "Thinking";
  if (item.kind.type === "assistant-text") return "Progress";
  if (item.kind.type === "user-text") return "Input";
  if (item.kind.type === "tool-result") return "Tool output";
  const name = item.kind.name.toLowerCase();
  if (["bash", "shell", "exec_command", "write_stdin"].includes(name))
    return "Ran commands";
  if (["read", "readfile", "read_file"].includes(name)) return "Read files";
  if (["glob", "grep", "search", "ripgrep"].includes(name))
    return "Searched files";
  if (["edit", "write", "multiedit", "apply_patch"].includes(name))
    return "Edit files";
  if (["websearch", "webfetch"].includes(name)) return "Web research";
  return item.kind.name;
}
export function flattenTrace(nodes: TraceNode[]): TraceNode[] {
  return nodes.flatMap((n) => [n, ...flattenTrace(n.children)]);
}
export function traceFailed(node: TraceNode): boolean {
  return (
    (node.result?.kind.type === "tool-result" && node.result.kind.is_error) ||
    (node.item.kind.type === "tool-result" && node.item.kind.is_error)
  );
}

/** Display projection only. Original bodies, including lifecycle updates, are preserved. */
export function projectThread(items: ChatItem[], busy: boolean): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let turn: ChatItem[] = [];
  const flush = (running: boolean) => {
    if (!turn.length) return;
    const nodes = new Map<string, TraceNode>();
    const agents = new Map<string, TraceNode>();
    for (const item of turn) {
      const existing =
        item.kind.type === "subagent"
          ? agents.get(item.kind.task_id)
          : undefined;
      if (existing) {
        existing.updates.push(item);
        nodes.set(item.id, existing);
      } else {
        const node: TraceNode = { item, updates: [], children: [] };
        nodes.set(item.id, node);
        if (item.kind.type === "subagent") agents.set(item.kind.task_id, node);
      }
    }
    const roots: TraceNode[] = [];
    const unique = [...new Set(nodes.values())];
    const paired = new Set<TraceNode>();
    for (const node of unique) {
      const { item } = node;
      if (item.kind.type === "tool-result") {
        const owner = nodes.get(item.kind.tool_call_id);
        if (
          owner &&
          owner !== node &&
          owner.item.kind.type === "tool-call" &&
          !owner.result
        ) {
          owner.result = item;
          // Parent references to result IDs resolve to the paired call as well.
          nodes.set(item.id, owner);
          paired.add(node);
        }
      }
    }
    for (const node of unique) {
      if (paired.has(node)) continue;
      const { item } = node;
      const parent = item.parent_id ? nodes.get(item.parent_id) : undefined;
      let cyclic = false;
      let cursor = parent;
      const seen = new Set([node]);
      while (cursor) {
        if (seen.has(cursor)) {
          cyclic = true;
          break;
        }
        seen.add(cursor);
        cursor = cursor.item.parent_id
          ? nodes.get(cursor.item.parent_id)
          : undefined;
      }
      if (parent && !cyclic) parent.children.push(node);
      else roots.push(node);
    }
    // Pair against the whole turn before separating adjacent main-session prose and
    // activity. Late results and child output stay attached to their owning call.
    const visible = (nodes: TraceNode[]): TraceNode[] =>
      nodes.flatMap((node) => {
        node.children = visible(node.children);
        if (node.item.kind.type === "thinking" && !node.item.body.trim())
          return node.children;
        return [node];
      });
    const ordered = visible(roots);
    let activity: TraceNode[] = [];
    const flushActivity = () => {
      if (!activity.length) return;
      const all = flattenTrace(activity);
      rows.push({
        type: "work",
        id: `work:${activity[0]!.item.id}`,
        nodes: activity,
        running,
        failures: all.filter(traceFailed).length,
        count: all.filter(
          (n) =>
            n.item.kind.type === "tool-call" || n.item.kind.type === "subagent",
        ).length,
      });
      activity = [];
    };
    for (const node of ordered) {
      const { item } = node;
      if (
        item.kind.type === "assistant-text" &&
        !item.parent_id &&
        !node.children.length
      ) {
        if (!item.body.trim()) continue;
        flushActivity();
        const previous = rows[rows.length - 1];
        if (
          previous?.type === "message" &&
          previous.item.kind.type === "assistant-text"
        ) {
          previous.item = {
            ...previous.item,
            body: `${previous.item.body}\n\n${item.body}`,
          };
        } else {
          rows.push({ type: "message", id: item.id, item });
        }
      } else activity.push(node);
    }
    flushActivity();
    const last = rows[rows.length - 1];
    if (
      !running &&
      last?.type === "message" &&
      last.item.kind.type === "assistant-text"
    )
      last.final = true;
    turn = [];
  };
  for (const item of items) {
    if (item.kind.type === "user-text" && !item.parent_id) {
      flush(false);
      rows.push({ type: "message", id: item.id, item });
    } else turn.push(item);
  }
  flush(busy);
  return rows;
}
