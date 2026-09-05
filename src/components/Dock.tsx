/**
 * The dock: **one text field, and an explicit choice of what pressing enter does.**
 *
 * R2, 2026-09-05. The owner drove the app and asked, in as many words, why there were two text
 * fields. There were two because they did different things and nothing on screen said so: the
 * strip above started a **run** (plan → dispatch → gate → commit) and the box below started a
 * **single session**, or sent a turn to the selected one. Both are real, both are used, and
 * neither was labelled.
 *
 * This file is the answer. One `.dock`, one context strip, one chooser, one field:
 *
 * ```
 *   project · worktree · model                        [ Run ][ Session ][ Turn ]
 *   ┌───────────────────────────────────────────────────────────────────────┐
 *   │  …one text area…                                                      │
 *   │  chip                          Model ▾  Permissions ▾          ( → )   │
 *   └───────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * **No third concept was invented.** The chooser names the three things the app already did:
 *
 *   - **Run** — `start_run` on the selected project. A run outlives every session it dispatches,
 *     which is why the control is per project and not per session. It carries the Model and
 *     Permissions pickers too, since R4: a model chosen here applies to **every** child of the
 *     run — planner, lead, worker, fixer — and choosing none leaves the role-based routing in
 *     charge, which is the better default and is why it is the one the control starts on.
 *   - **Session** — `start_session`: one chat child, with the same two pickers.
 *   - **Turn** — `send_turn` to the selected session. Offered only when a session is selected,
 *     because there is nothing to send a turn to otherwise.
 *
 * The chooser rides in the context strip rather than on a row of its own, so the merge **costs no
 * height**: it removes the 40px run strip (`.run-dock`, 8px of padding over a 32px input) and adds
 * nothing, which is 40px handed back to the approvals dock above it — see `.approval` in
 * `src/index.css` for why that mattered, and `src/layout.test.ts` for the arithmetic.
 *
 * **The mode is derived until the operator overrides it.** `mode` is `null` — "whatever the
 * selection implies" — until a chooser button is pressed, and it returns to `null` whenever the
 * selected session changes. Selecting a session therefore lands on Turn, and clearing the
 * selection lands on Run, without either being sticky in a way that hides the field the operator
 * came for.
 */
import { useEffect, useMemo, useState } from "react";

import { Composer, RunControl } from "./Composer";
import { ModelIcon, PathIcon, ProjectIcon } from "./icons";
import { NewSession } from "./NewSession";
import type { SessionRuntime } from "../feedStore";
import type {
  ModelInfo,
  PermissionMode,
  PlanId,
  ProjectId,
  ProjectView,
  RunView,
  SessionId,
  WorktreeCleanup,
} from "../wire";

/** What the field does. The three actions the app already had, named. */
export type DockMode = "run" | "session" | "turn";

interface ModeOption {
  mode: DockMode;
  label: string;
  /** One clause on the control itself; the dock has no room for a legend. */
  hint: string;
}

const MODES: readonly ModeOption[] = [
  {
    mode: "run",
    label: "Run",
    hint: "hand the project a goal: plan, dispatch, gate, commit — with a model and a permission mode for every child of it",
  },
  { mode: "session", label: "Session", hint: "start one chat child, with a model and a permission mode" },
  { mode: "turn", label: "Turn", hint: "send this to the selected session" },
];

export interface DockProps {
  project: ProjectView | null;
  /** The selected session, or null when none is. Decides whether Turn is on offer. */
  session: SessionRuntime | null;
  models: ModelInfo[];
  /** The newest plan for the selected project, live or finished, or null. */
  run: RunView | null;
  /** An IPC call started here is in flight. */
  busy: boolean;
  /** The `claude` probe failed: nothing may be started, and every mode says so by being inert. */
  blocked: boolean;
  /**
   * R4.1: the model and the permission mode travel with the goal. Both were absent, so the dock's
   * pickers reached nothing and every child of a run took the CLI's default — the owner's first
   * live run showed `claude-opus-5[1m]` in the session header while the picker said Haiku.
   * `null` for the model is a real choice: the harness's role-based routing stays in charge.
   */
  onStartRun: (goal: string, model: string | null, permissionMode: PermissionMode) => void;
  onStopRun: (planId: PlanId) => void;
  onStartSession: (args: {
    projectId: ProjectId;
    prompt: string;
    model: string | null;
    permissionMode: PermissionMode;
  }) => void;
  onSend: (sessionId: SessionId, text: string) => void;
  onInterrupt: (sessionId: SessionId) => void;
  onEnd: (sessionId: SessionId) => void;
  onKill: (sessionId: SessionId) => void;
  onResume: (sessionId: SessionId) => void;
  onCleanup: (sessionId: SessionId, force: boolean) => Promise<WorktreeCleanup | null>;
}

/** Last path segment, so a long cwd does not crowd the strip out. Full path stays in `title`. */
function basename(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length === 0 ? path : parts[parts.length - 1]!;
}

export function Dock(props: DockProps) {
  const { project, session, models, run, busy, blocked } = props;

  /** `null` means "whatever the selection implies"; a press pins it until the selection moves. */
  const [chosen, setChosen] = useState<DockMode | null>(null);
  const sessionId = session?.sessionId ?? null;
  useEffect(() => {
    setChosen(null);
  }, [sessionId]);

  const offered = useMemo(
    () => MODES.filter((m) => m.mode !== "turn" || session !== null),
    [session],
  );

  const implied: DockMode = session !== null ? "turn" : "run";
  // A pinned mode that has stopped being on offer (Turn, after the session was deselected) falls
  // back rather than rendering a body for a thing that is not there.
  const mode: DockMode =
    chosen !== null && offered.some((m) => m.mode === chosen) ? chosen : implied;

  const cwd = session?.cwd ?? project?.root_path ?? null;

  return (
    <section className="dock" aria-label="the composer">
      <div className="dock-context">
        <span title={project?.root_path}>
          <span className="glyph">
            <ProjectIcon />
          </span>
          {project?.name ?? "no project"}
        </span>
        {cwd !== null ? (
          <span title={cwd}>
            <span className="glyph">
              <PathIcon />
            </span>
            {session?.cwd != null ? basename(session.cwd) : cwd}
          </span>
        ) : null}
        {session?.model != null ? (
          <span title={session.model}>
            <span className="glyph">
              <ModelIcon />
            </span>
            {session.model}
          </span>
        ) : null}

        <span className="grow" />

        {/*
          The chooser. `aria-pressed` rather than a radio group: these are three buttons that
          change what the one control below them does, which is what a toggle button is, and a
          radiogroup would promise arrow-key roving this does not implement.
        */}
        <div className="dock-modes">
          {offered.map((m) => (
            <button
              key={m.mode}
              type="button"
              className="dock-mode"
              aria-pressed={mode === m.mode}
              title={m.hint}
              onClick={() => setChosen(m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {mode === "run" ? (
        <RunControl
          projectName={project?.name ?? null}
          canStart={project !== null && !blocked}
          run={run}
          busy={busy}
          models={models}
          onStart={props.onStartRun}
          onStop={props.onStopRun}
        />
      ) : mode === "session" ? (
        <NewSession
          project={project}
          models={models}
          disabled={blocked}
          onStart={props.onStartSession}
        />
      ) : (
        <Composer
          session={session}
          busy={busy}
          onSend={props.onSend}
          onInterrupt={props.onInterrupt}
          onEnd={props.onEnd}
          onKill={props.onKill}
          onResume={props.onResume}
          onCleanup={props.onCleanup}
        />
      )}
    </section>
  );
}
