import { newStartup, readStartup, saveStartup, startupRuntime, type SessionStartup } from "./sessionStartup";
import { profiling } from "./perfDiagnostics";
import { workerTree, conversationOwner, conversationSessions } from "./workerTree";
import { syncArchive, readArchive } from "./sessionArchive";
import { listen } from "@tauri-apps/api/event";
import { renameSession } from "./sessionNavigation";
import { NavigationHistoryControls } from "./components/NavigationHistoryControls";
import { Button } from "@/components/ui/button";
import { Details, DetailsSummary } from "./components/controls/details";
import { useNavigationData, isTrashed } from "./navigationApi";
import { SidebarProvider, SidebarInset } from "./components/controls/sidebar";
import { desktop, type ChatItem } from "./workspaceApi";
/** The desktop shell: project sidebar, conversation, composer and optional workspace.
 * Saved automation plans are collapsed project history. A selected session shows its chat.
 * IPC uses the native bridge in Tauri and an in-memory mock in browser previews.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

import { bridge, toAppError } from "./bridge";
import type { BurnArgs, StartSessionArgs } from "./bridge";
import * as store from "./feedStore";
import { beginInteraction } from "./paint";
import type { PaintedSpan } from "./paint";
import { Approvals } from "./components/Approvals";
import type { ApprovalRow } from "./components/Approvals";
import { Burn } from "./components/Burn";
import { preloadMarkdownContent } from "./components/Markdown";
import { Dock } from "./components/Dock";
import { ThreadView } from "./components/ThreadView";
import { useStoredState } from "./workbenchState";
import { usePeers } from "./peerApi";
import { ProjectWorkbench } from "./components/ProjectWorkbench";
import { Toasts } from "./components/Toasts";
import { notify, useCleanup } from "./desktopApi";
import { useAttention } from "./attention";

import { RunCard } from "./components/RunCard";
import { Sidebar, type SidebarHandle } from "./components/Sidebar";
import { LayoutResizer } from "./components/LayoutResizer";
import { runIsLive } from "./wire";
import type {
  AppError,
  AppInfo,
  ClaudeStatus,
  Decision,
  IntentSettlement,
  IntentView,
  ModelInfo,
  PlanId,
  ProjectId,
  ProjectView,
  RequestId,
  RunView,
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
 * How often the plan card re-reads `current_run` while a run is live.
 *
 * **Polling, and it is a decision rather than an oversight.** `docs/plans/ipc-contract.md`
 * §"The run" → Signals says the run needs no channel of its own and names exactly one edge the
 * card must react to: a `runtime-warning`, which is what the reconciler emits for an intent it
 * could not settle. That edge is wired below and is the one the contract binds. It is not,
 * however, emitted when a phase merely goes green — there is no per-phase signal on the wire at
 * all — and "updating in place as phases complete" (`docs/vision.md` §9) is the whole point of
 * the card, so something has to ask. One command per second while a run is live is that
 * something, and it stops the moment the run does.
 *
 * If the Rust side later grows a signal for a phase transition, this interval is what it
 * replaces.
 */
const RUN_POLL_MS = 1000;

/** Sidebar width: the stored default, and the point below which a drag collapses it. */
const SIDEBAR_DEFAULT_WIDTH = 275;
const SIDEBAR_MIN_WIDTH = 240;
/**
 * The widest the sidebar may get: never past 520px, and never so wide that the thread is
 * left under 320px. Read live rather than stored, so a smaller window wins.
 */
const sidebarLimit = () =>
  Math.max(SIDEBAR_MIN_WIDTH, Math.min(520, window.innerWidth - 320));

/**
 * The project the dev `burn` command creates its sessions under: `<temp>/brigadier-burn/burn`
 * (`src-tauri/src/burn.rs:50`), whose name is the directory basename.
 */
const BURN_PROJECT_NAME = "burn";
const BURN_ROOT_MARKER = "/burn-fixtures/";

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

const emptySelectedApprovals: ApprovalRow[] = [];

/**
 * Archive sync and the native menu event bridge, in that order and only in that order.
 *
 * **Listeners first, then the fetch** (`docs/plans/efficiency-plan-review-2026-09-11.md` §B4).
 * `listen` is async and Tauri v2 neither buffers nor replays an event emitted before its
 * subscription lands, so the old shape — `syncArchive()`, then the 5 s poll, then `listen` — had
 * a real window in which an `archive-changed` was dropped and the sidebar stayed stale for up to
 * five seconds. The poll is deliberately still here: it is what hid that window, and it goes only
 * once the producer side is proven to emit on every archive mutation.
 *
 * The browser/mock branch keeps its synchronous first refresh: there is nothing to subscribe to,
 * so there is nothing to wait for.
 *
 * Exported for `src/App.archive.test.tsx`, which drives this wiring on its own rather than
 * through a full `App` render — the shell's own tests run with `desktop` false and cannot reach
 * this branch at all.
 */
export function useArchiveAndNativeEvents(say: (e: unknown) => void): void {
  useEffect(() => {
    let stopped = false,
      reading = false;
    const refresh = async () => {
      if (stopped || reading) return;
      reading = true;
      try {
        await syncArchive();
      } catch (e) {
        if (!stopped) say(e);
      } finally {
        reading = false;
      }
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    let unlisteners: Array<() => void> = [];
    const begin = () => {
      void refresh();
      timer = setInterval(() => void refresh(), 5000);
    };
    if (!desktop) begin();
    else
      void (async () => {
        const settled = await Promise.all(
          [
            listen("archive-changed", () => void refresh()),
            listen("native-close-tab", () =>
              window.dispatchEvent(new Event("workbench-close-tab")),
            ),
            listen("native-new-session", () =>
              window.dispatchEvent(new Event("workbench-new-session")),
            ),
            listen("native-new-terminal", () =>
              window.dispatchEvent(new Event("workbench-new-terminal")),
            ),
            listen<string>("native-session-action", (event) =>
              window.dispatchEvent(
                new CustomEvent("workbench-session-action", {
                  detail: event.payload,
                }),
              ),
            ),
            listen("native-toggle-terminal", () =>
              window.dispatchEvent(new Event("workbench-terminal-toggle")),
            ),
            listen("native-split-terminal", () =>
              window.dispatchEvent(new Event("workbench-terminal-split")),
            ),
            listen("native-new-files", () =>
              window.dispatchEvent(new Event("workbench-new-files")),
            ),
          ].map((promise) =>
            promise.catch((e): (() => void) => {
              if (!stopped) say(e);
              return () => {};
            }),
          ),
        );
        // Unmount raced the pending `listen()` calls: they are live now and nothing else will
        // ever tear them down, so tear them down here — and start no poll.
        if (stopped) {
          for (const unlisten of settled) unlisten();
          return;
        }
        unlisteners = settled;
        begin();
      })();
    return () => {
      stopped = true;
      clearInterval(timer);
      for (const unlisten of unlisteners) unlisten();
    };
  }, [say]);
}

export function App({ onReady }: { onReady?: () => void } = {}) {
  const peers = usePeers();
  const [workspaceOpen, setWorkspaceOpen] = useStoredState(
    "brigadier:workspace-open",
    false,
  );
  const sidebar = useRef<SidebarHandle>(null);
  const [notepadOpen, setNotepadOpen] = useState(false);
  const [notepadHost, setNotepadHost] = useState<HTMLDivElement | null>(null);
  const [sidebarOpen, setSidebarOpen] = useStoredState(
    "brigadier:sidebar-open",
    true,
  );
  const [sidebarWidth, setSidebarWidth] = useStoredState(
    "brigadier:sidebar-width",
    SIDEBAR_DEFAULT_WIDTH,
  );
  const [resizingSidebar, setResizingSidebar] = useState(false);
  /** Dragging past the minimum is a collapse gesture, not a clamp; the width resets. */
  const resizeSidebar = (next: number) => {
    if (next < SIDEBAR_MIN_WIDTH) {
      setSidebarOpen(false);
      setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
      return;
    }
    setSidebarWidth(Math.min(next, sidebarLimit()));
  };
  useEffect(() => {
    const clamp = () =>
      setSidebarWidth((width) =>
        Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarLimit(), width)),
      );
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [setSidebarWidth]);

  const rawState = useSyncExternalStore(store.subscribe, store.getState);
  const navigation = useNavigationData();
  const state = useMemo(() => {
    const sessions = Object.fromEntries(
      Object.entries(rawState.sessions).filter(
        ([id, session]) =>
          navigation.loaded &&
          !isTrashed(navigation.data, "session", id) &&
          !isTrashed(navigation.data, "project", session.projectId),
      ),
    );
    return {
      ...rawState,
      sessions,
      order: rawState.order.filter((id) => !!sessions[id]),
    };
  }, [rawState, navigation.data, navigation.loaded]);

  const [allProjects, setProjects] = useState<ProjectView[]>([]);
  const projects = useMemo(
    () =>
      allProjects.filter(
        (p) =>
          navigation.loaded && !isTrashed(navigation.data, "project", p.id),
      ),
    [allProjects, navigation.data, navigation.loaded],
  );
  const [newSessionRequest, setNewSessionRequest] = useState<{
    projectId: string;
    token: number;
  } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [claudeError, setClaudeError] = useState<AppError | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(
    null,
  );
  /**
   * A **global** "New chat" — the sidebar button, ⌘N, or the welcome screen's own row — starts
   * with no project picked. The composer uses an internal projectless workspace for drafts,
   * settings, and attachments while its picker shows "Choose project".
   *
   * `selectedProjectId` is `null` for that state, exactly as it is when there are no projects at
   * all; this flag is the third bit that tells the two apart. Its only job is to stop the
   * missing-project effect below from immediately re-selecting `projects[0]` and undoing the
   * unpick. Every explicit pick clears it through `chooseProject`, and **nothing persists it** —
   * a reload comes back on the remembered project.
   *
   * The project-scoped "New chat" (a project row's ⋯ menu or its hover pencil) is a different
   * interaction and keeps selecting that project: it carries an id on
   * `brigadier-new-project-session`, where the global path carries `null`.
   */
  const [projectUnpicked, setProjectUnpicked] = useState(false);
  /** Pick a project explicitly. Every caller but the auto-select effect goes through this. */
  const chooseProject = useCallback((id: ProjectId | null) => {
    setProjectUnpicked(false);
    setSelectedProjectId(id);
  }, []);
  const [selectedSessionId, setSelectedSessionId] = useState<SessionId | null>(
    null,
  );
  const [startups, setStartups] = useState<Record<string, SessionStartup>>({});
  const startupsRef = useRef(startups); startupsRef.current = startups;
  const pendingStartup = selectedSessionId ? startups[selectedSessionId] : undefined;
  const savedStartup = useMemo(() => readStartup(selectedSessionId), [selectedSessionId]);
  const [completedStartups, setCompletedStartups] = useState<Record<string, SessionStartup>>({});
  const startup = pendingStartup ?? (selectedSessionId ? completedStartups[selectedSessionId] : undefined) ?? savedStartup;
  const startupTitles = useMemo(() => Object.fromEntries(Object.entries(completedStartups).map(([id, item]) => [id, item.title])), [completedStartups]);
  const startingRequests = useRef(new Set<string>());
  const pendingBackendIds = new Set(Object.values(startups).map(item => item.createdSessionId).filter(Boolean));
  const pendingSessions = Object.fromEntries(Object.values(startups).map(item => [item.id, startupRuntime(item)]));
  const [editingMessage, setEditingMessage] = useState<ChatItem | null>(null);
  const [conversationRevision, setConversationRevision] = useState(0);
  useEffect(() => setEditingMessage(null), [selectedSessionId]);
  const [notice, setNotice] = useState<string | null>(null);
  /** The first `list_projects` has landed; before that every id looks unknown. */
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  /** A `resume_session` or `cleanup_worktree` call is in flight; both buttons go inert. */
  const [commandBusy, setCommandBusy] = useState(false);

  /**
   * The run: the newest plan for the selected project, and every intent the reconciler could not
   * settle. `unsettled_intents` is deliberately **not** scoped to a project — the command is not
   * either — so an intent left behind by a run on another repository is still on screen. An
   * unsettled intent is a thing the harness cannot account for; hiding one behind a selection is
   * exactly how it stays unaccounted for.
   */
  const [run, setRun] = useState<RunView | null>(null);
  const [intents, setIntents] = useState<IntentView[]>([]);
  /** The project the newest `current_run` fetch was for; a stale answer is dropped. */
  const runRequest = useRef<ProjectId | null>(null);

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
  const paintSpan = useRef<{ sessionId: SessionId; span: PaintedSpan } | null>(
    null,
  );

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
      const [info, projectList, modelList, sessionList, pending] =
        await Promise.all([
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
      if (projectList.length > 0)
        setSelectedProjectId(
          (prev) =>
            prev ??
            projectList.find(
              (p) =>
                p.id === localStorage.getItem("brigadier:selected-project"),
            )?.id ??
            projectList.find(p => !p.projectless)?.id ?? null,
        );
      // The 286 KB Markdown chunk, fetched and evaluated here rather than on the first transcript
      // mount. This is after first contentful paint, so it cannot spend the 295 ms budget; the
      // zero-delay timer yields the task first. Desktop only: the browser mock mounts no
      // transcript. `preloadMarkdownContent` shares `lazy`'s promise, so it never fetches twice.
      if (desktop) setTimeout(() => void preloadMarkdownContent(), 0);
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

  useArchiveAndNativeEvents(say);

  // Onboarding can fade only after the initial workspace data has committed.
  useEffect(() => {
    if (projectsLoaded && (navigation.loaded || navigation.error)) onReady?.();
  }, [projectsLoaded, navigation.loaded, navigation.error, onReady]);

  useEffect(() => {
    if (!navigation.loaded || !projectsLoaded) return;
    // While a global "New chat" is waiting for a project, `null` is the chosen state, not a stale
    // selection: re-selecting `projects[0]` here is exactly the auto-pick being suppressed.
    if (projectUnpicked) {
      if (selectedSessionId && !state.sessions[selectedSessionId] && !startups[selectedSessionId])
        setSelectedSessionId(null);
      return;
    }
    if (!projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(projects.find(p => !p.projectless)?.id ?? null);
      setSelectedSessionId(null);
    } else if (selectedSessionId && !state.sessions[selectedSessionId] && !startups[selectedSessionId])
      setSelectedSessionId(null);
  }, [
    navigation.loaded,
    projectsLoaded,
    projects,
    projectUnpicked,
    selectedProjectId,
    selectedSessionId,
    state.sessions,
    startups,
  ]);
  useEffect(() => {
    const refresh = () => {
      void refreshProjects().catch(say);
    };
    /**
     * "Start a new chat". `detail` is the project to start it in, or `null` for the global path
     * (sidebar button, ⌘N, welcome row), which picks no project at all. Pressing it again while
     * already unpicked focuses the composer.
     */
    const create = (event: Event) => {
      const projectId = (event as CustomEvent<string | null>).detail ?? null;
      setSelectedSessionId(null);
      if (projectId === null) {
        if (projectUnpicked) {
          window.dispatchEvent(new Event("brigadier-focus-composer"));
          return;
        }
        setProjectUnpicked(true);
        setSelectedProjectId(null);
        return;
      }
      chooseProject(projectId);
      setNewSessionRequest({ projectId, token: Date.now() });
    };
    window.addEventListener("brigadier-navigation-changed", refresh);
    window.addEventListener("brigadier-new-project-session", create);
    return () => {
      window.removeEventListener("brigadier-navigation-changed", refresh);
      window.removeEventListener("brigadier-new-project-session", create);
    };
  }, [refreshProjects, say, chooseProject, projectUnpicked]);

  // Include cross-project worker activity; only resubscribe when the project set changes.
  const visibleProjectKey = useMemo(() => {
    const visible = new Set(projects.filter(p => p.projectless).map(p => p.id));
    if (selectedProjectId) visible.add(selectedProjectId);
    if (selectedSessionId) for (const row of workerTree(selectedSessionId, peers, state.sessions)) {
      if (row.session?.projectId) visible.add(row.session.projectId);
    }
    return JSON.stringify([...visible]);
  }, [selectedProjectId, selectedSessionId, peers.subagents, state.sessions, projects]);
  useEffect(() => {
    if (selectedProjectId !== null) localStorage.setItem("brigadier:selected-project", selectedProjectId);
    void bridge().setVisibleProjects(JSON.parse(visibleProjectKey)).catch(say);
  }, [selectedProjectId, visibleProjectKey, say]);

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
    if (selectedSessionId === null || selectedSessionId.startsWith("starting:")) return;
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
    // The count, not the rows: `getSessionRows` would build a 2,000-element snapshot to answer a
    // yes/no question (`src/feedStore.ts`, `getSessionRowCount`).
    if (store.getSessionRowCount(selectedSessionId) > 0) {
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
    if (id) id = conversationOwner(id, peers);
    const prev = paintSpan.current;
    if (prev !== null) {
      prev.span.cancel();
      paintSpan.current = null;
    }
    if (id !== null) {
      paintSpan.current = { sessionId: id, span: beginInteraction(B4_LABEL) };
      // Opening a conversation is an explicit pick: it leaves the unpicked state even when the
      // store cannot place the session, because a transcript is on screen either way.
      setProjectUnpicked(false);
      const owner = startupsRef.current[id]?.args.projectId ?? store.getState().sessions[id]?.projectId ?? null;
      if (owner !== null) setSelectedProjectId(owner);
    }
    setSelectedSessionId(id);
    if (id)
      window.dispatchEvent(
        new CustomEvent("workbench-select-session", { detail: id }),
      );
  }, [peers.subagents]);

  // Recover stale selections without exposing a worker composer during metadata loading.
  useEffect(() => {
    if (selectedSessionId && peers.loaded !== false) {
      const owner = conversationOwner(selectedSessionId, peers);
      if (owner !== selectedSessionId) selectSession(owner);
    }
  }, [selectedSessionId, peers.subagents, peers.loaded, selectSession]);

  useEffect(() => {
    if (bridge().isMock) return;
    void bridge()
      .listSessions()
      .then(store.seedSessions)
      .catch(() => {});
    void bridge()
      .listModels()
      .then(setModels)
      .catch(() => {});
  }, [peers.origins, peers.subagents, selectedSessionId]);
  const selectedSession =
    selectedSessionId === null || peers.loaded === false || !!peers.subagents?.[selectedSessionId]
      ? null
      : (state.sessions[selectedSessionId] ?? null);
  const openWorkspace = useCallback((path?: string) => {
    if (path)
      window.dispatchEvent(
        new CustomEvent("workbench-open-file", { detail: { path } }),
      );
    else setWorkspaceOpen(true);
  }, []);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (document.querySelector(".desktop-settings")) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        setWorkspaceOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);

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
      const conversationId = conversationOwner(a.sessionId, peers);
      const projectId = state.sessions[conversationId]?.projectId ?? null;
      return {
        approval: a,
        conversationId,
        subagentTitle: conversationId !== a.sessionId ? peers.titles[a.sessionId] ?? "Subagent" : undefined,
        projectId,
        projectName:
          projectId === null ? null : (byId.get(projectId)?.name ?? projectId),
        elsewhere:
          projectId !== null &&
          selectedProjectId !== null &&
          projectId !== selectedProjectId,
      };
    });
  }, [state.approvals, state.sessions, projects, selectedProjectId, peers.subagents, peers.titles]);

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
  const focusApproval = useCallback(
    (projectId: ProjectId | null, sessionId: SessionId) => {
      if (projectId !== null) chooseProject(projectId);
      selectSession(sessionId);
    },
    [selectSession, chooseProject],
  );

  /**
   * Add a project by absolute path. `add_project` in Rust is the only validator — it refuses a
   * path that is not a directory and one that is not a repository root — so nothing here
   * second-guesses the path before sending it.
   *
   * It returns the error rather than only swallowing it into the notice, following
   * `cleanupWorktree` below: the sidebar draws it beside the control that produced it, which is
   * where "that folder is not a repository root" is actually readable. The notice still fires, so
   * the failure is not quieter than any other.
   */
  const addProject = useCallback(
    async (path: string): Promise<AppError | null> => {
      try {
        const p = await bridge().addProject(path);
        window.dispatchEvent(new Event("brigadier-navigation-changed"));
        // Native add also restores a trashed project. Load that visibility before
        // selecting it, so the missing-project effect cannot discard the selection.
        await navigation.refresh();
        setProjects((prev) => [...new Map([...prev, p].map(project => [project.id, project])).values()]);
        store.noteProjects([p.id]);
        chooseProject(p.id);
        setSelectedSessionId(null);
        return null;
      } catch (e) {
        say(e);
        return toAppError(e);
      }
    },
    [say, navigation.refresh, chooseProject],
  );

  /**
   * "Add project" in a real window: the native macOS directory picker, then `add_project` on
   * whatever came back.
   *
   * **A cancelled picker resolves `null` and is not an error** (`docs/research/tauri-dialog.md`
   * §2). Nothing is added, nothing is said, and the sidebar's typed-path fallback is left closed.
   */
  const pickProject = useCallback(async (): Promise<AppError | null> => {
    let picked: string | null;
    try {
      picked = await bridge().pickDirectory();
    } catch (e) {
      say(e);
      return toAppError(e);
    }
    if (picked === null) return null;
    return addProject(picked);
  }, [addProject, say]);

  /** Reveal a project root or a session worktree in Finder. Fire-and-forget; a failure is a
   *  notice, never a thrown promise. */
  const reveal = useCallback(
    (path: string) => {
      void bridge().revealPath(path).catch(say);
    },
    [say],
  );

  const startSession = useCallback(async (input: StartSessionArgs) => {
    const args = { ...input, requestId: input.requestId ?? crypto.randomUUID() };
    if (startingRequests.current.has(args.requestId)) return false;
    startingRequests.current.add(args.requestId);
    let settled = false;
    const record = newStartup(args);
    // Open the authored task before any filesystem or provider work crosses IPC.
    setStartups(previous => ({ ...previous, [record.id]: record }));
    chooseProject(args.projectId);
    setSelectedSessionId(record.id);
    try {
      const view = await bridge().startSession(args, progress => {
        if (settled) return;
        if (progress.sessionId) record.createdSessionId = progress.sessionId;
        record.progress = [...record.progress, progress];
        setStartups(previous => ({ ...previous, [record.id]: { ...record } }));
      });
      settled = true;
      record.sessionId = view.session_id;

      if (!record.progress.some(item => item.step === "workspace" && item.complete)) {
        record.progress.push({step:"workspace",complete:true,detail:`Using workspace: ${view.cwd ?? "Unknown"}\nUsing branch: ${view.branch ?? "No Git branch"}`});
      }
      if (!record.progress.some(item => item.step === "session" && item.complete)) {
        record.progress.push({step:"session",complete:true,detail:"Initial prompt sent"});
      }
      setCompletedStartups(previous => ({...previous, [view.session_id]: {...record}}));
      saveStartup(record);
      try {
        const draftKey = `composer-pending:project:${args.projectId}`;
        const pendingDraft = JSON.parse(localStorage.getItem(draftKey) ?? "null");
        if (pendingDraft?.text === args.prompt && JSON.stringify(pendingDraft.attachmentIds) === JSON.stringify(args.attachmentIds ?? [])) localStorage.removeItem(draftKey);
        const receiptKey = `brigadier:initial-send:${args.projectId}`;
        if (JSON.parse(localStorage.getItem(receiptKey) ?? "null")?.id === args.requestId) localStorage.removeItem(receiptKey);
      } catch { /* Backend receipts and drafts remain authoritative. */ }
      store.seedSessions([view]);
      setSelectedSessionId(current => current === record.id ? view.session_id : current);
      setStartups(previous => { const next = {...previous}; delete next[record.id]; return next; });
      return true;
    } catch (error) {
      settled = true;
      record.error = toAppError(error).message;
      setStartups(previous => ({ ...previous, [record.id]: { ...record } }));
      return false;
    } finally { startingRequests.current.delete(args.requestId); }
  }, [chooseProject]);

  /**
   * Continue an ended session in place. The success path is `startSession`'s, deliberately: the
   * `session_id` does not change, so seeding the returned view and selecting it re-triggers the
   * `feed_tail` prefill above and the old history re-renders under the new child
   * (`docs/plans/ipc-contract.md` §resume_session).
   */
  const forkSession = async (sessionId: SessionId, newWorktree: boolean) => {
    const view = await bridge().forkSession(sessionId, newWorktree);
    store.seedSessions([view]);
    try {
      renameSession(
        view.session_id,
        `Fork of ${peers.titles[sessionId] ?? `Session ${sessionId.slice(-6)}`}`.slice(
          0,
          200,
        ),
      );
    } catch (error) {
      say(error);
    }
    chooseProject(view.project_id);
    setSelectedSessionId(view.session_id);
  };
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
    async (
      sessionId: SessionId,
      force: boolean,
    ): Promise<WorktreeCleanup | null> => {
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
      return bridge().respond(sessionId, requestId, decision, conversationOwner(sessionId, peers));
    },
    [peers.subagents],
  );

  /* ------------------------------------------------------------------ the run */

  /**
   * Re-read the plan and the unsettled intents for one project.
   *
   * **Failures are swallowed rather than shown**, and that is the one place on this surface where
   * a gap is preferred to a message: this runs once a second while a run is live, so a `store` or
   * `io` error would strobe the notice bar and drown every other failure in it. What it costs is
   * stated rather than hidden — a `current_run` that starts failing shows as a card that stops
   * updating, not as an error. Every *operator-initiated* call below still reports.
   */
  const refreshRun = useCallback(
    async (projectId: ProjectId | null): Promise<void> => {
      runRequest.current = projectId;
      if (projectId === null) {
        setRun(null);
        setIntents([]);
        return;
      }
      const b = bridge();
      const [view, list] = await Promise.all([
        b.currentRun(projectId).catch(() => null),
        b.unsettledIntents().catch(() => [] as IntentView[]),
      ]);
      // The selection moved while this was in flight: another fetch is already on its way, and
      // painting this answer would put one project's plan under another project's name.
      if (runRequest.current !== projectId) return;
      setRun(view);
      setIntents(list.filter((intent) => intent.project_id === projectId));
    },
    [],
  );

  /**
   * Two triggers, and both are the contract's.
   *
   * The project selection is the obvious one. `state.runtimeWarnings` is the other: the
   * reconciler emits a `runtime-warning` for an intent it could not settle, and
   * `docs/plans/ipc-contract.md` §"The run" → Signals says the card refetches `current_run` on it.
   * That is why the run needs no channel of its own.
   */
  useEffect(() => {
    void refreshRun(selectedProjectId);
  }, [selectedProjectId, state.runtimeWarnings, refreshRun]);

  // While a run is live, ask. See `RUN_POLL_MS` for why this is a poll and not a subscription.
  const runLive = runIsLive(run);
  useEffect(() => {
    if (selectedProjectId === null || !runLive) return;
    const id = window.setInterval(() => {
      void refreshRun(selectedProjectId);
    }, RUN_POLL_MS);
    return () => clearInterval(id);
  }, [selectedProjectId, runLive, refreshRun]);

  /**
   * Stop dispatching. **Nothing is killed** (`docs/plans/ipc-contract.md` §"The run"): a worker
   * killed mid-order leaves a worktree whose `work_order` intent reconciles to `unknown`, which
   * blocks its phase permanently. In-flight orders finish and are collected.
   */
  const stopRun = useCallback(
    (planId: PlanId) => {
      setCommandBusy(true);
      void bridge()
        .stopRun(planId)
        .then(() => refreshRun(selectedProjectId))
        .catch(say)
        .finally(() => setCommandBusy(false));
    },
    [refreshRun, selectedProjectId, say],
  );

  /**
   * The owner's answer to something the harness could not observe. **Not an approval**: neither
   * value allows or denies anything, and `settle_intent` takes only these two.
   */
  const settleIntent = useCallback(
    (intentId: string, settlement: IntentSettlement) => {
      setCommandBusy(true);
      void bridge()
        .settleIntent(intentId, settlement)
        .then(() => refreshRun(selectedProjectId))
        .catch(say)
        .finally(() => setCommandBusy(false));
    },
    [refreshRun, selectedProjectId, say],
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
        (p) =>
          p.root_path.includes(BURN_ROOT_MARKER) ||
          p.name === BURN_PROJECT_NAME,
      );
      const burnProject = candidates.slice().sort((a, b) => {
        const marked =
          Number(b.root_path.includes(BURN_ROOT_MARKER)) -
          Number(a.root_path.includes(BURN_ROOT_MARKER));
        return marked !== 0 ? marked : b.created_at_ms - a.created_at_ms;
      })[0];
      if (burnProject === undefined) throw new Error("Replay project was not created");
      // The visibility effect above pushes `set_visible_projects([burnProject.id])` off this.
      chooseProject(burnProject.id);
      const sessions = await bridge().listSessions();
      store.seedSessions(sessions);
      const newest = sessions.filter(session => session.project_id === burnProject.id)
        .sort((a, b) => (b.started_at_ms ?? 0) - (a.started_at_ms ?? 0))[0];
      if (!newest) throw new Error("Replay conversation was not created");
      setSelectedSessionId(newest.session_id);
    },
    [refreshProjects, chooseProject],
  );

  const selectedProject =
    selectedProjectId === null
      ? null
      : (projects.find((p) => p.id === selectedProjectId) ?? null);
  // The storage workspace stays internal; an unpicked draft is a usable projectless chat.
  const projectlessWorkspace = projects.find(project => project.projectless) ?? null;
  useEffect(() => {
    if (!projectsLoaded || !navigation.loaded || selectedProjectId !== null || projectlessWorkspace) return;
    let live = true;
    let pending = false;
    const prepare = async () => {
      if (pending) return;
      pending = true;
      try {
        const project = await bridge().projectlessWorkspace();
        await navigation.refresh();
        if (!live) return;
        setProjects(previous => [...previous.filter(item => item.id !== project.id), project]);
        store.noteProjects([project.id]);
      } catch (error) { if (live) say(error); }
      finally { pending = false; }
    };
    void prepare();
    window.addEventListener("focus", prepare);
    return () => { live = false; window.removeEventListener("focus", prepare); };
  }, [projectsLoaded, navigation.loaded, navigation.refresh, selectedProjectId, projectlessWorkspace, say]);
  const pendingTotal = approvalRows.length;
  const jobs = useCleanup();
  const [viewedSession, setViewedSession] = useState<string | null>(null);
  const attention = useAttention(state.sessions, viewedSession, [
    ...approvalRows.map((r) => r.conversationId ?? r.approval.sessionId),
    ...peers.requests.filter((r) => !r.resolved).map((r) => conversationOwner(r.from, peers)),
  ]);
  useEffect(() => {
    const active = (e: Event) =>
      setViewedSession((e as CustomEvent<string | null>).detail);
    const toggle = () => { if (!document.querySelector(".desktop-settings")) setSidebarOpen((v) => !v); };
    window.addEventListener("workbench-active-session", active);
    window.addEventListener("brigadier-toggle-sidebar", toggle);
    return () => {
      window.removeEventListener("workbench-active-session", active);
      window.removeEventListener("brigadier-toggle-sidebar", toggle);
    };
  }, []);
  useEffect(() => {
    if (notice) {
      notify(notice, true);
      setNotice(null);
    }
  }, [notice]);

  const filteredApprovals = approvalRows.filter(row => row.conversationId === selectedSessionId);
  const selectedApprovals = filteredApprovals.length ? filteredApprovals : emptySelectedApprovals;
  const transcriptRequests = useMemo(() => <Approvals approvals={selectedApprovals}
    onRespond={respond} onDismiss={store.dismissApproval} onFocus={focusApproval}/>,
    [selectedApprovals, respond, focusApproval]);
  const selectTranscriptSession = useCallback((id: string) => {
    if (selectedSessionId && workerTree(selectedSessionId, peers, store.getState().sessions).some(row => row.id === id))
      window.dispatchEvent(new CustomEvent("workbench-open-worker", {detail: {rootId: selectedSessionId, id}}));
    else selectSession(id);
  }, [selectedSessionId, peers, selectSession]);
  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
      attention={pendingTotal > 0 || Object.values(attention).some(Boolean)}
      navigationControls={
        <NavigationHistoryControls
          page={notepadOpen ? "notepad" : "workspace"}
          beforeNavigate={(next) => sidebar.current?.leaveNotepad(next)}
          projectId={selectedProjectId}
          sessionId={selectedSessionId}
          isAvailable={({ projectId, sessionId, page }) =>
            page === "notepad" ||
            (!!projects.find((p) => p.id === projectId) &&
              (!sessionId || !!state.sessions[sessionId]))
          }
          onNavigate={({ projectId, sessionId, page }) => {
            if (page === "notepad") {
              sidebar.current?.openNotepad();
              return;
            }
            chooseProject(projectId);
            selectSession(sessionId);
          }}
        />
      }
      className="h-svh min-h-0 overflow-hidden"
      /* `SidebarProvider` spreads the rest of its props onto the `.app-shell` element, so
         both of these land there: the width every sidebar rule reads, and the flag that
         suspends the 220ms width transition mid-drag. */
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      data-resizing={resizingSidebar ? "true" : undefined}
    >
      <LayoutResizer
        orientation="vertical"
        label="Resize sidebar"
        className="sidebar-resizer"
        value={sidebarWidth}
        min={SIDEBAR_MIN_WIDTH}
        max={sidebarLimit()}
        tabIndex={sidebarOpen ? 0 : -1}
        onChange={resizeSidebar}
        onResizeStart={() => setResizingSidebar(true)}
        onResizeEnd={() => setResizingSidebar(false)}
      />
      <Sidebar
        ref={sidebar}
        notepadHost={notepadHost}
        onNotepadOpenChange={setNotepadOpen}
        attention={attention}
        jobs={jobs}
        projects={projects}
        titles={{...startupTitles, ...peers.titles, ...Object.fromEntries(Object.values(startups).map(item => [item.id, item.title]))}}
        origins={peers.subagents ?? {}}
        sessions={{...Object.fromEntries(Object.entries(conversationSessions(state.sessions, peers)).filter(([id]) => !pendingBackendIds.has(id))), ...pendingSessions}}
        order={[...Object.keys(pendingSessions), ...state.order.filter(id => !pendingBackendIds.has(id))]}
        selectedProjectId={selectedProjectId}
        selectedSessionId={selectedSessionId}
        pendingApprovals={pendingByProject}
        pendingTotal={pendingTotal}
        appInfo={appInfo}
        claude={claude}
        claudeError={claudeError}
        isMock={bridge().isMock}
        dev={BURN_UI ? <Burn onBurn={runBurn} /> : undefined}
        onSelectProject={(id) => {
          chooseProject(id);
          try {
            const last = JSON.parse(
              localStorage.getItem("brigadier:last-project-session") ?? "{}",
            )[id];
            setSelectedSessionId(
              last &&
                !readArchive().entries[last] &&
                store.getState().sessions[last]
                ? last
                : null,
            );
          } catch {
            setSelectedSessionId(null);
          }
        }}
        onSelectSession={selectSession}
        onAddProject={addProject}
        // Both plugins exist only in a real Tauri window. In a browser (`npm run dev`) the mock
        // bridge is selected, the picker button is not drawn at all, and the typed-path field is
        // the whole of "Add project" — the degradation the order asks for, done by not offering
        // a control rather than by offering one that fails.
        onPickProject={bridge().isMock ? undefined : pickProject}
        onReveal={bridge().isMock ? undefined : reveal}
      />

      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <div
          ref={setNotepadHost}
          hidden={!notepadOpen}
          className="h-full min-h-0"
        />
        <div
          className="min-h-0 flex-1 flex-col"
          style={{ display: notepadOpen ? "none" : "flex" }}
        >
          <ProjectWorkbench
            pendingTitle={pendingStartup?.title}
            sidebarToggle={null}
            newSessionRequest={newSessionRequest}
            navigation={navigation.data}
            attention={attention}
            peers={{...peers,titles:{...startupTitles,...peers.titles}}}
            project={selectedProject}
            session={selectedSession}
            sessions={state.sessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={selectSession}
            onForkSession={forkSession}
            workspaceOpen={workspaceOpen}
            setWorkspaceOpen={setWorkspaceOpen}
            models={models}
            historyContent={
              <>
                {runLive &&
                run?.project_id === selectedProjectId &&
                selectedSessionId === null ? (
                  <div className="run-dock-status" role="status">
                    Automation running: {run.goal}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="act"
                      onClick={() => stopRun(run.plan_id)}
                    >
                      Stop automation
                    </Button>
                  </div>
                ) : null}
                {selectedSessionId === null &&
                (run !== null || intents.length > 0) ? (
                  <Details
                    key={selectedProjectId}
                    className="automation-details max-h-[35%] shrink-0 overflow-auto"
                  >
                    <DetailsSummary>Automation history</DetailsSummary>
                    <RunCard
                      run={run}
                      intents={intents}
                      onSettle={settleIntent}
                    />
                  </Details>
                ) : null}
              </>
            }
          >
            <ThreadView
              startup={startup}
              onRetryStartup={pendingStartup?.error ? () => { void startSession(pendingStartup.args); } : undefined}
              requests={transcriptRequests}
              peers={peers}
              onSelectSession={selectTranscriptSession}
              onEdit={setEditingMessage}
              editing={editingMessage !== null}
              revision={conversationRevision}
              sessionId={selectedSession?.sessionId ?? null}
              projectId={selectedProjectId}
              projectName={selectedProject?.projectless ? null : selectedProject?.name ?? null}
              onFile={openWorkspace}
            />

            <Dock
              onNewProject={() => sidebar.current?.addProject()}
              onProjectless={() => { setProjectUnpicked(true); setSelectedProjectId(null); setSelectedSessionId(null); }}
              startup={pendingStartup}
              editing={
                editingMessage?.session_id === selectedSessionId
                  ? editingMessage
                  : null
              }
              onCancelEdit={() =>
                setEditingMessage((current) =>
                  current?.id === editingMessage?.id ? null : current,
                )
              }
              onRewound={() => setConversationRevision((n) => n + 1)}
              projects={projects}
              onSelectProject={id => { chooseProject(id); setSelectedSessionId(null); }}
              project={selectedProject ?? (selectedSessionId === null ? projectlessWorkspace : null)}
              session={selectedSession}
              models={models}
              busy={commandBusy}
              blocked={claudeError !== null}
              onStartSession={startSession}
              onResume={resumeSession}
              onCleanup={cleanupWorktree}
              onSend={(id, text, attachmentIds) => {
                return bridge()
                  .sendTurn(id, text, attachmentIds)
                  .then(() => true)
                  .catch((e) => {
                    say(e);
                    return false;
                  });
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
          </ProjectWorkbench>
        </div>
      </SidebarInset>
      <Toasts />
    </SidebarProvider>
  );
}

if (profiling) App.displayName = "App";
