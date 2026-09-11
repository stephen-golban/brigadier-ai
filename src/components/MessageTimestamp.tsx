import { useMemo } from "react";
import { getTimestampLabels } from "../timestampLabels";

/** Retain locale formatting without reconstructing it on every streaming update. */
export function MessageTimestamp({at}: {at: number}) {
  const date = new Date(at);
  const today = new Date().toDateString();
  const offset = date.getTimezoneOffset();
  const language = navigator.language;
  const label = useMemo(() =>
    `${date.toDateString() === today ? "Today" : getTimestampLabels(date, language).date || date.toLocaleDateString(undefined, {month: "short", day: "numeric"})} ${getTimestampLabels(date, language).time}`,
    [at, today, offset, language]);
  return <div className="message-separator mb-2 text-xs text-text-tertiary">{label}</div>;
}

/** The action-row clock follows the same locale and timezone invalidation as the separator. */
export function MessageTime({at}: {at: number}) {
  const date = new Date(at);
  const offset = date.getTimezoneOffset();
  const language = navigator.language;
  const label = useMemo(() => getTimestampLabels(date, language).time, [at, offset, language]);
  return <time dateTime={date.toISOString()}>{label}</time>;
}
