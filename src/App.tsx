/**
 * The whole window: a two-pane shell. Sidebar on the left (projects, their sessions nested
 * underneath, the pending-approvals count and the claude probe); a single thread column on the
 * right holding a quiet header, the feed, the approval cards docked above the composer, and the
 * composer itself centred on a fixed max width.
 *
 * The header is deliberately quiet — 14px name, 11px mono path, one branch chip. `docs/vision.md`
 * §9 is "thread-primary, one column", and the pinned plan card that belongs above the thread is
 * W4-D's; a loud header here would be competing with it before it exists.
 *
 * The composer has two states, as the reference does: with a session selected it sends turns and
 * carries interrupt / end / kill; with none selected it is the "start a session" form.
 *
 * All IPC goes through `bridge()`, which is the real `invoke` inside Tauri and the in-memory
 * mock in a browser, with no code change between the two.
 *
 * **Nothing here is optimistic, and that is current.** `docs/vision.md` §9 wants starting a
 * session, sending a turn and deleting one to paint before Rust confirms, and approvals never to.
 * Every handler below still awaits. An optimistic entry has to be retired by a *specific matched
 * echo* (`TurnStarted.turn_id`) rather than by "the operation finished" — VS Code #332087 is what
 * happens otherwise — and that machinery is not built. Half of it would be worse than none.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { bridge, toAppError } from "./bridge";
import type { BurnArgs, StartSessionArgs } from "./bridge";
import * as store from "./feedStore";
import { beginInteraction } from "./paint";
import type { PaintedSpan } from "./paint";
import { Approvals } from "./components/Approvals";
import type { ApprovalRow } from "./components/Approvals";
import { Burn } from "./components/Burn";
import { Composer } from "./components/Composer";
import { Feed } from "./components/Feed";
import { FpsOverlay } from "./components/FpsOverlay";
import { NewSession } from "./components/NewSession";
import { Sidebar } from "./components/Sidebar";
import type {
  AppError,
  AppInfo,
  ClaudeStatus,
  Decision,
  ModelInfo,
  ProjectId,
  ProjectView,
  RequestId,
  SessionId,
  WorktreeCleanup,
} from "./wire";

/**
 * How much history to pull when a session is selected for the first time.
 *
 * 48, not 500, because the 8192-byte `eval` cliff that governs feed batches
 * (`docs/research/feed-rendering.md` §"Batch size") governs a command response just as much: one
 * oversized reply detours through `fetch` and head-of-line blocks every later message. 48 rows of
 * `{s,q,t,l}` serialize to 7,694 B against 80,241 B for 500. The tail is a first paint, not the
 * scrollback — `store.seedRows` now merges later arrivals into it instead of replacing it.
 */
const TAIL_ROWS = 48;

/** Coalescing window for the `list_projects` re-fetch a feed batch for an unknown project asks for. */
const UNKNOWN_PROJECT_REFETCH_MS = 250;

/**
 * The label **B4** is measured under, written verbatim into `<data_dir>/paint.ndjson`
 * (`docs/plans/ipc-contract.md` §report_paint). Keep it stable: a renamed label silently splits
 * one budget's samples into two files' worth of unrelated lines.
 *
 * This is the first `beginInteraction` call site in the repo. Before it, the interaction half of
 * `src/paint.ts` was tree-shaken out of the production bundle entirely, so B4 in `docs/vision.md`
 * §9 has never been anything but a guess. Adding the caller does not produce a number — that
 * needs a real launch — and it changes no budget.
 */
const B4_LABEL = "b4-session-painted";

/**
 * The project the dev `burn` command creates its sessions under: `<temp>/brigadier-burn/burn`
 * (`src-tauri/src/burn.rs:50`), whose name is the directory basename.
 */
const BURN_PROJECT_NAME = "burn";
const BURN_ROOT_MARKER = "brigadier-burn";

/**
 * Whether the burn panel is in this bundle.
 *
 * **Why this is not just `import.meta.env.DEV`, which is what it was until 2026-09-04.** The Rust
 * side compiles `burn` under `#[cfg(any(debug_assertions, feature = "burn"))]`, so
 * `npm run tauri build -- --features burn` produced a release binary carrying the command and a
 * release bundle with no UI that could call it: `grep -c "burn harness" dist/assets/index-*.js`
 * was **0** while `strings target/release/brigadier` hit `burn started`
 * (`docs/research/visual-checks-2026-09-04.md` §3.2). The consequence is the whole reason this
 * changed: **every burn number this project has is a debug-build number** — debug Rust, the vite
 * dev server, an unminified React development build — and reaching a release burn meant editing
 * this file, which the order that measured it was forbidden to do.
 *
 * `VITE_BURN=1` is the gate, and it costs nothing when it is off. `import.meta.env.VITE_*` is a
 * **build-time literal substitution**, not a runtime lookup, so an unset variable folds this
 * whole expression to `false` and Rollup drops `Burn` and everything it reaches exactly as `DEV`
 * did. Nothing crosses the IPC boundary for it: `docs/plans/ipc-contract.md` binds both sides and
 * this adds no command, no view field and no event.
 *
 *     VITE_BURN=1 npm run tauri build -- --features burn
 *
 * Both halves are needed and they are independent — the flag compiles the Rust command, the
 * variable ships the button. `--features burn` alone still builds a bundle that cannot call it.
 *
 * **[not measured]** No release burn has been run. This makes one reachable; it does not make one
 * a number.
 */
const BURN_UI = import.meta.env.DEV || import.meta.env.VITE_BURN === "1";

export function App() {
  const state = useSyncExternalStore(store.subscribe, store.getState);

  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [claudeError, setClaudeError] = useState<AppError | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<SessionId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The first `list_projects` has landed; before that every id looks unknown. */
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  /** A `resume_session` or `cleanup_worktree` call is in flight; both buttons go inert. */
  const [commandBusy, setCommandBusy] = useState(false);

  /**
   * The session whose `feed_tail` prefill has landed. It exists only to force one commit at the
   * moment the tail is in the store — the B4 span settles against that commit. App deliberately
   * does **not** subscribe to the row rings: `getSessionRows` changes up to 60 times a second,
   * and a shell that re-rendered at that rate would be paying for the instrument with the thing
   * the instrument measures.
   *
   * The rate is measured; the citation this line used to carry is not. "1,513 one-second samples"
   * is **superseded** — `864a2fe` changed the feed's `ROW_H` 18 → 28 on 2026-09-04 and every
   * window in `frame-stats.ndjson` predates it. The standing number is 62 of 62 one-second
   * windows at `hz 60`, `p50 17.0 ms`, under a 10-session burn on the current markup, 2026-09-04
   * (`docs/research/visual-checks-2026-09-04.md` §3.4), on a debug build.
   */
  const [tailSeeded, setTailSeeded] = useState<SessionId | null>(null);

  /** Unknown project ids a re-fetch has already been fired for, and that re-fetch's timer. */
  const refetchedFor = useRef<Set<ProjectId>>(new Set());
  const refetchTimer = useRef<number | null>(null);

  /** The B4 span in flight, and the session it was opened for. At most one, ever. */
  const paintSpan = useRef<{ sessionId: SessionId; span: PaintedSpan } | null>(null);

  const say = useCallback((e: unknown) => {
    const err = toAppError(e);
    setNotice(`${err.code}: ${err.message}`);
  }, []);

  /** Re-read the project list and tell the store which ids are now accounted for. */
  const refreshProjects = useCallback(async (): Promise<ProjectView[]> => {
    const list = await bridge().listProjects();
    setProjects(list);
    store.noteProjects(list.map((p) => p.id));
    return list;
  }, []);

  // Mount: open the feed channel, start the one rAF loop, then load everything else.
  useEffect(() => {
    const b = bridge();
    let cancelled = false;

    store.start();
    void b.subscribeFeed(store.pushBatch).catch(say);

    void (async () => {
      const [info, projectList, modelList, sessionList, pending] = await Promise.all([
        b.appInfo().catch(() => null),
        b.listProjects().catch((e: unknown) => {
          say(e);
          return [] as ProjectView[];
        }),
        b.listModels().catch(() => [] as ModelInfo[]),
        b.listSessions().catch(() => []),
        b.pendingApprovals().catch(() => []),
      ]);
      if (cancelled) return;
      setAppInfo(info);
      setProjects(projectList);
      store.noteProjects(projectList.map((p) => p.id));
      setProjectsLoaded(true);
      setModels(modelList);
      store.seedSessions(sessionList);
      store.seedApprovals(pending);
      if (projectList.length > 0) setSelectedProjectId((prev) => prev ?? projectList[0]!.id);
    })();

    void b
      .probeClaude()
      .then((s) => {
        if (!cancelled) setClaude(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setClaudeError(toAppError(e));
      });

    return () => {
      cancelled = true;
      store.stop();
    };
  }, [say]);

  // Visibility drives what the Rust side bothers to send rows for.
  useEffect(() => {
    if (selectedProjectId === null) return;
    void bridge().setVisibleProjects([selectedProjectId]).catch(say);
  }, [selectedProjectId, say]);

  // A batch arrived for a project the sidebar has never listed (the dev `burn` command creates
  // one behind the UI's back). Re-read `list_projects` once per unknown id, coalesced, so the
  // project appears in the sidebar and can be selected; its sessions then arrive as signals.
  useEffect(() => {
    const unknown = state.unknownProjects;
    // Feed batches start before the first `list_projects` answers; those ids are not unknown,
    // they are merely early, and `noteProjects` clears them when the answer lands.
    if (!projectsLoaded || unknown.length === 0) return;
    let fresh = false;
    for (const id of unknown) {
      if (!refetchedFor.current.has(id)) {
        refetchedFor.current.add(id);
        fresh = true;
      }
    }
    // Never cancel a scheduled re-fetch on a dep change: one in flight already covers the batch.
    if (!fresh || refetchTimer.current !== null) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      void refreshProjects().catch(() => {
        // A failed refresh is not worth a banner; the next unknown project retries it.
      });
    }, UNKNOWN_PROJECT_REFETCH_MS);
  }, [state.unknownProjects, projectsLoaded, refreshProjects]);

  // Own teardown, so a dep change above does not cancel the pending re-fetch.
  useEffect(
    () => () => {
      if (refetchTimer.current !== null) clearTimeout(refetchTimer.current);
    },
    [],
  );

  // Prefill a newly selected session's ring from the store's own tail. `seedRows` notifies the
  // feed and `setTailSeeded` re-renders this component; both happen in the same microtask, so
  // React commits them together and the layout effect below runs after the rows are on screen.
  useEffect(() => {
    if (selectedSessionId === null) return;
    const id = selectedSessionId;
    void bridge()
      .feedTail(id, TAIL_ROWS)
      .then((rows) => {
        store.seedRows(id, rows);
        setTailSeeded(id);
      })
      .catch(() => {
        // A missing tail is not worth a banner; the live feed still fills the pane. The span
        // below is settled against it anyway: the pane is as painted as it is going to get.
        setTailSeeded(id);
      });
  }, [selectedSessionId]);

  /**
   * **B4's settle edge**: the commit that paints the selected session's feed rows.
   *
   * A layout effect, not an effect, because it must run before the browser gets a chance to
   * paint anything else; `painted()` then waits the two animation frames itself
   * (`src/paint.ts` — do not reimplement the double-rAF here).
   *
   * Three exits, and the two that report nothing are the point:
   *   - the selection moved on before this span settled → `cancel()`. A duration measured to
   *     some other session's rows is a lie that would be averaged into the budget.
   *   - the rows are there → `painted()`.
   *   - the tail has landed and there are still no rows → `cancel()`. An empty session has no
   *     "last screenful", and timing the empty state would flatter the p95 with paints that
   *     drew nothing.
   * Anything this misses is dropped by `INTERACTION_TIMEOUT_MS` five seconds later.
   */
  useLayoutEffect(() => {
    const pending = paintSpan.current;
    if (pending === null) return;
    if (pending.sessionId !== selectedSessionId) {
      pending.span.cancel();
      paintSpan.current = null;
      return;
    }
    if (store.getSessionRows(selectedSessionId).length > 0) {
      pending.span.painted();
      paintSpan.current = null;
      return;
    }
    if (tailSeeded === selectedSessionId) {
      pending.span.cancel();
      paintSpan.current = null;
    }
  }, [selectedSessionId, tailSeeded]);

  // Unmount: a span left in flight would settle against nothing, or against a later window's
  // rows if this module outlives the tree. Own teardown so no dep change can trigger it.
  useEffect(
    () => () => {
      paintSpan.current?.span.cancel();
      paintSpan.current = null;
    },
    [],
  );

  /**
   * Selecting a session from the sidebar — the interaction B4 names. The span starts here, in
   * the event handler, rather than in an effect: B4 is "click a session → its last screenful
   * painted", and an effect would start the clock after the render the click already caused.
   *
   * Only this path opens a span. `focusApproval`, `startSession` and `resumeSession` also move
   * the selection, and they are different interactions with different budgets; the layout effect
   * above cancels rather than mis-attributes when one of them lands on top of a pending span.
   *
   * **The project selection follows the session**, the same way `focusApproval` below already
   * moves it. Without this the header names `selectedProject`, which is whatever project was
   * last clicked, over a session the sidebar draws nested under a different one — observed on
   * 2026-09-03 as a header reading "brigadier-ai" above a `burn` session. It was latent before
   * the sidebar nested sessions under projects and the header started naming the project; the
   * lie was always being told, nothing was drawing it.
   *
   * It is not only cosmetic. `selectedProjectId` drives the `set_visible_projects` effect above,
   * and the Rust batcher drops rows for a project that is not visible — so selecting a session
   * in an unselected project used to leave its feed silent as well as mislabelled.
   *
   * The project id is read out of the store rather than taken as an argument, so this callback
   * keeps the stable identity `SessionRow`'s memoization depends on. A session the store cannot
   * place leaves the project selection alone, exactly as `focusApproval` does.
   */
  const selectSession = useCallback((id: SessionId | null) => {
    const prev = paintSpan.current;
    if (prev !== null) {
      prev.span.cancel();
      paintSpan.current = null;
    }
    if (id !== null) {
      paintSpan.current = { sessionId: id, span: beginInteraction(B4_LABEL) };
      const owner = store.getState().sessions[id]?.projectId ?? null;
      if (owner !== null) setSelectedProjectId(owner);
    }
    setSelectedSessionId(id);
  }, []);

  const selectedSession = selectedSessionId === null ? null : state.sessions[selectedSessionId] ?? null;

  /**
   * Every pending approval, whatever project it belongs to — the list is deliberately **not**
   * filtered by the selection. A webview reload resets `selectedProjectId` to `projectList[0]`
   * (the effect above), so filtering hid a still-answerable prompt on any other project and read
   * as data loss (`docs/research/approvals.md` §7 gap 7). The project name travels with the card
   * instead; `state.approvals` is already sorted oldest-first by the store.
   */
  const approvalRows = useMemo<ApprovalRow[]>(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    return state.approvals.map((a) => {
      // session_id -> project_id via the store's session list; -> project via `list_projects`.
      const projectId = state.sessions[a.sessionId]?.projectId ?? null;
      return {
        approval: a,
        projectId,
        projectName: projectId === null ? null : byId.get(projectId)?.name ?? projectId,
        elsewhere:
          projectId !== null && selectedProjectId !== null && projectId !== selectedProjectId,
      };
    });
  }, [state.approvals, state.sessions, projects, selectedProjectId]);

  /** Pending approvals per project, for the sidebar badge. */
  const pendingByProject = useMemo(() => {
    const counts: Record<ProjectId, number> = {};
    for (const r of approvalRows) {
      if (r.projectId === null) continue;
      counts[r.projectId] = (counts[r.projectId] ?? 0) + 1;
    }
    return counts;
  }, [approvalRows]);

  /** Jump to the approval's session; its project too when the store knows it. */
  const focusApproval = useCallback((projectId: ProjectId | null, sessionId: SessionId) => {
    if (projectId !== null) setSelectedProjectId(projectId);
    setSelectedSessionId(sessionId);
  }, []);

  const addProject = useCallback(
    (path: string) => {
      void bridge()
        .addProject(path)
        .then((p) => {
          setProjects((prev) => [...prev, p]);
          store.noteProjects([p.id]);
          setSelectedProjectId(p.id);
          setSelectedSessionId(null);
        })
        .catch(say);
    },
    [say],
  );

  const startSession = useCallback(
    (args: StartSessionArgs) => {
      void bridge()
        .startSession(args)
        .then((view) => {
          store.seedSessions([view]);
          setSelectedSessionId(view.session_id);
        })
        .catch(say);
    },
    [say],
  );

  /**
   * Continue an ended session in place. The success path is `startSession`'s, deliberately: the
   * `session_id` does not change, so seeding the returned view and selecting it re-triggers the
   * `feed_tail` prefill above and the old history re-renders under the new child
   * (`docs/plans/ipc-contract.md` §resume_session).
   */
  const resumeSession = useCallback(
    (sessionId: SessionId) => {
      setCommandBusy(true);
      void bridge()
        .resumeSession(sessionId)
        .then((view) => {
          store.seedSessions([view]);
          store.noteResumed(view.session_id);
          setSelectedSessionId(view.session_id);
        })
        .catch(say)
        .finally(() => setCommandBusy(false));
    },
    [say],
  );

  /**
   * Remove a session's git worktree. `force: false` is the question, not the action: a dirty
   * tree comes back `{ removed: false, dirty_files: N }` with nothing touched, and the composer
   * turns that into the confirmation that calls again with `force: true`. Errors are shown in
   * the notice and reported to the composer as `null` so it leaves its own state alone.
   */
  const cleanupWorktree = useCallback(
    async (sessionId: SessionId, force: boolean): Promise<WorktreeCleanup | null> => {
      setCommandBusy(true);
      try {
        const result = await bridge().cleanupWorktree(sessionId, force);
        if (result.removed) store.noteWorktreeRemoved(sessionId);
        return result;
      } catch (e) {
        say(e);
        return null;
      } finally {
        setCommandBusy(false);
      }
    },
    [say],
  );

  const respond = useCallback(
    (sessionId: SessionId, requestId: RequestId, decision: Decision) => {
      void bridge().respond(sessionId, requestId, decision).catch(say);
    },
    [say],
  );

  /**
   * `burn` starts its sessions under a project the Rust side creates itself
   * (`<temp>/brigadier-burn/burn`), whose id this window has never seen. Without the re-fetch and
   * the switch below, the selection stays on the user's project, `set_visible_projects` never
   * names the burn project, and the Rust batcher drops every burn row as invisible — the run
   * reads `rows 0` in thousands of empty batches. The selection is left on the burn project when
   * the run ends; nothing switches back.
   */
  const runBurn = useCallback(
    async (args: BurnArgs) => {
      await bridge().burn(args);
      const list = await refreshProjects();
      // The temp-dir segment is the precise marker; the bare name is the fallback, and would
      // otherwise collide with an operator's own repo called `burn`.
      const candidates = list.filter(
        (p) => p.root_path.includes(BURN_ROOT_MARKER) || p.name === BURN_PROJECT_NAME,
      );
      const burnProject = candidates
        .slice()
        .sort((a, b) => {
          const marked = Number(b.root_path.includes(BURN_ROOT_MARKER)) -
            Number(a.root_path.includes(BURN_ROOT_MARKER));
          return marked !== 0 ? marked : b.created_at_ms - a.created_at_ms;
        })[0];
      if (burnProject === undefined) return;
      // The visibility effect above pushes `set_visible_projects([burnProject.id])` off this.
      setSelectedProjectId(burnProject.id);
      setSelectedSessionId(null);
    },
    [refreshProjects],
  );

  const selectedProject =
    selectedProjectId === null ? null : projects.find((p) => p.id === selectedProjectId) ?? null;
  const pendingTotal = approvalRows.length;

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        sessions={state.sessions}
        order={state.order}
        selectedProjectId={selectedProjectId}
        selectedSessionId={selectedSessionId}
        pendingApprovals={pendingByProject}
        pendingTotal={pendingTotal}
        appInfo={appInfo}
        claude={claude}
        claudeError={claudeError}
        isMock={bridge().isMock}
        dev={BURN_UI ? <Burn onBurn={runBurn} /> : undefined}
        onSelectProject={setSelectedProjectId}
        onSelectSession={selectSession}
        onAddProject={addProject}
      />

      <main className="thread">
        <header className="thread-head">
          <span className="head-id">
            <span className="head-name">
              <b>{selectedProject?.name ?? "No project"}</b>
              {selectedSession?.branch != null ? (
                <span className="chip plain" title={selectedSession.worktreePath ?? undefined}>
                  {selectedSession.branch}
                  {selectedSession.worktreeRemoved ? " · removed" : ""}
                </span>
              ) : null}
            </span>
            <span className="head-path" title={selectedProject?.root_path ?? undefined}>
              {selectedSession !== null
                ? `${selectedSession.status} · ${selectedSession.sessionId}`
                : selectedProject !== null
                  ? `${selectedProject.root_path} · all sessions`
                  : "nothing selected"}
            </span>
          </span>
          {notice !== null ? (
            <button
              type="button"
              className="notice"
              title="dismiss"
              onClick={() => setNotice(null)}
            >
              <span className="notice-text">{notice}</span>
              {/* Inline SVG rather than a `✕` text glyph, for the same reason the sidebar's
                  `✎ ◈ ▤` are gone: which font claims the codepoint, at what weight and on what
                  baseline, is not ours to decide. `currentColor` always is. */}
              <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
                <path
                  d="M2 2 8 8M8 2 2 8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          ) : null}
          <FpsOverlay />
        </header>

        <Feed
          sessionId={selectedSessionId}
          projectId={selectedProjectId}
          projectName={selectedProject?.name ?? null}
        />

        <Approvals
          approvals={approvalRows}
          onRespond={respond}
          onDismiss={store.dismissApproval}
          onFocus={focusApproval}
        />

        {selectedSession === null ? (
          <NewSession
            project={selectedProject}
            models={models}
            disabled={claudeError !== null}
            onStart={startSession}
          />
        ) : (
          <Composer
            session={selectedSession}
            projectName={selectedProject?.name ?? null}
            busy={commandBusy}
            onResume={resumeSession}
            onCleanup={cleanupWorktree}
            onSend={(id, text) => {
              void bridge().sendTurn(id, text).catch(say);
            }}
            onInterrupt={(id) => {
              void bridge().interrupt(id).catch(say);
            }}
            onEnd={(id) => {
              void bridge().endSession(id).catch(say);
            }}
            onKill={(id) => {
              void bridge().kill(id).catch(say);
            }}
          />
        )}
      </main>
    </div>
  );
}
