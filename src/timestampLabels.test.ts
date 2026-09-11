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

it("settles history and falls back when the worker itself fails", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const api = await import("./timestampLabels");
  const at = new Date(2026, 8, 11, 11, 12).getTime();
  const expected = new Date(at).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
  const ready = api.prepareTimestampLabels([{at}]);
  const worker = FakeWorker.instances[0]!;
  worker.onerror!();
  await ready;
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(api.getTimestampLabels(new Date(at), navigator.language).time).toBe(expected);
  await api.prepareTimestampLabels([{at: at + 60000}]);
  expect(FakeWorker.instances).toHaveLength(1);
});

/*
 * `docs/research/lifecycle-bounds-audit-2026-09-11.md` §1.4. The timeout used to be the worker's
 * death sentence: one 1 s hiccup under load disabled label preparation for the rest of the window,
 * silently, and every row thereafter formatted its label on the rendering thread.
 */
it("releases one timed-out request and still posts the next one", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const api = await import("./timestampLabels");
  const slow = new Date(2026, 8, 11, 11, 12).getTime();
  const ready = api.prepareTimestampLabels([{at: slow}]);
  const worker = FakeWorker.instances[0]!;
  await vi.advanceTimersByTimeAsync(1000);
  await ready;
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(api.getTimestampPreparation().workerFailures).toBe(1);
  // That row took the synchronous fallback, as it must.
  expect(api.getTimestampLabels(new Date(slow), navigator.language).time)
    .toBe(new Date(slow).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"}));

  // The next request goes to the same worker, and is answered.
  const next = new Date(2026, 8, 11, 12, 30).getTime();
  const second = api.prepareTimestampLabels([{at: next}]);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  const request = worker.postMessage.mock.calls[1]![0];
  worker.onmessage!({data: {id: request.id, entries: [{key: request.entries[0].key, labels: {time: "prepared", date: "date"}}]}} as MessageEvent<TimestampResponse>);
  await second;
  expect(api.getTimestampLabels(new Date(next), navigator.language)).toEqual({time: "prepared", date: "date"});
});

it("gives the worker up after three consecutive timeouts", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const api = await import("./timestampLabels");
  const base = new Date(2026, 8, 11, 11, 12).getTime();
  for (let i = 0; i < 3; i++) {
    const ready = api.prepareTimestampLabels([{at: base + i * 60_000}]);
    await vi.advanceTimersByTimeAsync(1000);
    await ready;
  }
  const worker = FakeWorker.instances[0]!;
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  expect(worker.terminate).toHaveBeenCalledOnce();
  // Three timeouts, of which the third is also the give-up. One failure each, not four for
  // three: the give-up is the same event as the timeout that caused it.
  expect(api.getTimestampPreparation().workerFailures).toBe(3);

  // Stable failure state: no retry storm, no new worker.
  await api.prepareTimestampLabels([{at: base + 600_000}]);
  expect(worker.postMessage).toHaveBeenCalledTimes(3);
  expect(FakeWorker.instances).toHaveLength(1);
});

it("an answered request clears the consecutive-timeout count", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const api = await import("./timestampLabels");
  const base = new Date(2026, 8, 11, 11, 12).getTime();
  const answer = async (at: number) => {
    const ready = api.prepareTimestampLabels([{at}]);
    const worker = FakeWorker.instances[0]!;
    const calls = worker.postMessage.mock.calls;
    const request = calls[calls.length - 1]![0];
    worker.onmessage!({data: {id: request.id, entries: [{key: request.entries[0].key, labels: {time: "t", date: "d"}}]}} as MessageEvent<TimestampResponse>);
    await ready;
  };
  const timeOut = async (at: number) => {
    const ready = api.prepareTimestampLabels([{at}]);
    await vi.advanceTimersByTimeAsync(1000);
    await ready;
  };
  await timeOut(base);
  await timeOut(base + 60_000);
  await answer(base + 120_000);
  await timeOut(base + 180_000);
  await timeOut(base + 240_000);
  const worker = FakeWorker.instances[0]!;
  expect(worker.terminate).not.toHaveBeenCalled();
  await timeOut(base + 300_000);
  expect(worker.terminate).toHaveBeenCalledOnce();
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
