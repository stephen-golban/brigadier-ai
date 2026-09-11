/**
 * The shared `workbench_load` snapshot: one poll, one in-flight load, deferred past first paint.
 * Every test here drives simulated time, so `advanceTimersByTimeAsync(20)` is what stands in for
 * "the browser painted and the next task ran" — `afterPaint` is a faked `requestAnimationFrame`
 * (a 16 ms interval under Vitest) plus a `setTimeout(…, 0)` inside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { workbenchApi, defaultSettings, type WorkbenchData } from "./workbenchApi";
import {
  WORKBENCH_POLL_MS,
  getSnapshot,
  publishWorkbench,
  resetWorkbenchStore,
  useWorkbenchSnapshot,
  type WorkbenchSnapshot,
} from "./workbenchStore";

const payload = (displayName = "Stephen"): WorkbenchData => ({
  notes: [],
  projects: {},
  global: { ...defaultSettings },
  displayName,
});

function Consumer({ seen }: { seen?: WorkbenchSnapshot[] }) {
  const snapshot = useWorkbenchSnapshot();
  seen?.push(snapshot);
  return <span data-testid="name">{snapshot.data.displayName ?? ""}</span>;
}

let visibility: DocumentVisibilityState = "visible";
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}
/** Simulated time long enough for the deferred first load's frame and its trailing task. */
const paint = () => act(async () => void (await vi.advanceTimersByTimeAsync(20)));
const wait = (ms: number) =>
  act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  cleanup();
  resetWorkbenchStore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shared workbench snapshot", () => {
  it("defers the first load past the mount tick and runs one load per cadence for two consumers", async () => {
    const load = vi.spyOn(workbenchApi, "load").mockResolvedValue(payload());
    render(
      <>
        <Consumer />
        <Consumer />
      </>,
    );
    // The mount effects have run; `Sidebar` and `ProjectWorkbench` used to have both round trips
    // in flight by this point, inside the shell's own mount frame.
    expect(load).not.toHaveBeenCalled();
    await paint();
    expect(load).toHaveBeenCalledTimes(1);
    await wait(WORKBENCH_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    await wait(WORKBENCH_POLL_MS);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not fetch while the document is hidden and fetches once when it becomes visible", async () => {
    const load = vi.spyOn(workbenchApi, "load").mockResolvedValue(payload());
    visibility = "hidden";
    render(<Consumer />);
    await paint();
    await wait(WORKBENCH_POLL_MS * 3);
    expect(load).not.toHaveBeenCalled();
    await act(async () => {
      setVisibility("visible");
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("clears the cadence when the last consumer unmounts", async () => {
    const load = vi.spyOn(workbenchApi, "load").mockResolvedValue(payload());
    const first = render(<Consumer />);
    const second = render(<Consumer />);
    await paint();
    expect(load).toHaveBeenCalledTimes(1);
    first.unmount();
    await wait(WORKBENCH_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    second.unmount();
    await wait(WORKBENCH_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps snapshot identity for an unchanged payload and replaces it for a changed one", async () => {
    const seen: WorkbenchSnapshot[] = [];
    const load = vi.spyOn(workbenchApi, "load").mockResolvedValue(payload());
    render(<Consumer seen={seen} />);
    await paint();
    const loaded = getSnapshot();
    expect(loaded.loaded).toBe(true);
    expect(loaded.data.displayName).toBe("Stephen");
    const renders = seen.length;

    // An equal payload, freshly allocated: the change detector must not publish it.
    load.mockResolvedValue(payload());
    await wait(WORKBENCH_POLL_MS);
    expect(getSnapshot()).toBe(loaded);
    expect(seen.length).toBe(renders);

    load.mockResolvedValue(payload("Ada"));
    await wait(WORKBENCH_POLL_MS);
    expect(getSnapshot()).not.toBe(loaded);
    expect(getSnapshot().data.displayName).toBe("Ada");
    expect(seen.length).toBeGreaterThan(renders);
  });

  it("coalesces requests raised while a load is in flight into one follow-up", async () => {
    let finish!: (data: WorkbenchData) => void;
    const load = vi
      .spyOn(workbenchApi, "load")
      .mockImplementation(
        () =>
          new Promise<WorkbenchData>((resolve) => {
            finish = resolve;
          }),
      );
    render(
      <>
        <Consumer />
        <Consumer />
      </>,
    );
    await paint();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event("workbench-data-changed"));
      window.dispatchEvent(new Event("workbench-data-changed"));
      await vi.advanceTimersByTimeAsync(WORKBENCH_POLL_MS);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(payload());
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps a local publish that an older in-flight load would have reverted", async () => {
    let finish!: (data: WorkbenchData) => void;
    const load = vi
      .spyOn(workbenchApi, "load")
      .mockImplementation(
        () =>
          new Promise<WorkbenchData>((resolve) => {
            finish = resolve;
          }),
      );
    render(<Consumer />);
    await paint();
    expect(load).toHaveBeenCalledTimes(1);

    // A save resolves: the caller publishes its response and tells the window about it. The
    // `workbench-data-changed` load finds one in flight and is coalesced into `queued`.
    await act(async () => {
      publishWorkbench(payload("Ada"));
      window.dispatchEvent(new Event("workbench-data-changed"));
    });
    expect(getSnapshot().data.displayName).toBe("Ada");

    // Now the request issued *before* the save resolves, carrying the pre-save payload.
    await act(async () => {
      finish(payload("Stephen"));
    });
    expect(getSnapshot().data.displayName).toBe("Ada");
    // The follow-up the coalescing queued is what brings the backend's view back.
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish(payload("Ada"));
    });
    expect(getSnapshot().data.displayName).toBe("Ada");
  });

  it("clears the cadence while the document is hidden and re-arms it when it shows", async () => {
    vi.spyOn(workbenchApi, "load").mockResolvedValue(payload());
    const armed = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const cadences = () =>
      armed.mock.calls.filter((call) => call[1] === WORKBENCH_POLL_MS).length;
    render(<Consumer />);
    await paint();
    expect(cadences()).toBe(1);

    const before = cleared.mock.calls.length;
    await act(async () => {
      setVisibility("hidden");
    });
    // The interval is gone, not merely ticking into an early return.
    expect(cleared.mock.calls.length).toBe(before + 1);
    await wait(WORKBENCH_POLL_MS * 3);
    expect(cadences()).toBe(1);

    await act(async () => {
      setVisibility("visible");
    });
    expect(cadences()).toBe(2);
  });

  it("re-arms a first load after the last consumer left with one in flight", async () => {
    let finish!: (data: WorkbenchData) => void;
    const load = vi
      .spyOn(workbenchApi, "load")
      .mockImplementation(
        () =>
          new Promise<WorkbenchData>((resolve) => {
            finish = resolve;
          }),
      );
    const first = render(<Consumer />);
    await paint();
    expect(load).toHaveBeenCalledTimes(1);

    // `stop()` runs with the request still out there. If it left `inFlight` set, the remount's
    // load would be swallowed as a `queued` follow-up on a promise nothing will act on again.
    first.unmount();
    render(<Consumer />);
    await paint();
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish(payload("Ada"));
    });
    expect(getSnapshot().data.displayName).toBe("Ada");
  });

  it("reports a load failure once and keeps serving the last good payload", async () => {
    const load = vi.spyOn(workbenchApi, "load").mockResolvedValue(payload());
    render(<Consumer />);
    await paint();
    load.mockRejectedValue(new Error("workbench_load failed"));
    await wait(WORKBENCH_POLL_MS);
    expect(getSnapshot().error).toContain("workbench_load failed");
    expect(getSnapshot().data.displayName).toBe("Stephen");
  });
});
