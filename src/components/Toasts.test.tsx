import { act, cleanup, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";

import { notify } from "../desktopApi";
import { Toasts } from "./Toasts";

/**
 * Two behaviours the hand-written stack had and sonner does not give for free.
 *
 * Fake timers are the point of both: sonner's 6s countdown and its 200ms exit are `setTimeout`s,
 * and the window between them is where the accessibility-tree state lives. Sonner defers every
 * add through a zero-delay `setTimeout` and every dismiss through two `requestAnimationFrame`
 * hops ("prevent batching, temp solution" — `sonner/dist/index.mjs`), so both clocks have to be
 * faked. Each hop only reaches the next one after React has flushed, which is why `settle()`
 * advances across several `act` boundaries rather than in one jump.
 */
const clock = () =>
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });

function settle(ms = 100, steps = 6) {
  for (let i = 0; i < steps; i++)
    act(() => {
      vi.advanceTimersByTime(ms);
    });
}

function push(message: string) {
  act(() => {
    notify(message);
  });
  act(() => {
    vi.advanceTimersByTime(1);
  });
}

afterEach(() => {
  // `ToastState` is a module-level singleton and `subscribe` replays whatever is still active, so
  // a toast left standing here reappears under the next test's Toaster.
  act(() => {
    toast.dismiss();
  });
  settle();
  cleanup();
  vi.useRealTimers();
});

it("drops the oldest notice when a fifth arrives, and keeps the newest", () => {
  clock();
  render(<Toasts />);
  for (const message of ["one", "two", "three", "four", "five"]) push(message);
  // `visibleToasts` alone would leave the over-cap row mounted at `opacity: 0` — still in the
  // accessibility tree, and an error notice never expires. Past sonner's 200ms exit the dropped
  // row is gone from the DOM entirely, which is what the hand-written stack did immediately.
  settle();
  expect(screen.queryByText("one")).not.toBeInTheDocument();
  for (const message of ["two", "three", "four", "five"])
    expect(screen.getByText(message)).toBeInTheDocument();
});

it("stops announcing a notice that expires on its own timer, before it unmounts", () => {
  clock();
  render(<Toasts />);
  push("saved the worktree");
  expect(screen.getByRole("status")).toHaveTextContent("saved the worktree");
  // Land exactly on the 6s duration: past the auto-close but inside the 200ms exit, so the row is
  // still on screen and must no longer be a live region — the state the Dismiss button already
  // produced, and the one an expiring toast used to miss.
  settle(3000, 2);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByText("saved the worktree")).toBeInTheDocument();
});
