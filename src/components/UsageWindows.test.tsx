/**
 * The usage-window gauge.
 *
 * Two rules are load-bearing and both are asserted here.
 *
 * **Windows, never dollars** (`docs/vision.md` §6). The owner runs on his own subscription, so a
 * currency figure is a number he is never billed. `total_cost_usd` exists on the provider's wire
 * and stops at `src/wire.ts`; nothing downstream of it may render money.
 *
 * **The cached reference.** `feedStore.getUsageWindows` hands back the same array until a value
 * actually moves, because a fresh object per snapshot would make this gauge re-render the whole
 * window on every re-announcement. The selector here must not `map`, `filter` or spread.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as feedStore from "../feedStore";
import type { Envelope, Event, SessionId } from "../wire";
import { RESERVE, resetLabel, tightest, UsageWindows, windowLabel } from "./UsageWindows";

const PROJECT = "p1";
let seq = 0;
/**
 * A fresh session id per test. `feedStore` is a module singleton with no `reset()`, and
 * `dropSession` records the id in `deletedSessions` **forever** — a teardown that dropped a
 * shared id silently filtered every later test's signals out of `applyBatch`.
 */
let S = "s-usage-0" as SessionId;

function envelope(session: SessionId, event: Event): Envelope {
  seq += 1;
  return { seq, at: 1_000 + seq, instance_id: "i", session_id: session, event };
}

function announce(five: number, seven = 0.03) {
  feedStore.pushBatch({
    project_id: PROJECT,
    rows: [],
    counters: [],
    signals: [
      envelope(S, {
        type: "usage-windows",
        status: "allowed",
        windows: [
          { name: "five_hour", utilization: five, resets_at: 1_789_068_000 },
          { name: "seven_day", utilization: seven, resets_at: 1_789_556_400 },
        ],
      }),
    ],
  });
  act(() => {
    vi.advanceTimersByTime(17);
  });
}

let nth = 0;
beforeEach(() => {
  S = `s-usage-${++nth}` as SessionId;
  vi.useFakeTimers();
  feedStore.start();
});

afterEach(() => {
  cleanup();
  feedStore.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usage windows gauge", () => {
  it("names an open set of windows without inventing one", () => {
    expect(windowLabel("five_hour")).toBe("5-hour");
    expect(windowLabel("seven_day")).toBe("7-day");
    // The provider's keys are open. An unknown one is shown, not dropped.
    expect(windowLabel("thirty_day")).toBe("thirty day");
  });

  it("counts down from unix seconds, not the wire's milliseconds", () => {
    const now = 1_789_000_000_000; // ms
    expect(resetLabel(1_789_068_000, now)).toBe("resets in 18h 53m");
    expect(resetLabel(1_789_000_000 + 1_800, now)).toBe("resets in 30m");
    expect(resetLabel(1_789_556_400, now)).toBe("resets in 6d 10h");
    expect(resetLabel(1_788_000_000, now)).toBe("resetting");
  });

  it("leads with the window closest to the reserve, because that is the one that gates work", () => {
    const five = { name: "five_hour", utilization: 0.62, resets_at: 1 };
    const seven = { name: "seven_day", utilization: 0.81, resets_at: 2 };
    expect(tightest([five, seven])).toBe(seven);
    expect(tightest([])).toBeNull();
  });

  it("renders nothing until the provider has reported", () => {
    const { container } = render(<UsageWindows sessionId={S} />);
    // No reading is not "0% spent". The provider sends one per session, early but not at t=0.
    expect(container).toBeEmptyDOMElement();
  });

  it("draws the window, the reserve line and the countdown, and no currency anywhere", () => {
    render(<UsageWindows sessionId={S} />);
    announce(0.15);
    screen.getByLabelText("5-hour usage window 15% spent");
    expect(screen.getByText("5-hour 15%")).toBeInTheDocument();
    const meter = screen.getByLabelText("Usage window spent");
    expect(meter).toHaveAttribute("value", "15");
    expect(meter).toHaveAttribute("high", String(Math.round(RESERVE * 100)));
    expect(document.querySelector(".gauge-track")).toHaveStyle({ "--gauge-mark": "80%" });
    expect(document.body.textContent).not.toMatch(/\$|usd|dollar/i);
  });

  it("says when the reserve that protects the user's own Claude Code has been passed", () => {
    render(<UsageWindows sessionId={S} />);
    announce(0.82);
    screen.getByLabelText("5-hour usage window 82% spent, past the 80% reserve");
    expect(screen.getByText("past reserve")).toBeInTheDocument();
  });

  it("follows the store, and holds the cached reference when a window is re-announced", () => {
    render(<UsageWindows sessionId={S} />);
    announce(0.15);
    const first = feedStore.getUsageWindows(S);
    screen.getByLabelText("5-hour usage window 15% spent");

    // Identical values: the same array comes back, so the gauge costs no render.
    announce(0.15);
    expect(feedStore.getUsageWindows(S)).toBe(first);
    screen.getByLabelText("5-hour usage window 15% spent");

    // A moved value: a new reference, and the gauge follows it.
    announce(0.41);
    expect(feedStore.getUsageWindows(S)).not.toBe(first);
    screen.getByLabelText("5-hour usage window 41% spent");
  });

  it("shows every window the provider sent, not only the leader", () => {
    // The popover carries two bars and two countdowns (`docs/vision.md` §12); the strip carries
    // the tighter one. Both read the same array, so the second window is present in the store
    // and reachable from the same snapshot the button renders.
    render(<UsageWindows sessionId={S} />);
    announce(0.15, 0.44);
    expect(feedStore.getUsageWindows(S).map(w => w.name)).toEqual(["five_hour", "seven_day"]);
    screen.getByLabelText("7-day usage window 44% spent");
  });
});
