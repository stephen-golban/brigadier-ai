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

/*
 * The history page is published before preparation resolves (P4a item 1), so a row can render the
 * synchronous fallback first and a prepared label can land on a key that is already on screen.
 * Only the keys whose text actually moved may be announced; announcing the rest would remount
 * timestamps for nothing on every cold mount.
 */
/** Exactly what `timestampLabels.worker.ts` computes: a real time *and* a real, non-empty date. */
const workerLabels = (date: Date) => ({
  time: date.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"}),
  date: date.toLocaleDateString(undefined, {month: "short", day: "numeric"}),
});

it.each([
  ["identical text", workerLabels, 0],
  ["different text", (_date: Date) => ({time: "13:45", date: "11 Sept"}), 1],
])("announces a late label only when it replaces %s", async (_name, prepared, announcements) => {
  vi.stubGlobal("Worker", FakeWorker);
  const api = await import("./timestampLabels");
  const announced: string[][] = [];
  const stop = api.subscribeTimestampLabels(keys => announced.push([...keys]));
  const at = new Date(2026, 8, 11, 13, 45).getTime();
  const ready = api.prepareTimestampLabels([{at}]);
  const worker = FakeWorker.instances[0]!;
  const request = worker.postMessage.mock.calls[0]![0];
  // The row renders while the worker is still busy: this is the fallback the page now publishes.
  const fallback = api.getTimestampLabels(new Date(at), navigator.language);
  expect(fallback.time).toBe(new Date(at).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"}));
  worker.onmessage!({data: {id: request.id, entries: [{key: request.entries[0].key, labels: prepared(new Date(at))}]}} as MessageEvent<TimestampResponse>);
  await ready;
  expect(announced).toHaveLength(announcements);
  if (announcements) expect(announced[0]).toEqual([request.entries[0].key]);
  stop();
});

/*
 * The cold-mount case, which is the ordinary one: the page publishes, every visible row takes the
 * synchronous fallback with its empty `date`, and the worker answers a moment later with the same
 * time and a filled-in date. `MessageTimestamp` formats that date itself when the cached one is
 * empty, so nothing on screen moves — announcing it would remount every timestamp for nothing.
 */
it("announces nothing when the worker only fills in the date the fallback left empty", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const api = await import("./timestampLabels");
  const announced: string[][] = [];
  const stop = api.subscribeTimestampLabels(keys => announced.push([...keys]));
  const at = new Date(2026, 8, 11, 16, 20).getTime();
  const ready = api.prepareTimestampLabels([{at}]);
  const worker = FakeWorker.instances[0]!;
  const request = worker.postMessage.mock.calls[0]![0];
  const fallback = api.getTimestampLabels(new Date(at), navigator.language);
  expect(fallback.date).toBe("");
  const prepared = workerLabels(new Date(at));
  expect(prepared.date).not.toBe("");
  worker.onmessage!({data: {id: request.id, entries: [{key: request.entries[0].key, labels: prepared}]}} as MessageEvent<TimestampResponse>);
  await ready;
  expect(announced).toEqual([]);
  // The fill-in is still cached; only the announcement is withheld.
  expect(api.getTimestampLabels(new Date(at), navigator.language)).toEqual(prepared);
  stop();
});

it("announces nothing when the worker times out and the fallback stands", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const api = await import("./timestampLabels");
  const announced: string[][] = [];
  api.subscribeTimestampLabels(keys => announced.push([...keys]));
  const at = new Date(2026, 8, 11, 14, 45).getTime();
  const ready = api.prepareTimestampLabels([{at}]);
  await vi.advanceTimersByTimeAsync(1000);
  await ready;
  expect(announced).toEqual([]);
  expect(api.getTimestampLabels(new Date(at), navigator.language).time)
    .toBe(new Date(at).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"}));
});
