/**
 * Behavioural tests for `src/components/Feed.tsx`.
 *
 * Same rule as `Sidebar.test.tsx` and for the same reason: **assert on text and roles, never on
 * class names or structure.** W4-D2 restyled the row around the `k` kind field; W4-E moves things
 * again. A test bound to this markup dies with it and proves only that this markup once existed.
 * `docs/plans/phase-4.md` states the rule. Which is why nothing below asserts that an `err` row is
 * red or that an `appr` row is bold — those are CSS, they are certified by ratio in
 * `src/index.css`, and a test of them would be a test of a class name.
 *
 * What is pinned here, and why each one is load-bearing rather than decorative:
 *
 *   - **A row still shows its line.** The whole point of the pane. It survived a redesign that
 *     removed two of the four things a row used to draw.
 *   - **The virtualizer still windows.** This is the one measured-good property of this component
 *     and the hard constraint on the redesign. jsdom reports every element as 0x0, so the scroll
 *     container is given a size by hand; without it the pane would window down to nothing and the
 *     assertion would pass for the wrong reason.
 *
 *     The parenthetical this line used to carry — *"~110 DOM nodes at 60 Hz over 1,513 samples"*
 *     — was wrong in two of its three parts and is corrected here rather than deleted
 *     (`docs/research/visual-checks-2026-09-04.md` §3.1, §3.6, §3.7). **60 Hz holds** and is now
 *     measured on the 28px row: 62 of 62 one-second windows at `hz 60`, `p50 17.0 ms`, under a
 *     10-session burn, 2026-09-04, on a debug build. **The 1,513-sample citation is superseded**
 *     — `864a2fe` changed `ROW_H` 18 → 28 and every window in `frame-stats.ndjson` predates it.
 *     **`dom_nodes` was never a feed metric**: it counts the whole document; the feed row is
 *     **2 DOM nodes**.
 *   - **The clock is printed where it changes and nowhere else.** The old row printed `HH:MM:SS`
 *     on every line, which is what made seven rows inside one second read as a table. This is the
 *     behaviour that replaced it, and it is derived from `t` alone — no character of `l` is read.
 *   - **The session ref appears only in a project view, and only where the session changes.**
 *   - **No sequence number.** `q` is a wire envelope field; it was a column and is now nothing.
 *   - **The empty state says what it says**, for all three of its cases.
 *   - **The jump affordance appears only when detached from the tail**, since it is the only way
 *     back and offering it while already at the bottom is noise.
 *   - **The verbose toggle hides model prose and nothing else**, and — the one that matters most —
 *     **an `unknown` row survives every setting.** 10,037 of the owner's rows carry `unknown`
 *     because they predate migration 1; a filter that treated it as a class would hide all of
 *     them. `docs/plans/ipc-contract.md` says it in the contract, `src/wire.ts` says it in the
 *     type, and `an unknown row is never filtered by anything` below is what fails if it stops
 *     being true.
 *   - **The fold draws one tool call as one row**, opens to three, and can never fold away a
 *     failed tool result or an approval nobody has answered. The grouping *rules* live in
 *     `src/feedGroups.test.ts`, where they can be argued without a virtualizer; what is pinned
 *     here is what only a render can show.
 *   - **The eleven-kind union is exhaustive.** `EVERY_KIND` is a `Record<FeedKind, true>`, so a
 *     value added to or removed from the type fails `npx tsc --noEmit`, and its keys are asserted
 *     against the eleven slugs `crates/store/tests/feed.rs::kind_is_pinned_for_every_variant`
 *     pins on the Rust side.
 *
 * Mechanics match `src/feedStore.test.ts`: `globals: false`, so every helper is imported from
 * "vitest"; `@testing-library/react`'s auto-cleanup only registers itself when a global
 * `afterEach` exists, which `globals: false` denies it, so `cleanup()` is called by hand.
 * `feedStore` is a module singleton, so each test re-imports it after `vi.resetModules()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { FeedKind, FeedRowWire, ProjectId, SessionId } from "../wire";

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

/**
 * `k` defaults to `"sys"`, a real class, and deliberately **not** to `"unknown"`.
 *
 * `unknown` is the value no filter may ever remove, so defaulting to it would make every test in
 * this file pass against a filter that had stopped working — the same shape of false green
 * `giveTheScrollerAViewport` exists to prevent. The `unknown` behaviour is asserted on rows that
 * say `unknown` on purpose.
 */
function row(s: SessionId, q: number, t: number, l: string, k: FeedKind = "sys"): FeedRowWire {
  return { s, q, t, l, k };
}

/**
 * Every value of `FeedKind`, as a type-checked exhaustive map.
 *
 * `Record<FeedKind, true>` is the gate: a slug added to the union without being added here, or
 * one removed from the union while it stays here, is a `tsc --noEmit` error rather than a test
 * that quietly stops covering a case. The runtime keys are then pinned against the slugs
 * themselves, which is what ties this file to the Rust side —
 * `crates/store/tests/feed.rs::kind_is_pinned_for_every_variant` asserts the same eleven strings,
 * and `docs/plans/ipc-contract.md` §"the kind discriminator" tabulates what each is derived from.
 */
const EVERY_KIND: Record<FeedKind, true> = {
  turn: true,
  tool: true,
  text: true,
  think: true,
  user: true,
  sub: true,
  appr: true,
  warn: true,
  err: true,
  sys: true,
  unknown: true,
};

const ALL_KINDS = Object.keys(EVERY_KIND) as FeedKind[];

/** One row per kind, all inside the same minute so the margin prints one clock and no more. */
function oneOfEachKind(): FeedRowWire[] {
  return ALL_KINDS.map((k, i) => row(S1, i + 1, T0 + i * 1_000, `a ${k} row`, k));
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

/* ------------------------------------------------------------------ kinds */

describe("the kind union", () => {
  /**
   * The compile-time half of this is `EVERY_KIND`'s type. This is the runtime half: the eleven
   * slugs themselves, written out, so a rename on either side of the wire fails here instead of
   * silently reclassifying rows. The same eleven appear in
   * `crates/store/tests/feed.rs::kind_is_pinned_for_every_variant` and in
   * `docs/plans/ipc-contract.md` §"the kind discriminator"; all three were read against each other
   * when this landed.
   */
  it("is exactly the eleven values the Rust side pins and the contract tabulates", () => {
    expect([...ALL_KINDS].sort()).toEqual(
      ["appr", "err", "sub", "sys", "text", "think", "tool", "turn", "unknown", "user", "warn"],
    );
    expect(ALL_KINDS).toHaveLength(11);
  });
});

describe("the verbose toggle", () => {
  beforeEach(() => {
    giveTheScrollerAViewport();
  });

  it("hides model prose by default, and nothing else", async () => {
    await mount(oneOfEachKind(), { sessionId: S1, projectId: P1 });

    expect(screen.queryByText("a text row")).not.toBeInTheDocument();
    for (const k of ALL_KINDS) {
      if (k === "text") continue;
      expect(screen.getByText(`a ${k} row`)).toBeInTheDocument();
    }
  });

  it("shows the prose once it is turned on, and hides it again when it is turned off", async () => {
    await mount(oneOfEachKind(), { sessionId: S1, projectId: P1 });

    const toggle = screen.getByRole("button", { name: "verbose", pressed: false });
    await userEvent.click(toggle);

    expect(screen.getByText("a text row")).toBeInTheDocument();
    for (const k of ALL_KINDS) {
      expect(screen.getByText(`a ${k} row`)).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("button", { name: "verbose", pressed: true }));
    expect(screen.queryByText("a text row")).not.toBeInTheDocument();
  });

  /**
   * **The one that guards 10,037 of the owner's rows.** `unknown` is the absence of a class, not
   * a class, so no setting of this toggle — and no filter anyone adds later — may remove it. If
   * this fails, every row written before store migration 1 has just been hidden.
   */
  it("never filters an unknown row, under either setting", async () => {
    const rows = [
      row(S1, 1, T0, "predates migration 1", "unknown"),
      row(S1, 2, T0 + 1_000, "some model prose", "text"),
    ];
    await mount(rows, { sessionId: S1, projectId: P1 });

    expect(screen.getByText("predates migration 1")).toBeInTheDocument();
    expect(screen.queryByText("some model prose")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "verbose" }));
    expect(screen.getByText("predates migration 1")).toBeInTheDocument();
    expect(screen.getByText("some model prose")).toBeInTheDocument();
  });

  /**
   * A pane that silently showed 10 of 11 rows would be the worst outcome of this feature: the
   * operator would be reading a feed with holes in it and have no way to know. So the count
   * reports both numbers whenever they differ, and only one when they do not.
   */
  it("says how many rows it is holding back, and stops saying it when it holds none", async () => {
    await mount(oneOfEachKind(), { sessionId: S1, projectId: P1 });
    expect(screen.getByText(/10 of 11 rows/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "verbose" }));
    expect(screen.getByText(/^11 rows$/)).toBeInTheDocument();
  });

  /**
   * "This session has not emitted a row yet" is a claim about the feed. A session that has spoken
   * only in prose must not be described that way — that would be the filter lying about the wire.
   */
  it("does not claim a session is silent when the filter is what emptied the pane", async () => {
    await mount([row(S1, 1, T0, "only prose here", "text")], { sessionId: S1, projectId: P1 });

    expect(screen.queryByText("This session has not emitted a row yet.")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Every row so far is model prose" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "verbose" }));
    expect(screen.getByText("only prose here")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Every row so far is model prose" }),
    ).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------- folds */

/**
 * The fold, through the pane rather than through `buildFeed`.
 *
 * `src/feedGroups.test.ts` owns the grouping rules and is where a rule change should be argued.
 * What is pinned here is the part only a render can show: that a folded group is **one mounted
 * row**, that its chevron is a real control, and that opening it puts the members back on screen.
 *
 * Same rule as everything above it: text and roles, never class names.
 */
describe("the fold", () => {
  beforeEach(() => {
    giveTheScrollerAViewport();
  });

  /** The three rows one successful `Bash` call produces, in the order the driver emits them. */
  const CALL: FeedRowWire[] = [
    row(S1, 1, T0, "tool Bash · cargo check", "tool"),
    row(S1, 2, T0 + 1_000, "tool Bash done · cargo check", "tool"),
    row(S1, 3, T0 + 2_000, "tool result done · 41 lines", "tool"),
  ];

  it("draws one tool call as one row, and three once it is opened", async () => {
    await mount([...CALL], { sessionId: S1, projectId: P1 });

    expect(screen.getByText("tool Bash · cargo check")).toBeInTheDocument();
    expect(screen.queryByText("tool Bash done · cargo check")).not.toBeInTheDocument();
    expect(screen.queryByText("tool result done · 41 lines")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "show 2 more rows" }));

    expect(screen.getByText("tool Bash · cargo check")).toBeInTheDocument();
    expect(screen.getByText("tool Bash done · cargo check")).toBeInTheDocument();
    expect(screen.getByText("tool result done · 41 lines")).toBeInTheDocument();

    // …and it folds back, so the affordance is a toggle rather than a one-way door.
    await userEvent.click(screen.getByRole("button", { name: "collapse this group" }));
    expect(screen.queryByText("tool result done · 41 lines")).not.toBeInTheDocument();
  });

  /**
   * **The one that must never be deleted to make a change pass.** `tool failed done · Exit code 1`
   * is a red gate, and `FeedKind` files it under `tool` alongside every successful row, so a fold
   * that could not tell them apart would collapse a failure into silence.
   */
  it("never folds a failed tool call away", async () => {
    await mount(
      [
        row(S1, 1, T0, "tool Bash · cargo test", "tool"),
        row(S1, 2, T0 + 1_000, "tool Bash done · cargo test", "tool"),
        row(S1, 3, T0 + 2_000, "tool failed done · Exit code 1", "tool"),
      ],
      { sessionId: S1, projectId: P1 },
    );

    expect(screen.getByText("tool failed done · Exit code 1")).toBeInTheDocument();
    expect(screen.getByText("tool Bash · cargo test")).toBeInTheDocument();
  });

  /**
   * An approval that has not been answered is not history: a person is blocked on it, and the row
   * is the only thing on this surface that says so.
   */
  it("never folds an approval nobody has answered", async () => {
    await mount(
      [
        row(S1, 1, T0, "tool Bash · rm -rf build", "tool"),
        row(S1, 2, T0 + 1_000, "approval asked · Bash", "appr"),
      ],
      { sessionId: S1, projectId: P1 },
    );

    expect(screen.getByText("approval asked · Bash")).toBeInTheDocument();
  });

  /** …and once it is answered it is history, and goes into the call it blocked. */
  it("folds an answered approval into the call it blocked", async () => {
    await mount(
      [
        row(S1, 1, T0, "tool Bash · rm -rf build", "tool"),
        row(S1, 2, T0 + 1_000, "approval asked · Bash", "appr"),
        row(S1, 3, T0 + 2_000, "approval allowed", "appr"),
        row(S1, 4, T0 + 3_000, "tool Bash done · rm -rf build", "tool"),
      ],
      { sessionId: S1, projectId: P1 },
    );

    expect(screen.getByText("tool Bash · rm -rf build")).toBeInTheDocument();
    expect(screen.queryByText("approval asked · Bash")).not.toBeInTheDocument();
    expect(screen.queryByText("approval allowed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "show 3 more rows" })).toBeInTheDocument();
  });

  /** Verbose is the escape hatch: everything, raw, and no fold offered at all. */
  it("folds nothing under the verbose toggle", async () => {
    await mount([...CALL], { sessionId: S1, projectId: P1 });
    await userEvent.click(screen.getByRole("button", { name: "verbose" }));

    expect(screen.getByText("tool Bash done · cargo check")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show \d+ more/ })).not.toBeInTheDocument();
  });

  /**
   * The fold removes rows from the sizer rather than adding any: the virtualizer counts display
   * lines, so a screenful of collapsed calls mounts no more than a screenful of raw rows did.
   */
  it("keeps the pane windowed, with fewer rows mounted than the ring holds", async () => {
    const rows: FeedRowWire[] = [];
    for (let i = 0; i < 500; i += 1) {
      rows.push(row(S1, i * 3 + 1, T0 + i * 3_000, `tool Bash · step ${i}`, "tool"));
      rows.push(row(S1, i * 3 + 2, T0 + i * 3_000 + 1, `tool Bash done · step ${i}`, "tool"));
      rows.push(row(S1, i * 3 + 3, T0 + i * 3_000 + 2, `tool result done · step ${i}`, "tool"));
    }
    await mount(rows, { sessionId: S1, projectId: P1 });

    const mounted = screen.getAllByText(/^tool Bash · step \d+$/);
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(200);
    // Every `done` and every `result` row is folded away, so none of them is mounted at all.
    expect(screen.queryByText(/^tool Bash done · step \d+$/)).not.toBeInTheDocument();
  });
});
