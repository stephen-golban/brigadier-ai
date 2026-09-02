/**
 * The only module that spells a Tauri command name or an argument key.
 *
 * Command names are snake_case (Rust); argument keys are camelCase (Tauri's default mapping onto
 * the Rust snake_case parameter names). See `docs/plans/ipc-contract.md` — nothing here may
 * invent a name or a shape.
 *
 * `isTauri()` from `@tauri-apps/api/core` chooses the transport. Outside a Tauri window the
 * in-memory mock in `./mock` serves the same interface, so `npm run dev` in a browser is a
 * complete, exercisable front end.
 */
import { Channel, invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";

import { mockBridge } from "./mock";
import { toAppError } from "./wire";
import type {
  AppInfo,
  ApprovalView,
  ClaudeStatus,
  Decision,
  FeedBatch,
  FeedRowWire,
  FrameStats,
  ModelInfo,
  PaintReport,
  PermissionMode,
  ProjectId,
  ProjectView,
  RequestId,
  SessionId,
  SessionView,
  WorktreeCleanup,
} from "./wire";

export { AppError, toAppError } from "./wire";

/* -------------------------------------------------------------- interface */

export interface StartSessionArgs {
  projectId: ProjectId;
  prompt: string;
  model: string | null;
  permissionMode: PermissionMode;
}

export interface BurnArgs {
  sessions: number;
  rowsPerSec: number;
  durationS: number;
  fixture: string;
}

export interface Bridge {
  /** True when this is the browser mock rather than a real Tauri window. */
  readonly isMock: boolean;

  subscribeFeed(onBatch: (batch: FeedBatch) => void): Promise<void>;
  setVisibleProjects(projectIds: ProjectId[]): Promise<void>;

  appInfo(): Promise<AppInfo>;
  probeClaude(): Promise<ClaudeStatus>;
  listModels(): Promise<ModelInfo[]>;

  listProjects(): Promise<ProjectView[]>;
  addProject(path: string): Promise<ProjectView>;

  listSessions(): Promise<SessionView[]>;
  startSession(args: StartSessionArgs): Promise<SessionView>;
  /** Continue an ended session in place: same `session_id`, same feed, a new child. */
  resumeSession(sessionId: SessionId): Promise<SessionView>;
  sendTurn(sessionId: SessionId, text: string): Promise<{ turn_id: string }>;
  respond(sessionId: SessionId, requestId: RequestId, decision: Decision): Promise<void>;
  interrupt(sessionId: SessionId): Promise<void>;
  endSession(sessionId: SessionId): Promise<void>;
  kill(sessionId: SessionId): Promise<void>;
  /** Remove a session's git worktree. `force: false` asks; a dirty tree comes back untouched. */
  cleanupWorktree(sessionId: SessionId, force: boolean): Promise<WorktreeCleanup>;

  feedTail(sessionId: SessionId, n: number): Promise<FeedRowWire[]>;
  pendingApprovals(): Promise<ApprovalView[]>;

  recordFrameStats(stats: FrameStats): Promise<void>;
  /** Append one timed paint to `<data_dir>/paint.ndjson`. Fire-and-forget at every call site. */
  reportPaint(report: PaintReport): Promise<void>;
  burn(args: BurnArgs): Promise<void>;
}

/* ------------------------------------------------------------ tauri impl */

/**
 * The single `any` in the front end: `invoke`'s argument bag is untyped by construction, and
 * every call site above it is fully typed.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type InvokeArgs = Record<string, any>;

async function call<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

const tauriBridge: Bridge = {
  isMock: false,

  async subscribeFeed(onBatch) {
    const channel = new Channel<FeedBatch>();
    // tauri-runtime.md §4: this runs synchronously inside the eval'd script on the main JS
    // thread. It must do nothing but hand the batch to the module-level buffer.
    channel.onmessage = onBatch;
    await call<void>("subscribe_feed", { onBatch: channel });
  },

  setVisibleProjects: (projectIds) => call<void>("set_visible_projects", { projectIds }),

  appInfo: () => call<AppInfo>("app_info"),
  probeClaude: () => call<ClaudeStatus>("probe_claude"),
  listModels: () => call<ModelInfo[]>("list_models"),

  listProjects: () => call<ProjectView[]>("list_projects"),
  addProject: (path) => call<ProjectView>("add_project", { path }),

  listSessions: () => call<SessionView[]>("list_sessions"),
  startSession: ({ projectId, prompt, model, permissionMode }) =>
    call<SessionView>("start_session", { projectId, prompt, model, permissionMode }),
  resumeSession: (sessionId) => call<SessionView>("resume_session", { sessionId }),
  sendTurn: (sessionId, text) => call<{ turn_id: string }>("send_turn", { sessionId, text }),
  respond: (sessionId, requestId, decision) =>
    call<void>("respond", { sessionId, requestId, decision }),
  interrupt: (sessionId) => call<void>("interrupt", { sessionId }),
  endSession: (sessionId) => call<void>("end_session", { sessionId }),
  kill: (sessionId) => call<void>("kill", { sessionId }),
  cleanupWorktree: (sessionId, force) =>
    call<WorktreeCleanup>("cleanup_worktree", { sessionId, force }),

  feedTail: (sessionId, n) => call<FeedRowWire[]>("feed_tail", { sessionId, n }),
  pendingApprovals: () => call<ApprovalView[]>("pending_approvals"),

  recordFrameStats: (stats) => call<void>("record_frame_stats", { stats }),
  reportPaint: (report) => call<void>("report_paint", { report }),
  burn: ({ sessions, rowsPerSec, durationS, fixture }) =>
    call<void>("burn", { sessions, rowsPerSec, durationS, fixture }),
};

/* ------------------------------------------------------------- selection */

let selected: Bridge | null = null;

/** The bridge for this runtime: real `invoke` inside Tauri, the in-memory mock in a browser. */
export function bridge(): Bridge {
  if (selected === null) selected = isTauri() ? tauriBridge : mockBridge;
  return selected;
}
