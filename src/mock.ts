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
  Envelope,
  Event,
  FeedBatch,
  FeedRowWire,
  ProjectView,
  RequestKind,
  SessionView,
} from "./wire";
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

function row(s: MockSession, line: string): FeedRowWire {
  s.seq += 1;
  s.view.last_event_seq = s.seq;
  const r: FeedRowWire = { s: s.view.session_id, q: s.seq, t: Date.now(), l: line };
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
      const line = terseLine(s.seq);
      c.total += 1;
      if (show) p.rows.push(row(s, line));
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

  // An approval every ~4 s on the first running session, so the prompt UI has something to do.
  approvalClock += 16;
  if (approvalClock >= 4000) {
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
  row(s, `MOCK · ${MOCK_NOTE}`);
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

/* -------------------------------------------------------------- the impl */

function requireSession(sessionId: string): MockSession {
  const s = sessions.get(sessionId);
  if (s === undefined) throw new AppError("no_such_session", `no such session: ${sessionId}`);
  return s;
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
        makeSession(projects[0]!.id, "claude-sonnet-4-5", per, null);
      }
      seedCrossProjectApproval();
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
    row(s, `user · ${prompt.slice(0, 120)}`);
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
    row(s, `MOCK · resumed · ${MOCK_NOTE}`);
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
    if (s.worktreeRemoved) return { removed: true, dirty_files: 0, branch: s.view.branch };
    if (!force) return { removed: false, dirty_files: 2, branch: s.view.branch };
    s.worktreeRemoved = true;
    // The branch survives every cleanup path, so `view.branch` is deliberately left alone.
    return { removed: true, dirty_files: 0, branch: s.view.branch };
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
    row(s, `user · ${text.slice(0, 120)}`);
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

  async recordFrameStats() {
    // The Rust side appends NDJSON; in the browser the console.debug in fps.ts is the record.
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
