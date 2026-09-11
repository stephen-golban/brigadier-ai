/** Labels needed by the history page are prepared off the rendering thread. */
export interface TimestampLabels { time: string; date: string }
export interface TimestampRequest { id: number; entries: {key: string; at: number}[] }
export interface TimestampResponse { id: number; entries: {key: string; labels: TimestampLabels}[] }

const labels = new Map<string, TimestampLabels>();
const pending = new Map<number, {keys: string[]; finish: () => void}>();
const inFlight = new Map<string, Promise<void>>();
let worker: Worker | null = null;
let unavailable = false;
let nextId = 0;
const preparation = {workerLabels: 0, synchronousLabels: 0, workerFailures: 0};
export function getTimestampPreparation() { return {...preparation}; }

export function timestampKey(date: Date, language = navigator.language) {
  return `${date.getFullYear()}:${date.getMonth()}:${date.getDate()}:${date.getHours()}:${date.getMinutes()}:${date.getTimezoneOffset()}:${language}`;
}

function remember(key: string, value: TimestampLabels) {
  if (labels.size >= 2048 && !labels.has(key)) labels.delete(labels.keys().next().value!);
  labels.set(key, value);
}

export function getTimestampLabels(date: Date, language: string): TimestampLabels {
  const key = timestampKey(date, language);
  const cached = labels.get(key);
  if (cached) return cached;
  preparation.synchronousLabels++;
  // Standalone views and platforms without workers preserve the original locale output.
  const value = {
    time: date.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"}),
    date: "", // Today's rows and action clocks need no historical date formatting.
  };
  remember(key, value);
  return value;
}

function finish(id: number) {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  request.keys.forEach(key => inFlight.delete(key));
  request.finish();
}

function failWorker() {
  if (!unavailable) preparation.workerFailures++;
  unavailable = true;
  worker?.terminate();
  worker = null;
  [...pending.keys()].forEach(finish);
}

export function prepareTimestampLabels(items: readonly {at: number}[]): Promise<void> {
  if (unavailable || typeof Worker === "undefined") return Promise.resolve();
  const entries = [...new Map(items.filter(item => item.at > 0).map(({at}) => {
    const key = timestampKey(new Date(at));
    return [key, {key, at}] as const;
  })).values()].filter(entry => !labels.has(entry.key));
  if (!entries.length) return Promise.resolve();
  const fresh = entries.filter(entry => !inFlight.has(entry.key));
  if (fresh.length) {
    try {
      if (!worker) {
        worker = new Worker(new URL("./timestampLabels.worker.ts", import.meta.url), {type: "module"});
        worker.onmessage = ({data}: MessageEvent<TimestampResponse>) => {
          if (!pending.has(data.id)) return;
          preparation.workerLabels += data.entries.length;
          data.entries.forEach(entry => remember(entry.key, entry.labels));
          finish(data.id);
        };
        worker.onerror = failWorker;
        worker.onmessageerror = failWorker;
      }
      const id = ++nextId;
      let resolve!: () => void;
      const completion = new Promise<void>(done => { resolve = done; });
      // A failed worker must never leave history waiting indefinitely.
      const timeout = setTimeout(failWorker, 1000);
      pending.set(id, {keys: fresh.map(entry => entry.key), finish: () => {clearTimeout(timeout); resolve();}});
      fresh.forEach(entry => inFlight.set(entry.key, completion));
      worker.postMessage({id, entries: fresh} satisfies TimestampRequest);
    } catch { failWorker(); }
  }
  return Promise.all(entries.map(entry => inFlight.get(entry.key))).then(() => {});
}
