/**
 * The trace half of `src/perfDiagnostics.ts`.
 *
 * `profiling` is `import.meta.env.VITE_REACT_PROFILE === "1"`, evaluated once at module scope, so
 * it is a build-time constant in a real bundle and nothing can flip it at run time. Under vitest
 * `import.meta.env` is a live object, so `vi.stubEnv` + `vi.resetModules()` + `await import(…)`
 * gets a module instance whose constant is the other value — the same isolation
 * `src/paint.test.ts` and `src/feedStore.test.ts` use, for the same reason: every piece of state
 * here is module-level and there is no test-only `reset()` export to drift.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Diagnostics = typeof import("./perfDiagnostics");

/**
 * A profiling build wraps `console.timeStamp` at module scope to harvest React's scheduler spans.
 * jsdom's `console` has no `timeStamp` at all — WKWebView and Chrome do — so the import throws
 * without this stand-in. Restored after every test, since each re-import wraps it again.
 */
const originalTimeStamp = console.timeStamp as ((...args: unknown[]) => void) | undefined;

async function load(profile: boolean): Promise<Diagnostics> {
  vi.stubEnv("VITE_REACT_PROFILE", profile ? "1" : "0");
  (console as { timeStamp?: (...args: unknown[]) => void }).timeStamp ??= () => {};
  vi.resetModules();
  return await import("./perfDiagnostics");
}

afterEach(() => {
  if (originalTimeStamp === undefined) delete (console as { timeStamp?: unknown }).timeStamp;
  else console.timeStamp = originalTimeStamp;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("without a profiling build", () => {
  it("returns null and buffers nothing", async () => {
    const d = await load(false);
    expect(d.profiling).toBe(false);
    d.resetDiagnostics();
    d.traceEvent("frame", 16.7);
    d.markRenderUpdate();
    expect(d.getDiagnostics()).toBeNull();
  });
});

describe("traceEvent", () => {
  it("buffers kind, detail and a timestamp while active", async () => {
    const d = await load(true);
    d.resetDiagnostics();
    d.traceEvent("frame", 16.7);
    d.traceEvent("markdown-module");
    const out = d.getDiagnostics();
    expect(out?.trace).toHaveLength(2);
    expect(out?.trace[0]).toMatchObject({ k: "frame", d: 16.7 });
    expect(typeof out?.trace[0]?.t).toBe("number");
    expect(out?.trace[1]).toMatchObject({ k: "markdown-module", d: undefined });
    expect(out?.traceDropped).toBe(0);
  });

  it("buffers nothing outside a capture", async () => {
    const d = await load(true);
    // Before any `resetDiagnostics`, and again after `getDiagnostics` has closed the capture.
    d.traceEvent("early");
    d.resetDiagnostics();
    expect(d.getDiagnostics()?.trace).toHaveLength(0);
    d.traceEvent("late");
    expect(d.getDiagnostics()?.trace).toHaveLength(0);
  });

  it("clears the buffer on reset", async () => {
    const d = await load(true);
    d.resetDiagnostics();
    d.traceEvent("frame", 1);
    d.resetDiagnostics();
    d.traceEvent("frame", 2);
    expect(d.getDiagnostics()?.trace).toEqual([expect.objectContaining({ k: "frame", d: 2 })]);
  });

  it("counts entries past the cap instead of growing without bound", async () => {
    const d = await load(true);
    d.resetDiagnostics();
    for (let i = 0; i < d.TRACE_CAP + 5; i++) d.traceEvent("frame", i);
    const out = d.getDiagnostics();
    expect(out?.trace).toHaveLength(d.TRACE_CAP);
    expect(out?.traceDropped).toBe(5);
    // The retained window is the head, so the run's start is never lost to a late flood.
    expect(out?.trace[d.TRACE_CAP - 1]).toMatchObject({ d: d.TRACE_CAP - 1 });
  });
});

describe("markRenderUpdate", () => {
  it("records the delay to the next macrotask once per post", async () => {
    const d = await load(true);
    d.resetDiagnostics();
    d.markRenderUpdate();
    // A second post while one is in flight is dropped: one probe per frame, not one per call.
    d.markRenderUpdate();
    await new Promise(resolve => setTimeout(resolve, 0));
    const out = d.getDiagnostics();
    const posts = out?.trace.filter(e => e.k === "render-update") ?? [];
    expect(posts).toHaveLength(1);
    expect(posts[0]?.d).toBeGreaterThanOrEqual(0);
  });
});
