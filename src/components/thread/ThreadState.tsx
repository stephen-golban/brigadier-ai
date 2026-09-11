// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import {
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  TurnDuration,
  type TurnDurationProps,
} from "./TurnDuration";

export interface LoadingShimmerProps extends HTMLAttributes<HTMLSpanElement> {
  active?: boolean;
  children: ReactNode;
}

export function LoadingShimmer({
  active = true,
  children,
  className,
  ...props
}: LoadingShimmerProps) {
  const shimmerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (
      !active ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const shimmer = shimmerRef.current;
    if (!shimmer) return;
    let activeTimer: ReturnType<typeof setTimeout> | undefined;
    const stopCadence = () => {
      if (activeTimer !== undefined) {
        clearTimeout(activeTimer);
        activeTimer = undefined;
      }
    };
    const startCadence = () => {
      stopCadence();
      shimmer.classList.remove("thread-loading-shimmer--active");
      shimmer.classList.add("thread-loading-shimmer--active");
      activeTimer = setTimeout(() => {
        shimmer.classList.remove("thread-loading-shimmer--active");
        activeTimer = undefined;
      }, 1_000);
    };
    const initialTimer = setTimeout(startCadence, 600);
    const intervalTimer = setInterval(startCadence, 4_000);
    return () => {
      stopCadence();
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      shimmer.classList.remove("thread-loading-shimmer--active");
    };
  }, [active]);

  if (!active) {
    return (
      <span className={className} {...props}>
        {children}
      </span>
    );
  }

  return (
    <span
      ref={shimmerRef}
      className={["thread-loading-shimmer", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {children}
      <span aria-hidden="true" className="thread-loading-shimmer__sweep">
        <span className="thread-loading-shimmer__highlight">
          {children}
        </span>
      </span>
    </span>
  );
}

export type ThreadLoadingKind = "loading" | "reconnecting";

export interface ThreadLoadingStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  kind?: ThreadLoadingKind;
  label?: ReactNode;
}

export function ThreadLoadingState({
  className,
  kind = "loading",
  label,
  ...props
}: ThreadLoadingStateProps) {
  const resolvedLabel =
    label ?? (kind === "reconnecting" ? "Reconnecting to ChatGPT…" : "Loading chat…");
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={["thread-thread-loading", className]
        .filter(Boolean)
        .join(" ")}
      data-kind={kind}
      role="status"
      {...props}
    >
      <span aria-hidden="true" className="thread-thread-loading__spinner" />
      <span>{resolvedLabel}</span>
    </div>
  );
}

export type ThreadContextOptimizationMode = "automatic" | "manual" | "work";

export type ThreadContextOptimizationStatus = "running" | "completed";

export interface ThreadContextOptimizationProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  icon?: ReactNode;
  label?: ReactNode;
  mode?: ThreadContextOptimizationMode;
  status: ThreadContextOptimizationStatus;
}

const contextOptimizationLabels: Record<
  ThreadContextOptimizationMode,
  Record<ThreadContextOptimizationStatus, string>
> = {
  automatic: {
    completed: "Context automatically compacted",
    running: "Context automatically compacting",
  },
  manual: {
    completed: "Context compacted",
    running: "Compacting context",
  },
  work: {
    completed: "Optimized the conversation",
    running: "Optimizing the conversation",
  },
};

export function ThreadContextOptimization({
  className,
  icon,
  label,
  mode = "automatic",
  status,
  ...props
}: ThreadContextOptimizationProps) {
  const resolvedLabel = label ?? contextOptimizationLabels[mode][status];
  const running = status === "running";

  return (
    <div
      aria-busy={running || undefined}
      aria-live={running ? "polite" : undefined}
      className={["thread-thread-context-optimization", className]
        .filter(Boolean)
        .join(" ")}
      data-mode={mode}
      data-status={status}
      role={running ? "status" : undefined}
      {...props}
    >
      <span
        aria-hidden="true"
        className="thread-thread-context-optimization__icon"
      >
        {icon}
      </span>
      {running ? (
        <LoadingShimmer>{resolvedLabel}</LoadingShimmer>
      ) : (
        <span className="thread-thread-context-optimization__label">
          {resolvedLabel}
        </span>
      )}
    </div>
  );
}

export interface ThreadInterruptionSummaryProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  durationMs: number;
  label?: ReactNode;
  stoppedLabel?: TurnDurationProps["stoppedLabel"];
}

export function ThreadInterruptionSummary({
  className,
  durationMs,
  label,
  stoppedLabel,
  ...props
}: ThreadInterruptionSummaryProps) {
  return (
    <div
      aria-live="polite"
      className={["thread-thread-interruption-summary", className]
        .filter(Boolean)
        .join(" ")}
      data-status="stopped"
      role="status"
      {...props}
    >
      <span className="thread-thread-interruption-summary__label">
        {label ?? (
          <TurnDuration
            durationMs={durationMs}
            status="stopped"
            stoppedLabel={stoppedLabel}
          />
        )}
      </span>
      <span
        aria-hidden="true"
        className="thread-thread-interruption-summary__rule"
      />
    </div>
  );
}

export interface ThreadContextEventProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  icon?: ReactNode;
  label?: ReactNode;
  mode?: ThreadContextOptimizationMode;
  status: ThreadContextOptimizationStatus;
  workingLabel?: ReactNode;
}

export function ThreadContextEvent({
  className,
  icon,
  label,
  mode = "manual",
  status,
  workingLabel = "Working",
  ...props
}: ThreadContextEventProps) {
  const running = status === "running";
  return (
    <div
      className={["thread-thread-context-event", className]
        .filter(Boolean)
        .join(" ")}
      data-status={status}
      {...props}
    >
      {running ? (
        <>
          <span className="thread-thread-context-event__working">
            {workingLabel}
          </span>
          <span
            aria-hidden="true"
            className="thread-thread-context-event__rule"
          />
        </>
      ) : null}
      <ThreadContextOptimization
        icon={icon}
        label={label}
        mode={mode}
        status={status}
      />
    </div>
  );
}

export interface ThreadThinkingPlaceholderProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label?: ReactNode;
}

export function ThreadThinkingPlaceholder({
  className,
  label = "Thinking",
  ...props
}: ThreadThinkingPlaceholderProps) {
  return (
    <div
      aria-live="polite"
      className={["thread-thread-thinking", className]
        .filter(Boolean)
        .join(" ")}
      role="status"
      {...props}
    >
      <div className="thread-thread-thinking__activity">
        <LoadingShimmer>{label}</LoadingShimmer>
      </div>
    </div>
  );
}

export interface ThreadSkeletonProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label?: string;
  lines?: number;
}

export function ThreadSkeleton({
  className,
  label = "Loading thread",
  lines = 3,
  ...props
}: ThreadSkeletonProps) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={["thread-thread-skeleton", className]
        .filter(Boolean)
        .join(" ")}
      role="status"
      {...props}
    >
      {Array.from({ length: Math.max(1, lines) }, (_, index) => (
        <span
          aria-hidden="true"
          className="thread-thread-skeleton__line"
          key={index}
          style={{ width: `${Math.max(42, 100 - index * 18)}%` }}
        />
      ))}
    </div>
  );
}

export interface ThreadRenderErrorProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "title"> {
  children?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  title?: ReactNode;
}

export function ThreadRenderError({
  children,
  className,
  onRetry,
  retryLabel = "Try again",
  title = "This turn could not be displayed",
  ...props
}: ThreadRenderErrorProps) {
  return (
    <div
      className={["thread-thread-render-error", className]
        .filter(Boolean)
        .join(" ")}
      role="alert"
      {...props}
    >
      <div className="thread-thread-render-error__title">{title}</div>
      {children ? (
        <div className="thread-thread-render-error__message">{children}</div>
      ) : null}
      {onRetry ? (
        <button
          className="thread-thread-render-error__retry"
          onClick={onRetry}
          type="button"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
