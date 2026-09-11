import type { TimestampRequest, TimestampResponse } from "./timestampLabels";

// Keep default locale and timezone semantics identical to the synchronous fallback.
// These constructors run only when the first actual history page requests labels.
self.onmessage = ({data}: MessageEvent<TimestampRequest>) => {
  const time = new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"});
  const date = new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric"});
  self.postMessage({id: data.id, entries: data.entries.map(entry => ({
    key: entry.key,
    labels: {time: time.format(entry.at), date: date.format(entry.at)},
  }))} satisfies TimestampResponse);
};
