import type { StartSessionArgs } from "./bridge";
import type { SessionRuntime } from "./feedStore";
import { ZERO_USAGE } from "./wire";

export interface StartupProgress {
  step: "workspace" | "provider" | "session";
  complete: boolean;
  detail: string;
  sessionId?: string;
}

export interface SessionStartup {
  id: string;
  args: StartSessionArgs;
  title: string;
  startedAt: number;
  progress: StartupProgress[];
  error?: string;
  sessionId?: string;
  createdSessionId?: string;
}

/** Prefix of a startup's own sidebar id. No native session command accepts one. */
export const PENDING_PREFIX = "starting:";

export function isPendingSessionId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

/**
 * Whether a sidebar row can be archived — which for a startup means abandoned.
 *
 * A startup is a session in exactly two states: `starting`, which owns an in-flight
 * `start_session` and is protected, and `failed`, which owns nothing the harness is still
 * using and must stay disposable. Before this, every `starting:` id was refused on its prefix
 * alone, so a setup that failed could only be retried (`docs/vision.md` §9).
 */
export function archivableSession(session: Pick<SessionRuntime, "sessionId" | "status">): boolean {
  return !isPendingSessionId(session.sessionId) || session.status === "failed";
}

export function newStartup(args: StartSessionArgs): SessionStartup {
  return {
    id: `${PENDING_PREFIX}${args.requestId}`,
    args,
    title: args.prompt.trim().split("\n")[0]?.slice(0, 100) || "New task",
    startedAt: Date.now(),
    progress: [{ step: "workspace", complete: false, detail: "Preparing workspace" }],
  };
}

/** A sidebar entry only; pending identifiers never address native session commands. */
export function startupRuntime(startup: SessionStartup): SessionRuntime {
  return {
    sessionId: startup.id,
    projectId: startup.args.projectId,
    status: startup.error ? "failed" : "starting",
    model: startup.args.model,
    cwd: null,
    providerSessionId: null,
    worktreePath: null,
    branch: null,
    worktreeRemoved: false,
    resumed: false,
    busy: !startup.error,
    lastTurnId: null,
    lastStop: null,
    costUsd: 0,
    usage: ZERO_USAGE,
    rowsTotal: 0,
    rowsDropped: 0,
    startedAtMs: startup.startedAt,
    endedAtMs: null,
    exitCode: null,
    lastMessage: startup.error ?? "Preparing task…",
    lastEventSeq: 0,
  };
}

export function readStartup(sessionId: string | null): SessionStartup | undefined {
  if (!sessionId) return;
  try {
    const value = JSON.parse(localStorage.getItem(`brigadier:startup:${sessionId}`) ?? "null");
    return value?.sessionId === sessionId && typeof value.args?.prompt === "string" &&
      Array.isArray(value.progress) && value.progress.every((item: StartupProgress) =>
        item && ["workspace", "provider", "session"].includes(item.step) && typeof item.detail === "string")
      ? value : undefined;
  } catch {
    return;
  }
}

export function saveStartup(startup: SessionStartup) {
  if (!startup.sessionId) return;
  try {
    localStorage.setItem(`brigadier:startup:${startup.sessionId}`, JSON.stringify(startup));
  } catch {
    // Setup remains visible for this window when storage is unavailable.
  }
}
