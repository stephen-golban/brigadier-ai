import type { ChatItem } from "./workspaceApi";

export interface TraceNode {
  item: ChatItem;
  result?: ChatItem;
  updates: ChatItem[];
  children: TraceNode[];
}
export type ThreadRow =
  | { type: "message"; id: string; item: ChatItem }
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
  if (["read", "readfile", "read_file"].includes(name))
    return "Read files";
  if (["glob", "grep", "search", "ripgrep"].includes(name)) return "Searched files";
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
  let startedAt:number|null=null;
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
    // No channel metadata exists in the stored protocol. Only the trailing main-session
    // prose after activity is presented as the answer; all earlier prose stays in work.
    let answerStart = roots.length;
    if (!running) {
      while (answerStart > 0) {
        const node = roots[answerStart - 1]!;
        if (
          node.item.kind.type !== "assistant-text" ||
          node.item.parent_id ||
          node.children.length
        )
          break;
        answerStart--;
      }
    }
    const work = roots.slice(0, answerStart);
    if (work.length) {
      const all = flattenTrace(work);
      rows.push({
        type: "work",
        id: `work:${turn[0]!.id}`,
        nodes: work,
        running,
        failures: all.filter(traceFailed).length,
        durationMs: startedAt && turn[turn.length-1]!.at>=startedAt ? turn[turn.length-1]!.at-startedAt : undefined,
        count: all.filter(
          (n) =>
            n.item.kind.type === "tool-call" || n.item.kind.type === "subagent",
        ).length,
      });
    }
    const answers = roots.slice(answerStart);
    if (answers.length) {
      const item = {
        ...answers[0]!.item,
        body: answers.map((n) => n.item.body).join("\n\n"),
      };
      rows.push({ type: "message", id: item.id, item });
    }
    turn = [];
  };
  for (const item of items) {
    if (item.kind.type === "user-text" && !item.parent_id) {
      flush(false);
      startedAt=item.at;
      rows.push({ type: "message", id: item.id, item });
    } else turn.push(item);
  }
  flush(busy);
  return rows;
}
