const MB = 1024 * 1024;

export function formatMb(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return formatMb(bytes);
}

export function formatMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(1)} ms`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

export function formatClock(epochMs: number): string {
  return timeFormat.format(epochMs);
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDateTime(epochMs: number): string {
  return dateTimeFormat.format(epochMs);
}

const shortTimeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** A time of day as the thread shows it ("4:08 PM"). */
export function formatTime(epochMs: number): string {
  return shortTimeFormat.format(epochMs);
}
