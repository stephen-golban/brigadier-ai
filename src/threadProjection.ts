import type { NoticeLevel } from "./wire";
import type { ChatItem, ChatTurn } from "./workspaceApi";

/** Added and removed line counts for one edit, parsed from the tool **input**. */
export interface EditStat {
  added: number;
  removed: number;
}

export interface TraceNode {
  item: ChatItem;
  result?: ChatItem;
  updates: ChatItem[];
  children: TraceNode[];
  /**
   * Wall time for this call, `result.at - item.at`. Present only when both timestamps are real
   * (`at > 0` is the tree's "unknown time" convention) and ordered; never inferred otherwise.
   */
  durationMs?: number;
  /** `editLineCounts(item)`, computed once at projection time. Absent when it could not be parsed. */
  edit?: EditStat;
}
export type ThreadRow =
  | {
      type: "message";
      id: string;
      item: ChatItem;
      final?: boolean;
      /** The turn is still running and this body is still growing (§4.2.3). Never set with `final`. */
      streaming?: boolean;
    }
  | {
      type: "notice";
      id: string;
      item: ChatItem;
      level: NoticeLevel;
      code: string;
      /**
       * Always absent. It exists so the current renderer's `row.final` read
       * (`src/components/ThreadView.tsx`) still type-checks against the widened union before
       * phase 4 gives notices a renderer of their own.
       */
      final?: undefined;
    }
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
      /** Turn end, unix ms. The header prints the done time unconditionally; `durationMs` is
       *  what the 60 s rule gates on. Absent while the turn is open or unrecorded. */
      completedAtMs?: number;
      /**
       * A streaming answer row follows this one: the turn is running and its trailing prose is
       * already being drawn below. `WorkTrace`'s thinking shimmer (`!last || last is prose`) must
       * be gated on this, or an empty live work row shows "thinking" directly above prose the
       * operator can watch arriving.
       */
      streamingAnswer?: boolean;
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
  // A lifecycle notice never reaches a trace node (`projectThread` routes it to its own row), but
  // it is an `ItemKind`, so the fallthrough below must not assume a tool name.
  if (item.kind.type === "notice") return "Notice";
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

/**
 * True when a `lastStop` string is the `{ error }` shape shared by `StopReason::Error` and
 * `AbortReason::Error` (`src/wire.ts`). Both terminal reasons persist as `status: "failed"`
 * (`crates/store/src/chat.rs::write_turn`), so recognizing the shape — not which enum produced
 * it — is what keeps this live guess and the later persisted record from disagreeing.
 */
function isErrorStop(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { error?: unknown }).error === "string"
    );
  } catch {
    return false;
  }
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
        const edit = editLineCounts(item);
        if (edit) node.edit = edit;
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
          // Per-call wall time, from timestamps that were already on both items. `at === 0` is
          // this tree's "no recorded time" (`ThreadView` gates its date label on `at > 0`), and a
          // result stamped before its call is a clock artefact: neither produces a duration.
          if (owner.item.at > 0 && item.at >= owner.item.at)
            owner.durationMs = item.at - owner.item.at;
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
    // Claude's current normalized items have no commentary/final channel, so which prose is the
    // answer is inferred from position: only a **trailing** run of top-level childless prose is a
    // candidate. Since §4.2.3 that holds while the turn is still running too — a trailing run is
    // the streaming answer, `streaming` rather than `final` — which is the whole of the streaming
    // change on this side.
    //
    // Promotion is **not** latched: a paragraph a tool call later followed returns to the
    // activity group, where interim prose belongs (§3 row 3; owner decision, 2026-09-11).
    //
    // **Known, reasoned deviation from §4.2.3's "must not move" — do not "fix" it.** That move
    // remounts the paragraph, because the answer position and the work row are different parent
    // components and React unmounts a subtree that changes parent whatever key it carries. No id
    // scheme avoids it. It is intrinsic to *inferring* which prose is the answer: nothing in the
    // protocol distinguishes a final text block from commentary until the next tool call lands or
    // the turn ends. Codex does not have this problem because its server labels every message as
    // commentary or final answer before anything renders; it is told what we infer. The three
    // alternatives were each rejected for a worse cost: never promoting kills streaming; latching
    // the promotion puts commentary in the answer position and disagrees with the same turn
    // re-read from SQLite; merging all of a turn's prose into one row shows commentary and answer
    // as one growing body.
    //
    // What is guaranteed instead, and what the tests pin: **one identity per paragraph for the
    // life of the turn**. The row id of a streaming paragraph is the item's own id, which is also
    // the key it carries as a trace node inside the work row (`WorkTrace.tsx:179,226`) and the id
    // it keeps when the turn settles. Nothing is re-keyed and no id is ever reused for different
    // content. `src/threadProjection.test.ts` T2 asserts the full id set at every step.
    let answerStart = meaningful.length;
    while (answerStart > 0 && prose(meaningful[answerStart - 1]!)) answerStart--;
    const activity = meaningful.slice(0, answerStart);
    const answer = meaningful.slice(answerStart);
    // `lastStop` mirrors `StopReason` for a completed turn, but `feedStore.ts` now also writes
    // it from `AbortReason` on `turn-aborted`, using the same bare-string/`{error}` encoding
    // (`src/wire.ts`). Its two abort-only bare values, "interrupted" and "killed", cannot
    // collide with any `StopReason` variant, so they are read here unambiguously — this is the
    // live signal that stands in for `evidence.status` until the persisted turn record lands.
    // Both fold to "interrupted", matching `chat.rs::write_turn`'s own `AbortReason::Error =>
    // "failed", _ => "interrupted"`: a killed turn was stopped on the harness's own say-so, not
    // a failure of the agent, and the live guess must agree with what SQLite will say next.
    const fallback = !latest || !lastStop
      ? "unknown"
      : lastStop === "interrupted" || lastStop === "killed"
        ? "interrupted"
        : isErrorStop(lastStop)
          ? "failed"
          : lastStop !== "end-turn"
            ? "stopped"
            : "unknown";
    const status = running
      ? "running"
      : evidence?.status === "running"
        ? "interrupted"
        : (evidence?.status ?? fallback);
    const interrupted =
      status === "interrupted" || status === "failed" || status === "stopped";
    // A running turn always has a work row, even with nothing in it yet: it carries the turn
    // header and the live status, it is what `ThreadView` checks to suppress its own global
    // thinking indicator, and a turn whose only content so far is streaming prose would otherwise
    // have no row at all (`src/components/WorkTrace.test.tsx`'s live fixture reads `rows[0]`).
    if (running || activity.length || (evidence && answer.length)) {
      const all = flattenTrace(activity);
      rows.push({
        type: "work",
        id: `work:${userId ?? meaningful[0]!.item.id}`,
        nodes: activity,
        running,
        // `&& !running` is load-bearing: a streaming answer makes `answer.length > 0` true
        // mid-turn, and `WorkTrace.tsx:66` (`open = … || !row.canCollapse || …`) would then
        // collapse the activity list the operator is watching. A live turn never collapses itself.
        canCollapse:
          !running && activity.length > 0 && answer.length > 0 && !interrupted,
        status,
        startedAt: evidence?.started_at,
        durationMs:
          evidence?.ended_at != null && evidence.ended_at >= evidence.started_at
            ? evidence.ended_at - evidence.started_at
            : undefined,
        completedAtMs: evidence?.ended_at ?? undefined,
        streamingAnswer: running && answer.length > 0 ? true : undefined,
        latestProgress: [...activity].reverse().find(prose)?.item,
        failures: all.filter(traceFailed).length,
        count: all.filter(
          (n) =>
            n.item.kind.type === "tool-call" || n.item.kind.type === "subagent",
        ).length,
      });
    }
    if (answer.length) {
      // Notices that fall before the answer's first item belong above it, in `seq` order.
      emitNotices(answer[0]!.item.seq);
      const item = {
        ...answer[0]!.item,
        body: answer.map((n) => n.item.body).join("\n\n"),
      };
      // `final` drives the changed-files card (`ThreadView.tsx:453`) and the "this is the answer"
      // affordances; while the turn runs the body is still growing, so the row is `streaming` and
      // carries no `final` at all. The id is the first answer node's, which does not move as the
      // body grows, so React re-renders the row rather than remounting it.
      rows.push(
        running
          ? { type: "message", id: item.id, item, streaming: true }
          : { type: "message", id: item.id, item, final: !interrupted },
      );
    }
    turn = [];
  };
  // Lifecycle notices (§4.4) are ordinary items in `seq` order, but a turn's own rows are only
  // pushed when the turn flushes. A notice that lands mid-turn is therefore held until that flush
  // — splitting the turn at it would make two work rows out of one — and then emitted at its
  // place in `seq` order: before the answer row when it preceded the answer's first item, after
  // it otherwise. Held notices always follow the work row, whose span they fall inside.
  const pending: ChatItem[] = [];
  const emitNotices = (upTo = Infinity) => {
    let held = 0;
    for (const item of pending) {
      if (item.seq >= upTo) {
        pending[held++] = item;
        continue;
      }
      if (item.kind.type !== "notice") continue;
      rows.push({
        type: "notice",
        id: item.id,
        item,
        level: item.kind.level,
        code: item.kind.code,
      });
    }
    pending.length = held;
  };
  for (const item of items) {
    if (item.kind.type === "notice") {
      // Held until the open turn flushes, so a mid-turn notice never splits one work row in two.
      if (turn.length) pending.push(item);
      else
        rows.push({
          type: "notice",
          id: item.id,
          item,
          level: item.kind.level,
          code: item.kind.code,
        });
      continue;
    }
    const owner = turns.find(
      (t) =>
        item.seq >= t.start_seq &&
        (t.end_seq === null || item.seq <= t.end_seq),
    );
    if (item.kind.type === "user-text" && !item.parent_id) {
      flush(false);
      emitNotices();
      rows.push({ type: "message", id: item.id, item });
      userId = item.id;
      evidence = owner;
    } else {
      if (owner && evidence && owner.id !== evidence.id) {
        flush(false);
        emitNotices();
        userId = undefined;
      }
      evidence = owner ?? evidence;
      turn.push(item);
    }
  }
  flush(busy && evidence?.ended_at == null, true);
  emitNotices();
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

/** `""` is zero lines, and a trailing newline terminates the last line rather than starting an
 *  empty one — the same count `wc -l` and a diff stat agree on. */
function lineCount(text: string): number {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? 0 : body.split("\n").length;
}

/**
 * Added/removed line counts for one `Edit`/`MultiEdit`/`Write` call, read off the tool **input**
 * so an edit row carries its own numbers without waiting for the 3.5 s `changes` poll.
 *
 * Defensive in the same style as `activityCategory`: every unreadable shape returns `undefined`
 * rather than a number nobody can justify. In particular a `replace_all` edit is **not** counted —
 * how many occurrences matched is decided by the file, and the file is not on the wire. `Write`
 * reports only what it wrote: the previous contents of the path are not on the wire either, so its
 * `removed` is 0 and a caller must not read that as "this overwrote nothing".
 */
export function editLineCounts(item: ChatItem): EditStat | undefined {
  const cached = editCache.get(item);
  if (cached !== undefined) return cached ?? undefined;
  const parsed = parseEditLineCounts(item);
  // `null` records "parsed, unusable", so a body that cannot yield counts is not re-split on
  // every projection — up to 10 Hz per streamed refetch. Keyed on the item **object**:
  // `mergeHistory` keeps the previous object whenever `seq` and `body` are unchanged
  // (`src/conversationHistory.ts`), so an untouched item is a cache hit across refetches, and a
  // body that did change is a different object that must be re-parsed anyway.
  editCache.set(item, parsed ?? null);
  return parsed;
}

const editCache = new WeakMap<ChatItem, EditStat | null>();

function parseEditLineCounts(item: ChatItem): EditStat | undefined {
  if (item.kind.type !== "tool-call") return undefined;
  const name = item.kind.name.toLowerCase();
  if (!["edit", "multiedit", "write"].includes(name)) return undefined;
  let input: unknown;
  try {
    const start = item.body.indexOf("{");
    if (start < 0) return undefined;
    input = JSON.parse(item.body.slice(start));
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  if (name === "write") {
    const content = fields.content;
    return typeof content === "string"
      ? { added: lineCount(content), removed: 0 }
      : undefined;
  }
  const edits = name === "multiedit" ? fields.edits : [fields];
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  let added = 0;
  let removed = 0;
  for (const entry of edits) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const edit = entry as Record<string, unknown>;
    // Anything that is not unambiguously *false* counts as `replace_all`: the CLI has sent
    // `true`, `"true"` and `1` for booleans elsewhere, and guessing here would report one
    // occurrence's lines for an edit that rewrote twenty.
    const all = edit.replace_all;
    if (all !== undefined && all !== null && all !== false && all !== "false" && all !== 0)
      return undefined;
    const before = edit.old_string;
    const after = edit.new_string;
    if (typeof before !== "string" || typeof after !== "string") return undefined;
    removed += lineCount(before);
    added += lineCount(after);
  }
  return { added, removed };
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
