import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {TimestampResponse} from "./timestampLabels";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<TimestampResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}
beforeEach(() => {vi.resetModules(); FakeWorker.instances = [];});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();});

it("prepares a complete page once, sharing overlapping requests without main-thread formatting", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const api = await import("./timestampLabels");
  const at = new Date(2026, 8, 11, 10, 12).getTime();
  const format = vi.spyOn(Date.prototype, "toLocaleTimeString");
  const first = api.prepareTimestampLabels([{at}, {at: at + 1000}]);
  const overlapping = api.prepareTimestampLabels([{at}]);
  const worker = FakeWorker.instances[0]!;
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  const request = worker.postMessage.mock.calls[0]![0];
  expect(request.entries).toHaveLength(1);
  worker.onmessage!({data: {id: request.id, entries: request.entries.map((entry: {key: string}) => ({key: entry.key, labels: {time: "prepared time", date: "prepared date"}}))}} as MessageEvent<TimestampResponse>);
  await Promise.all([first, overlapping]);
  expect(api.getTimestampLabels(new Date(at), navigator.language)).toEqual({time: "prepared time", date: "prepared date"});
  expect(format).not.toHaveBeenCalled();
});

it.each(["error", "timeout"])("settles history and falls back when worker setup fails through %s", async mode => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const api = await import("./timestampLabels");
  const at = new Date(2026, 8, 11, 11, 12).getTime();
  const expected = new Date(at).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
  const ready = api.prepareTimestampLabels([{at}]);
  const worker = FakeWorker.instances[0]!;
  if (mode === "error") worker.onerror!();
  else await vi.advanceTimersByTimeAsync(1000);
  await ready;
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(api.getTimestampLabels(new Date(at), navigator.language).time).toBe(expected);
  await api.prepareTimestampLabels([{at: at + 60000}]);
  expect(FakeWorker.instances).toHaveLength(1);
});

it("the worker keeps the existing default-locale date and time text", async () => {
  const scope = {postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null};
  vi.stubGlobal("self", scope);
  await import("./timestampLabels.worker");
  const dates = [new Date(2026, 8, 11, 0, 5), new Date(2026, 2, 29, 3, 30), new Date(1890, 0, 1, 12, 15)];
  scope.onmessage!({data: {id: 1, entries: dates.map((date, index) => ({key: String(index), at: date.getTime()}))}} as MessageEvent);
  expect(scope.postMessage).toHaveBeenCalledWith({id: 1, entries: dates.map((date, index) => ({key: String(index), labels: {
    time: date.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"}),
    date: date.toLocaleDateString(undefined, {month: "short", day: "numeric"}),
  }}))});
});
