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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

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
  IntentId,
  IntentSettlement,
  IntentView,
  ModelInfo,
  PaintReport,
  PermissionMode,
  PlanId,
  ProjectId,
  ProjectView,
  RequestId,
  RunView,
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
  /**
   * The native directory picker behind "Add project". Resolves to the chosen absolute path, or
   * to **`null` when the user cancelled** — `@tauri-apps/plugin-dialog`'s `open()` types
   * `{ directory: true, multiple: false }` as `string | null` and documents `null` as
   * "user cancelled the selection" (`docs/research/tauri-dialog.md` §2). A cancel is not an
   * error and must never be reported as one.
   *
   * The mock answers `null` unconditionally: a browser has no native picker, and
   * `Bridge.isMock` is what the UI gates the button on, so this is never reached there.
   */
  pickDirectory(): Promise<string | null>;
  /**
   * Reveal a path in the OS file manager (Finder). `tauri-plugin-opener`'s `revealItemInDir`,
   * which `opener:default` already permits (`docs/research/tauri-dialog.md` §3). No-op in the
   * mock.
   */
  revealPath(path: string): Promise<void>;

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

  /* ------------------------------------------------------------------ the run
   *
   * `docs/plans/ipc-contract.md` §"The run". Five commands and nothing else: one approved goal,
   * one plan, and a loop that dispatches, gates and commits without a human.
   */

  /** One goal in plain English becomes a plan. Errors: `no_such_project`, `invalid_argument`
   *  (an empty goal), `run_already_live`. */
  startRun(projectId: ProjectId, goal: string): Promise<RunView>;
  /** The newest plan for this project, live or finished, or `null` when there has never been one. */
  currentRun(projectId: ProjectId): Promise<RunView | null>;
  /**
   * Stop dispatching. **This never kills a worker mid-order** (contract §"The run"): a worker
   * killed part-way leaves a worktree whose `work_order` intent reconciles to `unknown`, which
   * blocks its phase permanently. In-flight orders finish and are collected. Errors:
   * `no_such_plan`.
   */
  stopRun(planId: PlanId): Promise<void>;
  /** Every intent the reconciler could not settle, oldest first. Not scoped to a project. */
  unsettledIntents(): Promise<IntentView[]>;
  /** The owner's answer to one of them. Errors: `no_such_intent`, `invalid_argument`. */
  settleIntent(intentId: IntentId, state: IntentSettlement): Promise<void>;

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

  // Not `invoke`, so not `call`: these two are plugin commands with their own JS wrappers, and
  // their rejections are plain `Error`s rather than the `{ code, message }` an `AppError` decodes
  // from. `toAppError` handles both shapes, so the call sites stay uniform.
  async pickDirectory() {
    try {
      return await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a repository",
      });
    } catch (e) {
      throw toAppError(e);
    }
  },
  async revealPath(path) {
    try {
      await revealItemInDir(path);
    } catch (e) {
      throw toAppError(e);
    }
  },

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

  startRun: (projectId, goal) => call<RunView>("start_run", { projectId, goal }),
  currentRun: (projectId) => call<RunView | null>("current_run", { projectId }),
  stopRun: (planId) => call<void>("stop_run", { planId }),
  unsettledIntents: () => call<IntentView[]>("unsettled_intents"),
  settleIntent: (intentId, state) => call<void>("settle_intent", { intentId, state }),

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
