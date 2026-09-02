/**
 * The whole window: sidebar left, feed centre, approvals and composer right.
 *
 * All IPC goes through `bridge()`, which is the real `invoke` inside Tauri and the in-memory
 * mock in a browser, with no code change between the two.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { bridge, toAppError } from "./bridge";
import type { BurnArgs, StartSessionArgs } from "./bridge";
import * as store from "./feedStore";
import { Approvals } from "./components/Approvals";
import { Burn } from "./components/Burn";
import { Composer } from "./components/Composer";
import { Feed } from "./components/Feed";
import { FpsOverlay } from "./components/FpsOverlay";
import { ClaudeBanner, NewSession } from "./components/NewSession";
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
} from "./wire";

/** How much history to pull when a session is selected for the first time. */
const TAIL_ROWS = 500;

/** Coalescing window for the `list_projects` re-fetch a feed batch for an unknown project asks for. */
const UNKNOWN_PROJECT_REFETCH_MS = 250;

/**
 * The project the dev `burn` command creates its sessions under: `<temp>/brigadier-burn/burn`
 * (`src-tauri/src/burn.rs:50`), whose name is the directory basename.
 */
const BURN_PROJECT_NAME = "burn";
const BURN_ROOT_MARKER = "brigadier-burn";

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

  /** Unknown project ids a re-fetch has already been fired for, and that re-fetch's timer. */
  const refetchedFor = useRef<Set<ProjectId>>(new Set());
  const refetchTimer = useRef<number | null>(null);

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

  // Prefill a newly selected session's ring from the store's own tail.
  useEffect(() => {
    if (selectedSessionId === null) return;
    void bridge()
      .feedTail(selectedSessionId, TAIL_ROWS)
      .then((rows) => store.seedRows(selectedSessionId, rows))
      .catch(() => {
        // A missing tail is not worth a banner; the live feed still fills the pane.
      });
  }, [selectedSessionId]);

  const selectedSession = selectedSessionId === null ? null : state.sessions[selectedSessionId] ?? null;

  const visibleApprovals = useMemo(
    () =>
      state.approvals.filter((a) => {
        const s = state.sessions[a.sessionId];
        // An approval whose session we have never seen still has to be answerable.
        return s === undefined || selectedProjectId === null || s.projectId === selectedProjectId;
      }),
    [state.approvals, state.sessions, selectedProjectId],
  );

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

  return (
    <div className="app">
      <header className="top">
        <span className="brand">brigadier</span>
        <ClaudeBanner status={claude} error={claudeError} />
        <span className="dim">
          {appInfo === null ? "" : `run ${appInfo.run_id} · v${appInfo.version}`}
          {bridge().isMock ? " · MOCK BRIDGE (no Rust side)" : ""}
        </span>
        {notice !== null ? (
          <button type="button" className="notice" onClick={() => setNotice(null)}>
            {notice} ✕
          </button>
        ) : null}
        <FpsOverlay />
      </header>

      <div className="body">
        <Sidebar
          projects={projects}
          sessions={state.sessions}
          order={state.order}
          selectedProjectId={selectedProjectId}
          selectedSessionId={selectedSessionId}
          onSelectProject={setSelectedProjectId}
          onSelectSession={setSelectedSessionId}
          onAddProject={addProject}
        />

        <main className="centre">
          <Feed sessionId={selectedSessionId} projectId={selectedProjectId} />
          <Composer
            session={selectedSession}
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
        </main>

        <aside className="right">
          <NewSession
            projectId={selectedProjectId}
            models={models}
            disabled={claudeError !== null}
            onStart={startSession}
          />
          <Approvals
            approvals={visibleApprovals}
            onRespond={respond}
            onDismiss={store.dismissApproval}
          />
          {import.meta.env.DEV ? <Burn onBurn={runBurn} /> : null}
        </aside>
      </div>
    </div>
  );
}
