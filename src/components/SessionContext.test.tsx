/**
 * The context meter.
 *
 * What is pinned here is the thing that made re-mounting it worth doing: **the compaction
 * threshold is on screen before you cross it.** A compaction is ~12 s of silence
 * (`duration_ms: 12262`, measured 2026-09-11) followed by a past-tense transcript row, and the
 * harness drops the CLI's in-progress `system/status` frame — so the line is the only warning
 * there is.
 *
 * The threshold is never derived. It came back at 83.5% of the window by model default and 67%
 * under `CLAUDE_CODE_AUTO_COMPACT_WINDOW` on the same afternoon
 * (`docs/research/compaction-and-long-sessions-2026-09-11.md` §A1), so a component that computed
 * one from `limit` would draw a line that is simply wrong, which is worse than no line.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionApi, type ContextReading } from "../sessionApi";
import { compactPercent, contextPercent, SessionContext } from "./SessionContext";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function reading(over: Partial<ContextReading> = {}): ContextReading {
  return {
    available: true,
    used: 120_000,
    limit: 200_000,
    compactAt: 167_000,
    compactSource: "model-default",
    model: "claude-haiku-4-5",
    estimated: true,
    sampledAt: 1,
    ...over,
  };
}

/** Mount and let the first (immediately scheduled) read land. */
async function mount(value: ContextReading, busy = false) {
  vi.useFakeTimers();
  const read = vi.spyOn(sessionApi, "context").mockResolvedValue(value);
  const view = render(<SessionContext sessionId="s" revision={0} busy={busy} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  return { read, view };
}

describe("context meter", () => {
  it("reads a percentage only from a usable current reading", () => {
    expect(contextPercent(null)).toBeNull();
    expect(contextPercent({ available: true, used: 1, limit: 0 })).toBeNull();
    expect(contextPercent({ available: true, used: NaN, limit: 200_000 })).toBeNull();
    expect(contextPercent({ available: false, reason: "no" })).toBeNull();
    expect(contextPercent({ available: true, used: 220_000, limit: 200_000 })).toBe(110);
    expect(contextPercent(reading())).toBe(60);
  });

  it("places the compaction line from the reported threshold and never from a ratio", () => {
    expect(compactPercent(reading())).toBe(84);
    // The same window, a different threshold: the line moves with the CLI, not with `limit`.
    expect(compactPercent(reading({ limit: 100_000, compactAt: 67_000 }))).toBe(67);
    // Absent, unusable or nonsensical means no line at all.
    expect(compactPercent(reading({ compactAt: null }))).toBeNull();
    expect(compactPercent(reading({ compactAt: undefined }))).toBeNull();
    expect(compactPercent(reading({ compactAt: 0 }))).toBeNull();
    expect(compactPercent(reading({ compactAt: 400_000 }))).toBeNull();
    expect(compactPercent(reading({ available: false }))).toBeNull();
  });

  it("shows where the window is and where it compacts, and marks the line on the track", async () => {
    await mount(reading());
    screen.getByLabelText("Context 60% used, auto-compacts at 84%");
    expect(screen.getByText("Context 60%")).toBeInTheDocument();
    // `high` is the threshold, so the native bar changes colour at the crossing point rather
    // than at a decorative constant.
    const meter = screen.getByLabelText("Context used");
    expect(meter).toHaveAttribute("value", "60");
    expect(meter).toHaveAttribute("high", "84");
    expect(document.querySelector(".gauge-track")).toHaveStyle({ "--gauge-mark": "84%" });
    expect(document.querySelector(".gauge-mark")).toBeInTheDocument();
    // Windows and tokens, never dollars.
    expect(document.body.textContent).not.toMatch(/\$|usd/i);
  });

  it("warns before the threshold and states the crossing after it", async () => {
    await mount(reading({ used: 158_000 }));
    screen.getByLabelText("Context 79% used, auto-compacts at 84%");
    expect(screen.getByText("compacts soon")).toBeInTheDocument();
    cleanup();
    await mount(reading({ used: 172_000 }));
    screen.getByLabelText("Context 86% used, past the 84% auto-compaction threshold");
    expect(screen.getByText("compacting")).toBeInTheDocument();
  });

  it("draws no line when the provider reported no threshold", async () => {
    await mount(reading({ compactAt: null, compactSource: null }));
    screen.getByLabelText("Context 60% used; the provider did not report a compaction threshold");
    expect(document.querySelector(".gauge-mark")).toBeNull();
  });

  it("degrades to an em dash with the provider's own reason", async () => {
    await mount({ available: false, reason: "Rewind outcome requires reconciliation" });
    screen.getByLabelText("Context usage unknown");
    expect(screen.getByText("Context —")).toBeInTheDocument();
    expect(screen.queryByText("Context 60%")).not.toBeInTheDocument();
  });

  it("survives a thrown command rather than unmounting the composer", async () => {
    vi.useFakeTimers();
    vi.spyOn(sessionApi, "context").mockRejectedValue(new Error("child is gone"));
    render(<SessionContext sessionId="s" revision={0} busy={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    screen.getByLabelText("Context usage unknown");
  });

  it("coalesces a burst of signals into one read, and keeps the number on screen meanwhile", async () => {
    const { read, view } = await mount(reading(), true);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(reading({ used: 10_000 }));

    // One turn's worth of signals: started, three approvals opened and resolved, usage windows.
    for (let revision = 1; revision <= 7; revision++) {
      view.rerender(<SessionContext sessionId="s" revision={revision} busy={true} />);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // Still one call — and, the flicker this used to have: the meter still reads 60%, it did not
    // blank to `—` on each of the seven rerenders.
    expect(read).toHaveBeenCalledTimes(1);
    screen.getByLabelText("Context 60% used, auto-compacts at 84%");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    screen.getByLabelText("Context 5% used, auto-compacts at 84%");
  });

  it("clears the reading when the session changes, and polls slower when idle", async () => {
    const { read, view } = await mount(reading(), true);
    read.mockResolvedValue(reading({ used: 20_000 }));
    view.rerender(<SessionContext sessionId="other" revision={0} busy={true} />);
    // A different session's number is not this session's, so it is dropped, not carried over.
    screen.getByLabelText("Context usage unknown");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(read).toHaveBeenLastCalledWith("other");
    screen.getByLabelText("Context 10% used, auto-compacts at 84%");
    // Busy re-reads at 8 s; idle would not have.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100);
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("answers from the browser fixture off the desktop, threshold included", async () => {
    // jsdom is not a Tauri window, so this is the path `npm run dev` takes. It used to refuse,
    // which is how a working meter stayed invisible in the only fixture anyone reviews.
    const demo = await sessionApi.context("no-such-session");
    expect(demo.available).toBe(true);
    expect(demo.limit).toBe(200_000);
    expect(demo.compactAt).toBe(167_000);
    expect(compactPercent(demo)).toBe(84);
    expect(contextPercent(demo)).not.toBeNull();
    expect(JSON.stringify(demo)).not.toMatch(/cost|usd/i);
  });
});
