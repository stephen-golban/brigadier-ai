/**
 * The Markdown preload in `src/App.tsx`'s mount effect.
 *
 * `./MarkdownContent` is a 286 KB chunk that the first transcript otherwise fetches, parses and
 * evaluates on the render path — one late 21-26 ms frame, measured in
 * `docs/performance/2026-09-11/cold-path-attribution.md` §3. Warming it costs nothing only if it
 * is warmed **after** first contentful paint, so what is pinned here is the shape rather than a
 * number, which no jsdom test could produce:
 *
 *   - it runs once, after the startup `Promise.all` has landed, not during the first render;
 *   - it is on a timer well clear of the shell mount, not a `setTimeout(…, 0)` that lands inside
 *     it (Cluster A of that file, rel 1032-1052). The delay itself is **[not measured]**; what is
 *     pinned here is that it is deferred and cancellable, not that it is 1500 ms;
 *   - the pending timer is cleared when the shell unmounts, so no test and no torn-down window
 *     pulls a 286 KB chunk behind it;
 *   - it does not run in the browser-mock branch, which mounts no transcript and would only gain
 *     a dangling dynamic import in every test that renders the shell.
 *
 * Mechanics match `src/App.run.test.tsx`: `globals: false`, a hoisted fixture bag shared with the
 * `vi.mock` factories, `vi.resetModules()` plus a per-test `await import("./App")` because
 * `feedStore` is a module singleton, and a hand-called `cleanup()`.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  preload: vi.fn(() => Promise.resolve()),
  projects: [] as Array<{ id: string; name: string; root_path: string; created_at_ms: number }>,
}));

vi.mock("./paint", () => ({
  startPaintInstrumentation: () => {},
  INTERACTION_TIMEOUT_MS: 5000,
  beginInteraction: () => ({ painted: () => {}, cancel: () => {} }),
}));

// Only the preload is faked; `Markdown` itself stays real, because the thread column renders it.
vi.mock("./components/Markdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components/Markdown")>()),
  preloadMarkdownContent: h.preload,
}));

// Reachable only on the desktop branch, where `useArchiveAndNativeEvents` subscribes.
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));
vi.mock("./sessionArchive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sessionArchive")>()),
  syncArchive: () => Promise.resolve(),
}));

vi.mock("./bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bridge")>();
  const fake = {
    isMock: true,
    async subscribeFeed() {},
    async setVisibleProjects() {},
    async appInfo() {
      return { run_id: "test", data_dir: "/tmp", version: "0.1.0" };
    },
    async probeClaude() {
      return { binary: "/usr/local/bin/claude", version: "2.1.4" };
    },
    async listModels() {
      return [];
    },
    async listProjects() {
      return h.projects;
    },
    async listSessions() {
      return [];
    },
    async pendingApprovals() {
      return [];
    },
    async feedTail() {
      return [];
    },
    async currentRun() {
      return null;
    },
    async unsettledIntents() {
      return [];
    },
    async reportPaint() {},
    async recordFrameStats() {},
  };
  return { ...actual, bridge: () => fake };
});

/** The delay in `src/App.tsx`. Deliberately duplicated: a test that read it could not pin it. */
const DELAY_MS = 1500;

/** Mount the shell with `desktop` forced, and wait out the startup effect — but not its timer. */
async function mount(desktop: boolean) {
  vi.resetModules();
  vi.doMock("./workspaceApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./workspaceApi")>()),
    desktop,
  }));
  const { App } = await import("./App");
  const view = render(<App />);
  // Two macrotask flushes, deliberately: they let the startup `Promise.all` settle and *schedule*
  // the timer without running it. Time only moves where a test moves it.
  for (let i = 0; i < 2; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.preload.mockClear();
  h.projects = [
    { id: "p1", name: "job-portal", root_path: "/repos/job-portal", created_at_ms: 1_700_000_000_000 },
  ];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.doUnmock("./workspaceApi");
});

it("warms the Markdown chunk once, and only after the shell-mount region", async () => {
  await mount(true);
  // Nothing during the mount: a zero-delay timer would have fired in the flushes above.
  expect(h.preload).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
  });
  expect(h.preload).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(h.preload).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(h.preload).toHaveBeenCalledTimes(1);
});

it("clears the pending preload when the shell unmounts first", async () => {
  const { unmount } = await mount(true);
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(h.preload).not.toHaveBeenCalled();
});

it("does not warm it in the browser mock, which mounts no transcript", async () => {
  await mount(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(h.preload).not.toHaveBeenCalled();
});
