import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./bridge", () => ({ bridge: () => ({ recordFrameStats: vi.fn().mockResolvedValue(undefined) }) }));
import * as fps from "./fps";
beforeEach(() => { vi.spyOn(performance, "now").mockReturnValue(100); fps.setEnabled(false); fps.startCapture(); });
function capture(interval: number, count: number) {
  fps.sampleFrame(100);
  for (let i = 1; i <= count; i++) fps.sampleFrame(100 + interval * i);
  return fps.stopCapture();
}
it("does not relabel missed 60 Hz opportunities as a healthy 30 Hz display", () => {
  const windows = capture(1000 / 30, 60);
  expect(windows.every(w => w.hz === 60)).toBe(true);
  expect(windows.reduce((sum,w) => sum + w.dropped, 0)).toBe(60);
  expect(fps.summarise(windows)?.pass).toBe(false);
});
it("accepts uninterrupted 60 Hz callbacks", () => {
  expect(fps.summarise(capture(1000 / 60, 120))?.pass).toBe(true);
});
it("retains foreground stalls longer than one second", () => {
  const windows = capture(1200, 1);
  expect(windows[0].worst_ms).toBe(1200);
  expect(windows[0].dropped).toBe(71);
  expect(fps.summarise(windows)?.pass).toBe(false);
});
it("retains a failure in the final partial window", () => {
  expect(fps.summarise(capture(50, 1))?.pass).toBe(false);
});
it("invalidates the entire capture when visibility changes", () => {
  fps.sampleFrame(100);
  fps.sampleFrame(117);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const summary = fps.summarise(fps.stopCapture());
  expect(summary?.interrupted).toBe(true);
  expect(summary?.pass).toBe(false);
});

it("rejects a healthy but truncated capture", () => {
  expect(fps.summarise(capture(1000 / 60, 60), 60000)?.pass).toBe(false);
});
it("retains a terminal stall when the stop timer precedes rAF", () => {
  fps.sampleFrame(100);
  vi.mocked(performance.now).mockReturnValue(1300);
  expect(fps.summarise(fps.stopCapture())?.pass).toBe(false);
});
