// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import {
  useEffect,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";

export type TurnDurationStatus = "working" | "worked" | "stopped";

export interface TurnDurationProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  completedAtMs?: number;
  durationMs?: number;
  startedAtMs?: number;
  status: TurnDurationStatus;
  stoppedLabel?: (time: string) => ReactNode;
  workedLabel?: (time: string) => ReactNode;
  workingLabel?: (time: string | null) => ReactNode;
}

export function formatTurnDuration(durationMs: number) {
  const totalSeconds = Math.floor(Math.max(durationMs, 0) / 1_000);
  if (totalSeconds < 1) return "0s";
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const secondsPerHour = 3_600;
  const days = Math.floor(totalSeconds / (secondsPerHour * 24));
  const hours = Math.floor(totalSeconds / secondsPerHour) % 24;
  const minutes = Math.floor((totalSeconds % secondsPerHour) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0 || hours > 0) {
    return [
      days > 0 ? `${days}d` : null,
      hours > 0 ? `${hours}h` : null,
      minutes > 0 ? `${minutes}m` : null,
      seconds > 0 ? `${seconds}s` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function TurnDuration({
  className,
  completedAtMs,
  durationMs,
  startedAtMs,
  status,
  stoppedLabel = (time) => `You stopped after ${time}`,
  workedLabel = (time) => `Worked for ${time}`,
  workingLabel = (time) => (time === null ? "Working" : `Working for ${time}`),
  ...props
}: TurnDurationProps) {
  const [now, setNow] = useState(() => Date.now());
  const shouldTick =
    status === "working" &&
    durationMs === undefined &&
    completedAtMs === undefined &&
    startedAtMs !== undefined;

  useEffect(() => {
    if (!shouldTick) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [shouldTick]);

  const elapsedMs = Math.max(
    durationMs ??
      (startedAtMs === undefined
        ? 0
        : (completedAtMs ?? now) - startedAtMs),
    0,
  );
  const time = formatTurnDuration(elapsedMs);
  const label =
    status === "working"
      ? workingLabel(elapsedMs < 1_000 ? null : time)
      : status === "stopped"
        ? stoppedLabel(time)
        : workedLabel(time);
  const classes = ["thread-turn-duration", className]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      data-status={status}
      {...props}
    >
      {label}
    </span>
  );
}
