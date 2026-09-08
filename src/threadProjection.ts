import type { ChatItem, ChatTurn } from "./workspaceApi";

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
      canCollapse: boolean;
      failures: number;
      count: number;
      status: ChatTurn["status"] | "unknown";
      startedAt?: number;
      latestProgress?: ChatItem;
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
export function projectThread(
  items: ChatItem[],
  busy: boolean,
  turns: ChatTurn[] = [],
  lastStop?: string | null,
): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let turn: ChatItem[] = [];
  let userId: string | undefined;
  let evidence: ChatTurn | undefined;
  const flush = (running: boolean, latest = false) => {
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
    // Pair the whole turn before folding commentary. Late results and child output
    // stay attached to their owning call even when delivered after the answer.
    const visible = (nodes: TraceNode[]): TraceNode[] =>
      nodes.flatMap((node) => {
        node.children = visible(node.children);
        if (node.item.kind.type === "thinking" && !node.item.body.trim())
          return node.children;
        return [node];
      });
    const ordered = visible(roots);
    const prose = (node: TraceNode) =>
      node.item.kind.type === "assistant-text" &&
      !node.item.parent_id &&
      !node.children.length;
    const meaningful = ordered.filter((n) => !prose(n) || n.item.body.trim());
    // Claude's current normalized items have no commentary/final channel. Only
    // trailing main-session prose is a candidate answer; never infer one mid-run.
    let answerStart = meaningful.length;
    if (!running) {
      while (answerStart > 0 && prose(meaningful[answerStart - 1]!))
        answerStart--;
    }
    const activity = meaningful.slice(0, answerStart);
    const answer = meaningful.slice(answerStart);
    const fallback =
      latest && lastStop && lastStop !== "end-turn"
        ? lastStop === "interrupted"
          ? "interrupted"
          : "stopped"
        : "unknown";
    const status = running
      ? "running"
      : evidence?.status === "running"
        ? "interrupted"
        : (evidence?.status ?? fallback);
    const interrupted =
      status === "interrupted" || status === "failed" || status === "stopped";
    if (activity.length || (evidence && answer.length)) {
      const all = flattenTrace(activity);
      rows.push({
        type: "work",
        id: `work:${userId ?? meaningful[0]!.item.id}`,
        nodes: activity,
        running,
        canCollapse: activity.length > 0 && answer.length > 0 && !interrupted,
        status,
        startedAt: evidence?.started_at,
        durationMs:
          evidence?.ended_at != null && evidence.ended_at >= evidence.started_at
            ? evidence.ended_at - evidence.started_at
            : undefined,
        latestProgress: [...activity].reverse().find(prose)?.item,
        failures: all.filter(traceFailed).length,
        count: all.filter(
          (n) =>
            n.item.kind.type === "tool-call" || n.item.kind.type === "subagent",
        ).length,
      });
    }
    if (answer.length) {
      const item = {
        ...answer[0]!.item,
        body: answer.map((n) => n.item.body).join("\n\n"),
      };
      rows.push({ type: "message", id: item.id, item, final: !interrupted });
    }
    turn = [];
  };
  for (const item of items) {
    const owner = turns.find(
      (t) =>
        item.seq >= t.start_seq &&
        (t.end_seq === null || item.seq <= t.end_seq),
    );
    if (item.kind.type === "user-text" && !item.parent_id) {
      flush(false);
      rows.push({ type: "message", id: item.id, item });
      userId = item.id;
      evidence = owner;
    } else {
      if (owner && evidence && owner.id !== evidence.id) {
        flush(false);
        userId = undefined;
      }
      evidence = owner ?? evidence;
      turn.push(item);
    }
  }
  flush(busy && evidence?.ended_at == null, true);
  return rows;
}

export function workDuration(ms: number): string {
  let seconds = Math.max(0, Math.floor(ms / 1000));
  const parts: string[] = [];
  for (const [unit, size] of [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    const amount = Math.floor(seconds / size);
    if (amount) parts.push(`${amount}${unit}`);
    seconds %= size;
  }
  return parts.join(" ") || "0s";
}

function activityCategory(item: ChatItem): string {
  const label = traceLabel(item);
  if (label !== "Ran commands") return label;
  let command = item.body.trim();
  try {
    const input = JSON.parse(command.slice(command.indexOf("{")));
    command = input.command ?? input.cmd ?? command;
  } catch {
    /* Plain shell commands are stored by older adapters. */
  }
  // Conservative presentation classification. Compound commands remain commands;
  // these labels never authorize execution or infer its outcome.
  if (typeof command !== "string" || /[;&|`\n]/.test(command)) return label;
  if (/^(?:cat|head|tail)\s|^sed\s+-n\s/.test(command)) return "Read files";
  if (/^(?:rg|grep|find|ls)\s/.test(command)) return "Searched files";
  return label;
}

export function activitySummary(nodes: TraceNode[]): string {
  const labels = new Set(nodes.map((n) => activityCategory(n.item)));
  const categories = [
    ["Edit files", "Edited files"],
    ["Read files", "Read files"],
    ["Searched files", "Read files"],
    [
      "Ran commands",
      nodes.filter((n) => activityCategory(n.item) === "Ran commands")
        .length === 1
        ? "Ran a command"
        : "Ran commands",
    ],
    ["Web research", "Searched the web"],
  ];
  const parts = [
    ...new Set(
      categories.filter(([key]) => labels.has(key!)).map(([, value]) => value!),
    ),
  ];
  for (const label of labels)
    if (!categories.some(([key]) => key === label)) parts.push(label);
  return parts
    .map((part, i) => (i ? part.charAt(0).toLowerCase() + part.slice(1) : part))
    .join(", ");
}

export function activeWorkLabel(nodes: TraceNode[]): string {
  const pending = flattenTrace(nodes).filter(
    (n) => n.item.kind.type === "tool-call" && !n.result,
  );
  const latest = pending[pending.length - 1];
  if (!latest) return "Thinking";
  const label = activityCategory(latest.item);
  if (label === "Web research") return "Searching the web";
  if (label === "Searched files") return "Searching files";
  if (label === "Read files") return "Reading files";
  if (label === "Edit files") return "Editing files";
  if (label === "Ran commands") return "Running command";
  return "Working";
}
