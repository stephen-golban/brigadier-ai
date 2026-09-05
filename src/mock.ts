/**
 * In-memory mock of the Rust side, for `npm run dev` in a plain browser.
 *
 * It implements `docs/plans/ipc-contract.md` exactly: same command surface, same wire shapes,
 * same batching rules (one batch per animation frame per project, at most
 * `MAX_ROWS_PER_BATCH` rows per message, non-visible projects dropped to counters).
 *
 * It exists so the front end and its FPS meter can be exercised without the Rust side, so it is
 * a load generator first and a fake second. `?rps=` sets the total rows/sec across all running
 * sessions (default 200); `?sessions=` seeds that many running sessions (default 1).
 */
import {
  MAX_ROWS_PER_BATCH,
  ZERO_USAGE,
  AppError,
} from "./wire";
import type {
  ApprovalView,
  Decision,
  DeletedRows,
  Envelope,
  Event,
  FeedBatch,
  FeedKind,
  FeedRowWire,
  IntentSettlement,
  IntentView,
  PhaseView,
  ProjectDeletion,
  ProjectView,
  RequestKind,
  RunView,
  SessionDeletion,
  SessionView,
  WorkOrderView,
} from "./wire";
import type { ChatItem } from "./workspaceApi";
import type { Bridge, BurnArgs, StartSessionArgs } from "./bridge";

/* ----------------------------------------------------------------- state */

interface MockSession {
  view: SessionView;
  seq: number;
  /** `cleanup_worktree` with `force: true` has run: the checkout is gone, so resume must fail. */
  worktreeRemoved: boolean;
  /** Rows per second this session should emit. */
  rps: number;
  /** Fractional row carried between frames so a slow rate still fires. */
  debt: number;
  /** Wall-clock ms after which the session stops emitting (`burn` duration), or null. */
  until: number | null;
  cost: number;
  turnId: number;
}

const projects: ProjectView[] = [
  {
    id: "p-brigadier",
    name: "brigadier-ai",
    root_path: "/Users/stephen/Development/brigadier-ai",
    created_at_ms: Date.now() - 86_400_000,
  },
  {
    id: "p-scratch",
    name: "scratch",
    root_path: "/Users/stephen/Development/scratch",
    created_at_ms: Date.now() - 3_600_000,
  },
];

/** The project `burn` creates for its own sessions, matching `src-tauri/src/burn.rs`. */
const BURN_PROJECT_NAME = "burn";

const sessions = new Map<string, MockSession>();
const approvals = new Map<string, ApprovalView>();
const feedRows = new Map<string, FeedRowWire[]>();
const conversations = new Map<string, ChatItem[]>();
function appendChat(sessionId:string,kind:ChatItem['kind'],body:string,id?:string) {
  const items=conversations.get(sessionId)??[];
  const seq=(items[items.length-1]?.seq??0)+1;
  items.push({session_id:sessionId,id:id??`chat-${seq}`,seq,at:Date.now(),kind,body,parent_id:null});
  conversations.set(sessionId,items.slice(-2000));
}
export function mockChatItems(sessionId:string,after:number):ChatItem[] {
  return (conversations.get(sessionId)??[]).filter(item=>item.seq>after).slice(0,20);
}
function seedConversation(sessionId:string) {
  appendChat(sessionId,{type:'user-text'},'Show me the local workspace and explain the next change.');
  appendChat(sessionId,{type:'thinking'},'This is a browser preview fixture. I would inspect the project structure before proposing a change.');
  appendChat(sessionId,{type:'tool-call',name:'Read'},'README.md','preview-read');
  appendChat(sessionId,{type:'tool-result',tool_call_id:'preview-read',is_error:false},'# Brigadier\nA local workspace for coding agents.');
  appendChat(sessionId,{type:'assistant-text'},'This is the **browser preview** of the conversation layout. No agent has been called.\n\nOpen [README.md](README.md) to see the file panel. You can also browse changes and attach file context to your next message.\n\n| Surface | Purpose |\n| --- | --- |\n| Conversation | Read responses and expand activity |\n| Files | Browse the selected workspace |\n| Changes | Inspect staged and working tree diffs |\n\nInteractive shell tabs run in the desktop app.');
}


let visible: Set<string> = new Set(projects.map((p) => p.id));
let onBatch: ((b: FeedBatch) => void) | null = null;
let ticking = false;
let nextId = 1;
let approvalClock = 0;
/** The one-time session/approval seed has run. StrictMode calls `subscribeFeed` twice. */
let seeded = false;

const RUN_ID = `mock-${Math.random().toString(36).slice(2, 8)}`;
const TAIL_CAP = 4000;

/**
 * Every synthetic approval carries these two fields at the top of its `input_excerpt`. Nothing
 * here ever reaches a model: no `claude` process is spawned, no token is billed. The excerpt is
 * the one place an operator reading an approval card looks, so the marker goes there rather
 * than only in the header's "MOCK BRIDGE" note.
 */
const MOCK_MARKER = "__mock__";
const MOCK_NOTE = "SYNTHETIC MOCK DATA — no claude process, no model call, no spend";

function params(): URLSearchParams {
  return new URLSearchParams(typeof location === "undefined" ? "" : location.search);
}

function num(key: string, fallback: number): number {
  const raw = params().get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Total rows/sec across all ambient sessions. */
const AMBIENT_RPS = num("rps", 200);
const AMBIENT_SESSIONS = Math.max(1, Math.round(num("sessions", 1)));

/* ------------------------------------------------------------ generation */

const TOOLS = ["Read", "Edit", "Bash", "Grep", "Write", "Glob", "WebFetch", "Task"];
const PATHS = [
  "crates/core/src/event.rs",
  "crates/store/src/feed.rs",
  "src-tauri/src/lib.rs",
  "docs/research/feed-rendering.md",
  "src/components/Feed.tsx",
];

function pick<T>(xs: readonly T[], i: number): T {
  return xs[i % xs.length] as T;
}

/** A line shaped like `crates/store/src/feed.rs::terse_line` output. */
function terseLine(seq: number): string {
  switch (seq % 7) {
    case 0:
      return `tool ${pick(TOOLS, seq)} · ${pick(PATHS, seq >> 1)}`;
    case 1:
      return `tool result done · ${pick(PATHS, seq)} · ${(seq % 400) + 12} lines`;
    case 2:
      return `assistant done · rewriting the batcher so a frame never exceeds 8000 bytes`;
    case 3:
      return `thinking · ${(seq % 900) + 40} tokens`;
    case 4:
      return `tool Bash done · cargo check · finished in ${(seq % 40) / 10 + 0.4}s`;
    case 5:
      return `subagent reviewer · ${pick(PATHS, seq >> 2)}`;
    default:
      return `assistant · ${pick(PATHS, seq)} now compiles; moving on to the store`;
  }
}

/**
 * The `k` for the line `terseLine(seq)` just produced — **the same `seq % 7` switch**, so the
 * mock's kinds and its lines can never disagree and the browser fallback exercises the same
 * classes the Rust feed does (`docs/plans/ipc-contract.md`, "Browser fallback": the mock "must
 * implement this same contract").
 *
 * Mapped against the contract's `FeedRowWire.k` table, arm by arm: 0/1/4 are `ItemKind::ToolCall`
 * and `ItemKind::ToolResult` shapes → `tool`; 2 and 6 are `ItemKind::AssistantText` → `text`,
 * which is exactly what the feed's verbose toggle gates; 3 is `ItemKind::Thinking` → `think`;
 * 5 is `ItemKind::Subagent` → `sub`.
 *
 * A constant here would have been a lie of the cheap kind: every row would have claimed one class
 * and the toggle would have looked like it worked while filtering nothing.
 */
function terseKind(seq: number): FeedKind {
  switch (seq % 7) {
    case 0:
    case 1:
    case 4:
      return "tool";
    case 2:
      return "text";
    case 3:
      return "think";
    case 5:
      return "sub";
    default:
      return "text";
  }
}

function newSessionId(): string {
  return `s-${(nextId++).toString().padStart(4, "0")}`;
}

/** The contract's short id: eight lowercase hex characters, minted per session. */
function shortHex(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return out;
}

/**
 * A session and, unless `withWorktree` is false, the git worktree the contract's §Worktrees
 * section describes: branch `brigadier/<8 hex>`, checkout at
 * `<project root>/.brigadier/worktrees/<8 hex>`, and `cwd === worktree_path`. Nothing is created
 * on disk — these are synthetic strings, like everything else in this file.
 *
 * `withWorktree: false` is the non-git-repo case the contract allows: both fields null, the
 * child runs in the project root, and the sidebar shows no branch chip.
 */
function makeSession(
  projectId: string,
  model: string,
  rps: number,
  until: number | null,
  withWorktree = true,
): MockSession {
  const id = newSessionId();
  const root = projects.find((p) => p.id === projectId)?.root_path ?? null;
  const hex = shortHex();
  const worktree = withWorktree && root !== null ? `${root}/.brigadier/worktrees/${hex}` : null;
  const s: MockSession = {
    view: {
      session_id: id,
      project_id: projectId,
      instance_id: "claude-mock",
      provider_session_id: `prov-${id}`,
      cwd: worktree ?? root,
      worktree_path: worktree,
      branch: worktree === null ? null : `brigadier/${hex}`,
      model,
      status: "running",
      started_at_ms: Date.now(),
      ended_at_ms: null,
      exit_code: null,
      last_event_seq: 0,
      usage: { ...ZERO_USAGE },
      cost_usd_cumulative: 0,
    },
    seq: 0,
    worktreeRemoved: false,
    rps,
    debt: 0,
    until,
    cost: 0,
    turnId: 1,
  };
  sessions.set(id, s);
  return s;
}

function envelope(s: MockSession, event: Event): Envelope {
  s.seq += 1;
  s.view.last_event_seq = s.seq;
  return {
    seq: s.seq,
    at: Date.now(),
    instance_id: "claude-mock",
    session_id: s.view.session_id,
    event,
  };
}

/**
 * One stored row. `k` is a required argument with no default, so every call site has to state what
 * its line is a record of: the contract's `k` is a discriminator, and a default would let a caller
 * ship a class the Rust side would never have sent for that line.
 *
 * **What this mock still cannot produce, stated rather than left to be discovered:** `turn`,
 * `warn`, `err` and `unknown` have no source here, and `appr` has none either — the approval path
 * at `tick()` pushes a `request-opened` **signal** and no row, where the Rust side writes both
 * (`crates/store/src/feed.rs`, `apply`). So `npm run dev` exercises `tool`, `text`, `think`, `sub`
 * and `sys`, and the feed's `err` and `appr` treatments are not reachable through it. Left alone
 * deliberately: adding rows on the approval path means threading them through the visibility drop
 * and the per-session counters, which is a change to what this file reports, not to what it draws.
 */
function row(s: MockSession, line: string, k: FeedKind): FeedRowWire {
  s.seq += 1;
  s.view.last_event_seq = s.seq;
  const r: FeedRowWire = { s: s.view.session_id, q: s.seq, t: Date.now(), l: line, k };
  const tail = feedRows.get(s.view.session_id) ?? [];
  tail.push(r);
  if (tail.length > TAIL_CAP) tail.splice(0, tail.length - TAIL_CAP);
  feedRows.set(s.view.session_id, tail);
  return r;
}

/* ---------------------------------------------------------------- ticking */

interface Pending {
  rows: FeedRowWire[];
  signals: Envelope[];
  counters: Map<string, { total: number; dropped: number }>;
}

const totals = new Map<string, { total: number; dropped: number }>();

function counter(id: string) {
  let c = totals.get(id);
  if (c === undefined) {
    c = { total: 0, dropped: 0 };
    totals.set(id, c);
  }
  return c;
}

/**
 * One tick, 16 ms, mirroring the Rust batcher: build per-project batches, drop rows for
 * projects that are not visible, and split anything over `MAX_ROWS_PER_BATCH`.
 */
function tick(): void {
  if (onBatch === null) return;
  const now = Date.now();
  const byProject = new Map<string, Pending>();

  for (const s of [...sessions.values()]) {
    if (s.view.status !== "running") continue;
    const projectId = s.view.project_id ?? projects[0]!.id;
    let p = byProject.get(projectId);
    if (p === undefined) {
      p = { rows: [], signals: [], counters: new Map() };
      byProject.set(projectId, p);
    }

    if (s.until !== null && now >= s.until) {
      s.view.status = "exited";
      s.view.ended_at_ms = now;
      s.view.exit_code = 0;
      p.signals.push(envelope(s, { type: "session-exited", reason: "graceful", exit_code: 0 }));
      continue;
    }

    s.debt += (s.rps * 16) / 1000;
    const n = Math.floor(s.debt);
    s.debt -= n;
    const c = counter(s.view.session_id);
    const show = visible.has(projectId);
    for (let i = 0; i < n; i++) {
      // Both read the *pre-increment* seq, because `row` is what advances it. Same argument,
      // same switch: the line and its kind cannot drift apart.
      const line = terseLine(s.seq);
      const kind = terseKind(s.seq);
      c.total += 1;
      if (show) p.rows.push(row(s, line, kind));
      else {
        c.dropped += 1;
        s.seq += 1;
      }
    }
    if (n > 0) p.counters.set(s.view.session_id, { total: c.total, dropped: c.dropped });

    // A completed turn roughly every 100 rows, so cost and usage move visibly.
    if (n > 0 && s.seq % 100 < n) {
      s.cost += 0.0031;
      s.view.cost_usd_cumulative = s.cost;
      s.view.usage = {
        input_tokens: s.seq * 31,
        output_tokens: s.seq * 7,
        cache_read_tokens: s.seq * 120,
        cache_creation_tokens: s.seq * 4,
        context_window: 200_000,
      };
      p.signals.push(
        envelope(s, {
          type: "turn-completed",
          turn_id: `t-${s.turnId++}`,
          stop_reason: "end-turn",
          usage: s.view.usage,
          cost_usd_cumulative: s.cost,
        }),
      );
    }
  }

  // Approval stress tests are opt-in. Normal browser previews auto-allow simulated tools.
  approvalClock += 16;
  if (params().get("approvals") === "manual" && approvalClock >= 4000) {
    approvalClock = 0;
    const running = [...sessions.values()].find((s) => s.view.status === "running");
    if (running !== undefined && approvals.size < 4) {
      const projectId = running.view.project_id ?? projects[0]!.id;
      let p = byProject.get(projectId);
      if (p === undefined) {
        p = { rows: [], signals: [], counters: new Map() };
        byProject.set(projectId, p);
      }
      const requestId = `r-${nextId++}`;
      const kind: RequestKind = {
        type: "tool-permission",
        tool_name: pick(TOOLS, requestId.length + approvals.size),
        input_excerpt: JSON.stringify(
          {
            [MOCK_MARKER]: MOCK_NOTE,
            command: "rm -rf ./target/debug/incremental",
            description: "clear the incremental cache",
            file_path: pick(PATHS, approvals.size),
          },
          null,
          2,
        ),
        suggestions: [
          { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm:*" }], behavior: "allow" },
          { type: "setMode", mode: "acceptEdits" },
        ],
        tool_call_id: `toolu_${requestId}`,
      };
      approvals.set(requestId, {
        request_id: requestId,
        session_id: running.view.session_id,
        opened_at_ms: Date.now(),
        kind,
        expired: false,
        resolved: false,
      });
      p.signals.push(
        envelope(running, { type: "request-opened", request_id: requestId, kind, turn_id: null }),
      );
    }
  }

  sweepRuns(byProject);

  for (const [projectId, p] of byProject) {
    if (p.rows.length === 0 && p.signals.length === 0 && p.counters.size === 0) continue;
    const counters = [...p.counters].map(([session_id, c]) => ({
      session_id,
      rows_total: c.total,
      rows_dropped: c.dropped,
    }));
    if (p.rows.length === 0) {
      onBatch({ project_id: projectId, rows: [], signals: p.signals, counters });
      continue;
    }
    // Split like the Rust side does: at most MAX_ROWS_PER_BATCH rows per message.
    for (let i = 0; i < p.rows.length; i += MAX_ROWS_PER_BATCH) {
      const first = i === 0;
      onBatch({
        project_id: projectId,
        rows: p.rows.slice(i, i + MAX_ROWS_PER_BATCH),
        signals: first ? p.signals : [],
        counters: first ? counters : [],
      });
    }
  }
}

function startTicking(): void {
  if (ticking) return;
  ticking = true;
  setInterval(tick, 16);
}

/* ------------------------------------------------------ cross-project seed */

/**
 * One pending approval on `projects[1]`, i.e. **not** the project the UI selects on mount.
 *
 * It exists so the reload behaviour is visible under plain `npm run dev` without Tauri: the
 * approvals panel must show this card even though `scratch` is not the selected project. Before
 * `App.tsx`'s `approvalRows` this card was filtered out and looked lost
 * (`docs/research/approvals.md` §7 gap 7).
 *
 * It is placed in the `approvals` map only — no `request-opened` signal — so it arrives the way
 * a reload survivor does: through `pending_approvals()` on mount. It is synthetic: no `claude`
 * process, no model call, no spend.
 */
function seedCrossProjectApproval(): void {
  const project = projects[1];
  if (project === undefined) return;
  // 2 rows/sec: enough to prove the session is alive, far below the ambient load generator.
  // Deliberately worktree-less (`withWorktree: false`), which is the contract's non-git-repo
  // case: it is the one mock session whose sidebar row shows no branch chip and whose composer
  // offers no "Clean up worktree".
  const s = makeSession(project.id, "claude-haiku-4-5", 2, null, false);
  row(s, `MOCK · ${MOCK_NOTE}`, "sys");
  const requestId = "r-mock-cross-project";
  approvals.set(requestId, {
    request_id: requestId,
    session_id: s.view.session_id,
    opened_at_ms: Date.now() - 30_000,
    kind: {
      type: "tool-permission",
      tool_name: "Bash",
      input_excerpt: JSON.stringify(
        {
          [MOCK_MARKER]: MOCK_NOTE,
          command: "echo mock-cross-project-approval",
          description: `pending on project "${project.name}", which is not the one selected on mount`,
        },
        null,
        2,
      ),
      suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo:*" }], behavior: "allow" },
      ],
      tool_call_id: `toolu_${requestId}`,
    },
    expired: false,
    // Structurally always false: the Rust query filters `resolved_at IS NULL`
    // (`crates/supervisor/src/lib.rs:461-472`). Kept for shape parity with the contract.
    resolved: false,
  });
}

/* ------------------------------------------------------------------ runs */

/**
 * The synthetic run: `docs/plans/ipc-contract.md` §"The run", moving.
 *
 * **Everything below is a pure function of wall-clock elapsed time.** `start_run` records the
 * moment it was called and nothing else; `current_run` recomputes the whole `RunView` from
 * `Date.now() - createdAt` on every call. There is no timer, no state machine and nothing to keep
 * in step — which is also what makes it testable: a test moves `Date.now()` and reads the phase.
 *
 * A static object would have proven nothing, so the timeline deliberately walks the whole surface
 * the card has to draw, and every one of the contract's four rules is exercised by it:
 *
 *   - two phases go `pending → running → green` on a passing gate;
 *   - phase 3's gate **fails** (`last_exit_code: 1`) while it is still running, is retried, and
 *     then **blocks** — the red-then-blocked path;
 *   - phase 4 has **`verify_command: null`** and therefore never moves at all: nothing can take it
 *     green through a gate, and the card has to say so rather than draw a fifth ordinary row;
 *   - phase 5 ends with a work order at **`state: "unknown"`**, which blocks it permanently, and
 *     that is what puts two rows on `unsettled_intents`.
 *
 * **What this is not.** The mock advances every phase on a clock. What a real blocked phase does
 * to the phases after it is the loop's policy, it lives on the Rust side, and this file does not
 * guess at it — phase 5 running after phase 3 blocked is an artifact of the clock, not a claim.
 *
 * No `claude` process is spawned, no model is called and nothing is billed, exactly as for every
 * other fixture in this file.
 */
interface MockRun {
  planId: string;
  projectId: string;
  goal: string;
  createdAt: number;
  /** `stop_run` was called: dispatch stopped, so the clock the plan is derived from stops too. */
  stoppedAt: number | null;
  /** Intent ids the owner has already answered with `settle_intent`. */
  settled: Set<string>;
  /** The `runtime-warning` for the unknown work order has been emitted once. */
  warned: boolean;
}

/** One run per project, keyed by project id. `current_run` is "the newest plan for the project". */
const runs = new Map<string, MockRun>();

/** Milestones on the run's own clock, in ms since `start_run`. */
const T_APPROVE = 1_200;
const T_P1_GREEN = 2_400;
const T_P2_GREEN = 3_600;
/** The first failing gate: phase 3 is running and its exit code is already non-zero. */
const T_P3_RED = 4_200;
const T_P3_BLOCK = 4_800;
const T_P5_START = 4_800;
/** Something moved in phase 5's worktree that the reconciler cannot account for. */
const T_UNKNOWN = 5_600;

function elapsedOf(run: MockRun): number {
  return (run.stoppedAt ?? Date.now()) - run.createdAt;
}

function order(
  id: string,
  title: string,
  ownedPaths: string[],
  state: WorkOrderView["state"],
  report: string | null,
): WorkOrderView {
  const hex = id.slice(-4);
  return {
    order_id: id,
    title,
    owned_paths: ownedPaths,
    state,
    session_id: state === "pending" ? null : `s-run-${hex}`,
    branch: state === "pending" ? null : `brigadier/run${hex}`,
    worktree_path: state === "pending" ? null : `/mock/worktrees/run${hex}`,
    report,
  };
}

/**
 * The five phases at `e` ms into the run.
 *
 * `last_evidence` is a bounded sentence on every arm and **never a log tail**: the verify
 * command's output goes to a file and to a worker's window, never onto this wire
 * (`docs/vision.md` §4 step 7.5).
 */
function phasesAt(e: number): PhaseView[] {
  const started = e >= T_APPROVE;
  return [
    {
      phase_id: "ph-1",
      ordinal: 1,
      title: "Pin the intent tables in the store schema",
      definition_of_done: "`intents` and `intent_closes` exist, and the round-trip test passes.",
      verify_command: "cargo test -p brigadier-store",
      state: !started ? "pending" : e < T_P1_GREEN ? "running" : "green",
      attempts: !started ? 0 : 1,
      base_sha: started ? "0d4e11b" : null,
      commit_sha: e >= T_P1_GREEN ? "a1c9f04" : null,
      last_exit_code: e >= T_P1_GREEN ? 0 : null,
      last_evidence: e >= T_P1_GREEN ? "41 passed, 0 failed" : null,
      orders: [
        order(
          "or-1a",
          "Write the schema and its migration",
          ["crates/store/src/schema.rs", "crates/store/src/intents.rs"],
          !started ? "pending" : e < T_P1_GREEN ? "dispatched" : "reported",
          e >= T_P1_GREEN ? "Two tables added; the migration is idempotent." : null,
        ),
      ],
    },
    {
      phase_id: "ph-2",
      ordinal: 2,
      title: "Reconcile a worktree the harness lost track of",
      definition_of_done: "Every still-open intent is settled at startup.",
      verify_command: "cargo clippy --all-targets -- -D warnings",
      state: e < T_P1_GREEN ? "pending" : e < T_P2_GREEN ? "running" : "green",
      attempts: e < T_P1_GREEN ? 0 : 1,
      base_sha: e >= T_P1_GREEN ? "a1c9f04" : null,
      commit_sha: e >= T_P2_GREEN ? "77b0e2d" : null,
      last_exit_code: e >= T_P2_GREEN ? 0 : null,
      last_evidence: e >= T_P2_GREEN ? "no warnings" : null,
      orders: [
        order(
          "or-2a",
          "Run the postconditions in opened_at order",
          ["crates/supervisor/src/reconcile.rs"],
          e < T_P1_GREEN ? "pending" : e < T_P2_GREEN ? "dispatched" : "reported",
          e >= T_P2_GREEN ? "Seven rows settled, one left unknown." : null,
        ),
      ],
    },
    {
      // The red one. It fails its gate while still running, is retried, and then blocks.
      phase_id: "ph-3",
      ordinal: 3,
      title: "Gate the run surface",
      definition_of_done: "`npm test` is green and the count does not go down.",
      verify_command: "npm test",
      state: e < T_P2_GREEN ? "pending" : e < T_P3_BLOCK ? "running" : "blocked",
      attempts: e < T_P2_GREEN ? 0 : e < T_P3_BLOCK ? 1 : 2,
      base_sha: e >= T_P2_GREEN ? "77b0e2d" : null,
      commit_sha: null,
      last_exit_code: e >= T_P3_RED ? 1 : null,
      last_evidence: e >= T_P3_RED ? "2 failed, 146 passed" : null,
      orders: [
        order(
          "or-3a",
          "Make the plan card render its own failure",
          ["src/components/RunCard.tsx"],
          e < T_P2_GREEN ? "pending" : e < T_P3_BLOCK ? "dispatched" : "failed",
          e >= T_P3_BLOCK ? "The gate stayed red after a second attempt." : null,
        ),
      ],
    },
    {
      /*
       * **No gate.** `verify_command` is null, so nothing can take this phase green through one,
       * and it stays `pending` for the life of the run. The card must say that rather than draw a
       * row that looks like the four around it, and it must never invent a command to fill the
       * hole (contract §"The run").
       */
      phase_id: "ph-4",
      ordinal: 4,
      title: "Write the operator notes for the loop",
      definition_of_done: "A human can read what the loop did without opening a terminal.",
      verify_command: null,
      state: "pending",
      attempts: 0,
      base_sha: null,
      commit_sha: null,
      last_exit_code: null,
      last_evidence: null,
      orders: [],
    },
    {
      // Ends with a work order the reconciler cannot account for, which blocks the phase.
      phase_id: "ph-5",
      ordinal: 5,
      title: "Collect the parallel worktrees",
      definition_of_done: "Every dispatched order is accounted for and its checkout is gone.",
      verify_command: "cargo test --workspace",
      state: e < T_P5_START ? "pending" : e < T_UNKNOWN ? "running" : "blocked",
      attempts: e < T_P5_START ? 0 : 1,
      base_sha: e >= T_P5_START ? "77b0e2d" : null,
      commit_sha: null,
      last_exit_code: null,
      last_evidence: e >= T_UNKNOWN ? "one worktree moved and cannot be accounted for" : null,
      orders: [
        order(
          "or-5a",
          "Sweep the finished checkouts",
          ["crates/supervisor/src/worktree.rs"],
          e < T_P5_START ? "pending" : e < T_UNKNOWN ? "dispatched" : "reported",
          e >= T_UNKNOWN ? "Four checkouts removed, one left alone." : null,
        ),
        order(
          "or-5b",
          "Land the phase branches on their base",
          ["crates/supervisor/src/merge.rs"],
          e < T_P5_START ? "pending" : e < T_UNKNOWN ? "dispatched" : "unknown",
          null,
        ),
      ],
    },
  ];
}

function runView(run: MockRun): RunView {
  const e = elapsedOf(run);
  const approved = e >= T_APPROVE;
  return {
    plan_id: run.planId,
    project_id: run.projectId,
    goal: run.goal,
    status: !approved ? "draft" : run.stoppedAt !== null ? "abandoned" : "approved",
    revision: approved ? 2 : 1,
    created_at_ms: run.createdAt,
    approved_at_ms: approved ? run.createdAt + T_APPROVE : null,
    phases: phasesAt(e),
    unknowns: [
      {
        unknown_id: "un-1",
        bin: "owner",
        question: "Land each phase on main, or open one pull request per phase?",
        state: approved ? "skipped" : "open",
        skipped_for_just_go: approved,
      },
      {
        unknown_id: "un-2",
        bin: "research",
        question: "Does `git worktree remove` clear a lock this git version holds?",
        state: approved ? "answered" : "open",
        skipped_for_just_go: false,
      },
    ],
  };
}

/**
 * The intents `unsettled_intents` reports, minus the ones the owner has answered.
 *
 * Two rows, and the second is not decoration: **`kind` is a pass-through slug, not a closed set**
 * (contract §"The run"), so one of them carries a slug this build does not know — `db_migrate`,
 * the same example `crates/store/src/intents.rs` uses in its own pinning test. A card that
 * hid it, or crashed on it, would be exactly the older-webview break the pass-through exists to
 * prevent.
 */
function intentsFor(run: MockRun): IntentView[] {
  if (elapsedOf(run) < T_UNKNOWN) return [];
  const opened = run.createdAt + T_UNKNOWN;
  const all: IntentView[] = [
    {
      intent_id: "in-work-order",
      kind: "work_order",
      state: "unknown",
      session_id: "s-run-5b",
      project_id: run.projectId,
      opened_at_ms: opened,
      subject: "/mock/worktrees/run5b",
      evidence: "1 commit and 3 dirty files above the dispatch baseline",
    },
    {
      intent_id: "in-db-migrate",
      kind: "db_migrate",
      state: "unknown",
      session_id: null,
      project_id: run.projectId,
      opened_at_ms: opened + 40,
      subject: "crates/store/migrations/0002_intents.sql",
      evidence: "kind db_migrate is not one this build knows",
    },
  ];
  return all.filter((i) => !run.settled.has(i.intent_id)).sort((a, b) => a.opened_at_ms - b.opened_at_ms);
}

/**
 * The one signal the run needs, and it needs no channel of its own: the reconciler emits a
 * `runtime-warning` for an intent it could not settle, and the plan card refetches `current_run`
 * on it (contract §"The run" → Signals). Emitted once per run, on the first tick after the
 * unknown work order appears.
 *
 * It goes out on a running session of the run's own project, because an `Envelope` names a
 * session and `envelope()` is what keeps `seq` climbing from that session's own counter — the
 * landmine the contract restates: a synthesized row numbered from zero rewrites the session's
 * oldest rows in place.
 */
function sweepRuns(byProject: Map<string, Pending>): void {
  for (const run of runs.values()) {
    if (run.warned || run.stoppedAt !== null || elapsedOf(run) < T_UNKNOWN) continue;
    const host = [...sessions.values()].find(
      (s) => s.view.status === "running" && s.view.project_id === run.projectId,
    );
    if (host === undefined) continue;
    run.warned = true;
    let p = byProject.get(run.projectId);
    if (p === undefined) {
      p = { rows: [], signals: [], counters: new Map() };
      byProject.set(run.projectId, p);
    }
    p.signals.push(
      envelope(host, {
        type: "runtime-warning",
        message: "a work order's worktree moved and cannot be accounted for (mock)",
      }),
    );
  }
}

/* -------------------------------------------------------------- the impl */

function requireSession(sessionId: string): MockSession {
  const s = sessions.get(sessionId);
  if (s === undefined) throw new AppError("no_such_session", `no such session: ${sessionId}`);
  return s;
}

/* ---------------------------------------------------------------- deleting
 *
 * `docs/plans/ipc-contract.md` §Deleting. The half of it worth having in a browser is the
 * **refusal**: `removed: false` resolves rather than rejecting, so a front end that rendered it as
 * a success would look correct in every test that only ever saw the happy path. The mock refuses
 * every un-forced delete of a live checkout, so that branch is the *default* one `npm run dev`
 * walks into.
 *
 * Nothing here touches a disk. No `git` runs, no directory is removed and no process is killed.
 */

/** Every count zero — what a refusal carries, and the base every success is built from. */
function noRows(): DeletedRows {
  return {
    projects: 0,
    sessions: 0,
    feed: 0,
    approvals: 0,
    intents: 0,
    plans: 0,
    phases: 0,
    plan_revisions: 0,
    unknowns: 0,
    work_orders: 0,
    work_orders_orphaned: 0,
  };
}

/** Drop one session's rows from the mock's own state, and report what went. */
function purgeSession(sessionId: string): { feed: number; approvals: number } {
  conversations.delete(sessionId);
  const feed = feedRows.get(sessionId)?.length ?? 0;
  let gone = 0;
  for (const [id, a] of approvals) {
    if (a.session_id === sessionId && approvals.delete(id)) gone += 1;
  }
  sessions.delete(sessionId);
  feedRows.delete(sessionId);
  return { feed, approvals: gone };
}

export const mockBridge: Bridge = {
  isMock: true,

  async subscribeFeed(cb) {
    onBatch = cb;
    // `seeded`, not `sessions.size === 0`: the cross-project approval below creates a session of
    // its own, and React StrictMode calls this twice. Both would otherwise skew the load.
    if (!seeded) {
      seeded = true;
      // All ambient sessions land in the first project, so the default view carries the whole
      // `?rps=` load. `burn` puts its sessions in a project of its own that starts invisible,
      // which is what exercises the drop-to-counters path for a project that is not visible.
      const per = AMBIENT_RPS / AMBIENT_SESSIONS;
      for (let i = 0; i < AMBIENT_SESSIONS; i++) {
        const sample=makeSession(projects[0]!.id, "claude-sonnet-4-5", per, null);
        seedConversation(sample.view.session_id);
      }
      if (params().get("approvals") === "manual") seedCrossProjectApproval();
    }
    startTicking();
  },

  async setVisibleProjects(projectIds) {
    visible = new Set(projectIds);
  },

  async appInfo() {
    return { run_id: RUN_ID, data_dir: "/mock/data-dir", version: "0.1.0-mock" };
  },

  async probeClaude() {
    return { binary: "/opt/homebrew/bin/claude", version: "2.1.257 (mock)" };
  },

  async listModels() {
    // Mirrors `src-tauri/src/views.rs` `models()` exactly — same ids, labels and default flag.
    return [
      { id: "claude-haiku-4-5", label: "Haiku 4.5 — cheapest", default: true },
      { id: "claude-sonnet-5", label: "Sonnet 5", default: false },
      { id: "claude-opus-5", label: "Opus 5", default: false },
      { id: "claude-fable-5-1", label: "Fable 5.1 — most expensive", default: false },
      { id: "haiku", label: "haiku (CLI alias, latest)", default: false },
      { id: "sonnet", label: "sonnet (CLI alias, latest)", default: false },
      { id: "opus", label: "opus (CLI alias, latest)", default: false },
      { id: "fable", label: "fable (CLI alias, latest)", default: false },
    ];
  },

  async listProjects() {
    return projects.map((p) => ({ ...p }));
  },

  async addProject(path) {
    const trimmed = path.trim();
    if (trimmed === "" || !trimmed.startsWith("/")) {
      throw new AppError("invalid_argument", `not an absolute path: ${path}`);
    }
    const p: ProjectView = {
      id: `p-${nextId++}`,
      name: trimmed.split("/").filter(Boolean).pop() ?? trimmed,
      root_path: trimmed,
      created_at_ms: Date.now(),
    };
    projects.push(p);
    visible.add(p.id);
    return { ...p };
  },

  /**
   * A browser has no native directory picker, and faking one would be inventing progress. `null`
   * is the same answer a cancelled real picker gives, so every caller already handles it — and
   * the UI does not offer the button at all while `isMock` is true, so this is unreachable from
   * the app itself.
   */
  async pickDirectory() {
    return null;
  },

  /** Nothing to reveal outside a desktop window. */
  async revealPath() {},

  async listSessions() {
    return [...sessions.values()]
      .map((s) => ({ ...s.view }))
      .sort((a, b) => (b.started_at_ms ?? 0) - (a.started_at_ms ?? 0));
  },

  async startSession({ projectId, prompt, model }: StartSessionArgs) {
    if (!projects.some((p) => p.id === projectId)) {
      throw new AppError("no_such_project", `no such project: ${projectId}`);
    }
    const s = makeSession(projectId, model ?? "claude-sonnet-4-5", 12, null);
    row(s, `user · ${prompt.slice(0, 120)}`, "user");
    appendChat(s.view.session_id,{type:"user-text"},prompt);
    appendChat(s.view.session_id,{type:"assistant-text"},"Browser preview: your message was received. Open the desktop app to run a real agent.");
    return { ...s.view };
  },

  /**
   * Synthetic resume. It does what the contract says `resume_session` does and nothing else:
   * same `session_id`, same feed, `status: "starting"` with `ended_at_ms` and `exit_code` back to
   * null, and it **stays** `starting` until the first turn (`sendTurn` below is what announces
   * the child). No process is spawned and no model is called.
   */
  async resumeSession(sessionId) {
    const s = requireSession(sessionId);
    if (s.view.provider_session_id === null) {
      throw new AppError("not_resumable", "no stored resume token for this session (mock)");
    }
    if (s.view.status !== "exited" && s.view.status !== "failed") {
      throw new AppError("not_resumable", `session is ${s.view.status}, not exited or failed (mock)`);
    }
    if (s.worktreeRemoved) {
      throw new AppError(
        "not_resumable",
        `working directory no longer exists: ${s.view.worktree_path ?? s.view.cwd} (mock)`,
      );
    }
    s.view.status = "starting";
    s.view.ended_at_ms = null;
    s.view.exit_code = null;
    s.view.started_at_ms = Date.now();
    row(s, `MOCK · resumed · ${MOCK_NOTE}`, "sys");
    return { ...s.view };
  },

  /**
   * Synthetic worktree cleanup. `force: false` always reports the tree dirty with two files and
   * touches nothing — that is the branch of the contract worth exercising in the browser; the
   * same call with `force: true` reports it removed. No `git` runs and no directory is deleted.
   */
  async cleanupWorktree(sessionId, force) {
    const s = requireSession(sessionId);
    if (s.view.status === "running" || s.view.status === "starting") {
      throw new AppError("session_running", "end or kill the session first (mock)");
    }
    if (s.view.branch === null) {
      throw new AppError("invalid_argument", "this session has no worktree (mock)");
    }
    // The full `WorktreeCleanup` shape: the Rust always serialises `commits`, `live_branch` and
    // `blocked`, and the composer renders a different sentence per `blocked` reason.
    const base = { dirty_files: 0, commits: 0, branch: s.view.branch, live_branch: s.view.branch };
    if (s.worktreeRemoved) return { ...base, removed: true, blocked: null };
    if (!force) return { ...base, removed: false, dirty_files: 2, blocked: "dirty" as const };
    s.worktreeRemoved = true;
    // The branch survives every cleanup path, so `view.branch` is deliberately left alone.
    return { ...base, removed: true, blocked: null };
  },

  /** Remove history and stop simulated activity; worktrees are retained. */
  async deleteSession(sessionId): Promise<SessionDeletion> {
    const s = requireSession(sessionId);
    const branch = s.view.branch;
    const worktree = null;
    const run = s.view.project_id ? runs.get(s.view.project_id) : undefined;
    if (run) run.stoppedAt = Date.now();
    const purged = purgeSession(sessionId);
    return {
      session_id: sessionId,
      removed: true,
      rows: { ...noRows(), sessions: 1, feed: purged.feed, approvals: purged.approvals },
      worktree,
      logs_removed: 1,
      branch,
    };
  },

  /** Remove the project from Brigadier only. */
  async deleteProject(projectId): Promise<ProjectDeletion> {
    const project = projects.find(p => p.id === projectId);
    if (!project) throw new AppError("no_such_project", `no such project: ${projectId}`);
    const own = [...sessions.values()].filter(s => s.view.project_id === projectId);
    const rows = { ...noRows(), projects: 1, sessions: own.length };
    for (const s of own) {
      const purged = purgeSession(s.view.session_id);
      rows.feed += purged.feed;
      rows.approvals += purged.approvals;
    }
    if (runs.delete(projectId)) rows.plans = 1;
    projects.splice(projects.indexOf(project), 1);
    visible.delete(projectId);
    return {
      project_id: projectId,
      removed: true,
      rows,
      worktrees: [],
      logs_removed: own.length,
      gate_logs_removed: 0,
      brigadier_dir_removed: false,
    };
  },

  async sendTurn(sessionId, text) {
    const s = requireSession(sessionId);
    // A resumed session sits in `starting` until a turn is sent; the child announces itself on
    // the first one (contract §resume_session), which is what moves it to `running` here too.
    if (s.view.status === "starting") {
      s.view.status = "running";
      s.view.started_at_ms = Date.now();
      onBatch?.({
        project_id: s.view.project_id ?? projects[0]!.id,
        rows: [],
        signals: [
          envelope(s, {
            type: "session-started",
            provider_session_id: s.view.provider_session_id ?? `prov-${s.view.session_id}`,
            model: s.view.model ?? "claude-sonnet-4-5",
            cwd: s.view.cwd ?? projects[0]!.root_path,
            capabilities: ["mock"],
            resume_token: `mock-resume-${s.view.session_id}`,
          }),
        ],
        counters: [],
      });
    } else if (s.view.status !== "running") {
      throw new AppError("session_not_running", `session is ${s.view.status}`);
    }
    row(s, `user · ${text.slice(0, 120)}`, "user");
    appendChat(sessionId,{type:"user-text"},text);
    appendChat(sessionId,{type:"assistant-text"},"Browser preview: no agent was called. Your draft and conversation controls work here; execution runs in the desktop app.");
    return { turn_id: `t-${s.turnId++}` };
  },

  async respond(sessionId, requestId, decision: Decision) {
    const s = requireSession(sessionId);
    const a = approvals.get(requestId);
    if (a === undefined) throw new AppError("no_such_request", `no such request: ${requestId}`);
    approvals.delete(requestId);
    const projectId = s.view.project_id ?? projects[0]!.id;
    onBatch?.({
      project_id: projectId,
      rows: [],
      signals: [envelope(s, { type: "request-resolved", request_id: requestId, decision })],
      counters: [],
    });
  },

  async interrupt(sessionId) {
    const s = requireSession(sessionId);
    onBatch?.({
      project_id: s.view.project_id ?? projects[0]!.id,
      rows: [],
      signals: [
        envelope(s, { type: "turn-aborted", turn_id: `t-${s.turnId}`, reason: "interrupted" }),
      ],
      counters: [],
    });
  },

  async endSession(sessionId) {
    const s = requireSession(sessionId);
    s.view.status = "exited";
    s.view.ended_at_ms = Date.now();
    s.view.exit_code = 0;
    onBatch?.({
      project_id: s.view.project_id ?? projects[0]!.id,
      rows: [],
      signals: [envelope(s, { type: "session-exited", reason: "graceful", exit_code: 0 })],
      counters: [],
    });
  },

  async kill(sessionId) {
    const s = requireSession(sessionId);
    s.view.status = "failed";
    s.view.ended_at_ms = Date.now();
    onBatch?.({
      project_id: s.view.project_id ?? projects[0]!.id,
      rows: [],
      signals: [envelope(s, { type: "session-exited", reason: "killed", exit_code: null })],
      counters: [],
    });
  },

  async feedTail(sessionId, n) {
    const tail = feedRows.get(sessionId) ?? [];
    return tail.slice(Math.max(0, tail.length - n));
  },

  async pendingApprovals() {
    return [...approvals.values()].sort((a, b) => a.opened_at_ms - b.opened_at_ms);
  },

  /* ---------------------------------------------------------------- the run */

  async startRun(projectId, goal) {
    if (!projects.some((p) => p.id === projectId)) {
      throw new AppError("no_such_project", `no such project: ${projectId}`);
    }
    if (goal.trim() === "") throw new AppError("invalid_argument", "the goal is empty");
    const existing = runs.get(projectId);
    // Live means "not stopped", which matches `runIsLive` in the front end: this run's status is
    // `draft` and then `approved`, and it never reaches `done` — phase 3 blocks and phase 4 has
    // no gate to go green through, so the only way out of it is the owner pressing Stop.
    if (existing !== undefined && existing.stoppedAt === null) {
      throw new AppError("run_already_live", `a run is already live on ${projectId} (mock)`);
    }
    const run: MockRun = {
      planId: `pl-${nextId++}`,
      projectId,
      goal: goal.trim(),
      createdAt: Date.now(),
      stoppedAt: null,
      settled: new Set(),
      warned: false,
    };
    runs.set(projectId, run);
    startTicking();
    return runView(run);
  },

  async currentRun(projectId) {
    const run = runs.get(projectId);
    return run === undefined ? null : runView(run);
  },

  /**
   * Stops dispatching, and **kills nothing** — the contract's own rule, and the reason the cheap
   * implementation of "stop" is the one that poisons the plan. Here that is literal: the plan is
   * derived from elapsed time, so freezing the clock is exactly "no further orders go out", and
   * every phase keeps the state it had.
   */
  async stopRun(planId) {
    const run = [...runs.values()].find((r) => r.planId === planId);
    if (run === undefined) throw new AppError("no_such_plan", `no such plan: ${planId}`);
    if (run.stoppedAt === null) run.stoppedAt = Date.now();
    return;
  },

  async unsettledIntents() {
    return [...runs.values()]
      .flatMap((r) => intentsFor(r))
      .sort((a, b) => a.opened_at_ms - b.opened_at_ms);
  },

  async settleIntent(intentId, state: IntentSettlement) {
    if (state !== "done" && state !== "not_done") {
      throw new AppError("invalid_argument", `not a settlement: ${String(state)}`);
    }
    const run = [...runs.values()].find((r) => intentsFor(r).some((i) => i.intent_id === intentId));
    if (run === undefined) throw new AppError("no_such_intent", `no such intent: ${intentId}`);
    run.settled.add(intentId);
  },

  async recordFrameStats() {
    // The Rust side appends NDJSON; in the browser the console.debug in fps.ts is the record.
  },

  async reportPaint(report) {
    // The Rust side appends one line to `<data_dir>/paint.ndjson` and logs `main()` -> FCP.
    // There is no Rust process here and no `main()` to measure against, so the console is the
    // record; the instrument itself (`src/paint.ts`) is exercised either way.
    console.debug("paint", report);
  },

  // `rows_per_sec` is **per session**, following the Rust signature's own comment in
  // docs/research/feed-rendering.md §4 (`rows_per_sec: f64, // per session`). The ambient
  // `?rps=` generator above is a total across sessions; the two dials are not the same dial.
  async burn({ sessions: n, rowsPerSec, durationS }: BurnArgs) {
    const until = Date.now() + durationS * 1000;
    // Parity with `src-tauri/src/burn.rs`: the burn sessions run under a project the command
    // creates itself, named after the directory basename (`burn`) and *not* made visible. The
    // front end only learns its id by re-reading `list_projects`; until it selects it, every
    // burn row is dropped to counters. Reproducing that here is the point of the mock.
    let burnProject = projects.find((p) => p.name === BURN_PROJECT_NAME);
    if (burnProject === undefined) {
      burnProject = {
        id: `p-${nextId++}`,
        name: BURN_PROJECT_NAME,
        root_path: `/tmp/brigadier-burn/${BURN_PROJECT_NAME}`,
        created_at_ms: Date.now(),
      };
      projects.push(burnProject);
    }
    for (let i = 0; i < n; i++) {
      makeSession(burnProject.id, "claude-sonnet-4-5", rowsPerSec, until);
    }
    startTicking();
  },
};
