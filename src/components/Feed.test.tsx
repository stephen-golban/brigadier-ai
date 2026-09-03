/**
 * Behavioural tests for `src/components/Feed.tsx`.
 *
 * Same rule as `Sidebar.test.tsx` and for the same reason: **assert on text and roles, never on
 * class names or structure.** W4-D2 adds a `k` kind field to the wire and will restyle the row
 * around it; W4-E moves things again. A test bound to this markup dies with it and proves only
 * that this markup once existed. `docs/plans/phase-4.md` states the rule.
 *
 * What is pinned here, and why each one is load-bearing rather than decorative:
 *
 *   - **A row still shows its line.** The whole point of the pane. It survived a redesign that
 *     removed two of the four things a row used to draw.
 *   - **The virtualizer still windows.** This is the one measured-good property of this component
 *     (~110 DOM nodes at 60 Hz over 1,513 samples) and the hard constraint on the redesign. jsdom
 *     reports every element as 0x0, so the scroll container is given a size by hand; without it
 *     the pane would window down to nothing and the assertion would pass for the wrong reason.
 *   - **The clock is printed where it changes and nowhere else.** The old row printed `HH:MM:SS`
 *     on every line, which is what made seven rows inside one second read as a table. This is the
 *     behaviour that replaced it, and it is derived from `t` alone — no character of `l` is read.
 *   - **The session ref appears only in a project view, and only where the session changes.**
 *   - **No sequence number.** `q` is a wire envelope field; it was a column and is now nothing.
 *   - **The empty state says what it says**, for all three of its cases.
 *   - **The jump affordance appears only when detached from the tail**, since it is the only way
 *     back and offering it while already at the bottom is noise.
 *
 * Mechanics match `src/feedStore.test.ts`: `globals: false`, so every helper is imported from
 * "vitest"; `@testing-library/react`'s auto-cleanup only registers itself when a global
 * `afterEach` exists, which `globals: false` denies it, so `cleanup()` is called by hand.
 * `feedStore` is a module singleton, so each test re-imports it after `vi.resetModules()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { FeedRowWire, ProjectId, SessionId } from "../wire";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* --------------------------------------------------------------- viewport */

/**
 * jsdom has no layout: every element measures 0x0, so the virtualizer computes a viewport of zero
 * rows and windows down to nothing. Without these stubs "it renders a window rather than all
 * 5,000 rows" would pass for the wrong reason — it would be asserting on an empty pane.
 *
 * `offsetWidth`/`offsetHeight` specifically, not `getBoundingClientRect`: `virtual-core`'s own
 * `getRect` reads those two (`@tanstack/virtual-core/dist/esm/index.js:14-17`). `scrollTo` is not
 * implemented in jsdom at all and `scrollToEnd` calls it, so it is defined rather than spied on.
 *
 * The scroll element is the only element that needs a size; rows are positioned by inline
 * `transform` and never measured (`measureElement` is exactly what this component must not call).
 */
const VIEWPORT_H = 600;
const VIEWPORT_W = 1004;

function giveTheScrollerAViewport() {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(VIEWPORT_H);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(VIEWPORT_W);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(VIEWPORT_H);
  if (!("scrollTo" in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      value: () => {},
      writable: true,
      configurable: true,
    });
  }
}

/* --------------------------------------------------------------- fixtures */

const S1 = "11111111-1111-4111-8111-1111111a1b2c" as SessionId;
const S2 = "22222222-2222-4222-8222-2222222d3e4f" as SessionId;
const P1 = "project-one" as ProjectId;

/** 2026-09-03 12:34:00 local, so the printed minute is stable whatever the runner's zone. */
const T0 = new Date(2026, 8, 3, 12, 34, 0).getTime();

function row(s: SessionId, q: number, t: number, l: string): FeedRowWire {
  return { s, q, t, l };
}

/** Mounts `Feed` against a freshly reset `feedStore` seeded with `rows`. */
async function mount(
  rows: FeedRowWire[],
  props: { sessionId: SessionId | null; projectId: ProjectId | null; projectName?: string | null },
) {
  vi.resetModules();
  const store = await import("../feedStore");
  const { Feed } = await import("./Feed");
  if (rows.length > 0) {
    store.noteProjects([P1]);
    store.pushBatch({ project_id: P1, rows, signals: [], counters: [] });
    // `pushBatch` queues into the rAF drain; `getSessionRows` reads the committed ring.
    store.start();
    // The ring trims to the newest `ROW_CAP` from the head, so a batch longer than the cap does
    // not land whole; waiting for `rows.length` would hang on exactly the test that pushes 5,000.
    const expected = Math.min(rows.length, store.ROW_CAP);
    await vi.waitFor(() => {
      const got =
        props.sessionId !== null
          ? store.getSessionRows(props.sessionId)
          : store.getProjectRows(props.projectId);
      expect(got.length).toBe(expected);
    });
    store.stop();
  }
  const view = render(<Feed {...props} />);
  return { view, store };
}

describe("a feed row", () => {
  beforeEach(() => {
    giveTheScrollerAViewport();
  });

  it("renders the line the harness sent, verbatim", async () => {
    await mount([row(S1, 1, T0, "session started · claude-sonnet-4-5 · /repos/job-portal")], {
      sessionId: S1,
      projectId: P1,
    });
    expect(
      screen.getByText("session started · claude-sonnet-4-5 · /repos/job-portal"),
    ).toBeInTheDocument();
  });

  it("does not render the envelope sequence number", async () => {
    // `q` is a wire field, not user content. 4242 is distinctive enough that a stray render of it
    // anywhere in the pane fails this.
    await mount([row(S1, 4242, T0, "tool Read · src/App.tsx")], {
      sessionId: S1,
      projectId: P1,
    });
    expect(screen.queryByText(/4242/)).not.toBeInTheDocument();
  });

  it("prints the clock once for a run of rows inside the same minute", async () => {
    await mount(
      [
        row(S1, 1, T0, "turn started"),
        row(S1, 2, T0 + 1_000, "tool Read · src/App.tsx"),
        row(S1, 3, T0 + 2_000, "tool Edit · src/App.tsx"),
      ],
      { sessionId: S1, projectId: P1 },
    );
    expect(screen.getAllByText("12:34")).toHaveLength(1);
  });

  it("prints the clock again once the minute changes", async () => {
    await mount(
      [
        row(S1, 1, T0, "turn started"),
        row(S1, 2, T0 + 61_000, "turn completed"),
      ],
      { sessionId: S1, projectId: P1 },
    );
    expect(screen.getByText("12:34")).toBeInTheDocument();
    expect(screen.getByText("12:35")).toBeInTheDocument();
  });

  it("names the session in a project view, where more than one can be talking", async () => {
    await mount(
      [
        row(S1, 1, T0, "one from the first session"),
        row(S2, 1, T0 + 1_000, "one from the second"),
      ],
      { sessionId: null, projectId: P1 },
    );
    expect(screen.getByText("1a1b2c")).toBeInTheDocument();
    expect(screen.getByText("2d3e4f")).toBeInTheDocument();
  });

  it("does not name the session in a session view, where there is only one", async () => {
    await mount([row(S1, 1, T0, "the only session there is")], {
      sessionId: S1,
      projectId: P1,
    });
    expect(screen.queryByText("1a1b2c")).not.toBeInTheDocument();
  });

  it("names the session once for a run of consecutive rows from it", async () => {
    await mount(
      [
        row(S1, 1, T0, "first"),
        row(S1, 2, T0 + 1_000, "second"),
        row(S2, 1, T0 + 2_000, "the other session"),
        row(S2, 2, T0 + 3_000, "still the other session"),
      ],
      { sessionId: null, projectId: P1 },
    );
    expect(screen.getAllByText("1a1b2c")).toHaveLength(1);
    expect(screen.getAllByText("2d3e4f")).toHaveLength(1);
  });
});

describe("the virtualizer", () => {
  beforeEach(() => {
    giveTheScrollerAViewport();
  });

  /**
   * The hard constraint on this component. 5,000 rows at a 28px pitch is 140,000px of content; a
   * 600px viewport plus 12 rows of overscan on each side is on the order of 45 rows. The bound
   * below is deliberately loose (it is not asserting a particular overscan) and still two orders
   * of magnitude under "renders everything", which is the failure it exists to catch.
   */
  it("mounts a bounded number of rows for a list far longer than the viewport", async () => {
    const rows = Array.from({ length: 5_000 }, (_, i) =>
      row(S1, i + 1, T0 + i * 1_000, `line number ${i}`),
    );
    await mount(rows, { sessionId: S1, projectId: P1 });
    const mounted = screen.getAllByText(/^line number \d+$/);
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(200);
  });

  it("reports the total, so the window is never mistaken for the whole feed", async () => {
    const rows = Array.from({ length: 5_000 }, (_, i) =>
      row(S1, i + 1, T0 + i * 1_000, `line number ${i}`),
    );
    await mount(rows, { sessionId: S1, projectId: P1 });
    // ROW_CAP is 2000, so 5,000 pushed rows are trimmed to the newest 2,000 and the pane says so.
    expect(screen.getByText(/2000 rows \(capped at 2000\)/)).toBeInTheDocument();
  });
});

describe("the empty state", () => {
  beforeEach(() => {
    giveTheScrollerAViewport();
  });

  it("asks what to run, naming the project", async () => {
    await mount([], { sessionId: null, projectId: P1, projectName: "job-portal" });
    expect(
      screen.getByRole("heading", { name: "What should we run in job-portal?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Every session under this project shows up here as it runs."),
    ).toBeInTheDocument();
  });

  it("says a selected session has simply not spoken yet", async () => {
    await mount([], { sessionId: S1, projectId: P1, projectName: "job-portal" });
    expect(screen.getByText("This session has not emitted a row yet.")).toBeInTheDocument();
  });

  it("points at the sidebar when there is no project at all", async () => {
    await mount([], { sessionId: null, projectId: null, projectName: null });
    expect(screen.getByRole("heading", { name: "Add a project to begin" })).toBeInTheDocument();
    expect(
      screen.getByText("Use the plus beside Projects in the sidebar to add a repository path."),
    ).toBeInTheDocument();
  });
});

describe("the jump affordance", () => {
  it("is absent while the reader is at the tail", async () => {
    giveTheScrollerAViewport();
    await mount([row(S1, 1, T0, "a line")], { sessionId: S1, projectId: P1 });
    expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument();
  });

  /**
   * Detaching from the tail is read off the DOM rather than off React state, so this drives it the
   * way the app does: a real scroll event on the scroll container, with `scrollHeight` and
   * `scrollTop` stubbed because jsdom does not scroll.
   */
  it("appears once the reader has scrolled away from it, and scrolls back on click", async () => {
    giveTheScrollerAViewport();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(10_000);
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockReturnValue(0);

    const rows = Array.from({ length: 300 }, (_, i) =>
      row(S1, i + 1, T0 + i * 1_000, `line number ${i}`),
    );
    const { view } = await mount(rows, { sessionId: S1, projectId: P1 });

    const scroller = view.container.querySelector("div > div");
    expect(scroller).not.toBeNull();
    scroller!.dispatchEvent(new Event("scroll", { bubbles: true }));

    const pill = await screen.findByRole("button", { name: /jump to latest/i });
    await userEvent.click(pill);
    // Clicking it re-attaches to the tail, so the only way back stops being offered.
    expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument();
  });
});
