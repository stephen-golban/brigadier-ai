// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import { Copy, Terminal } from "../../icons";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { AgentItemStatus } from "./types";
import { AgentActivity, type AgentActivityProps } from "./AgentActivity";

export type CommandExecutionStatus =
  | AgentItemStatus
  | "interrupted"
  | "background-running"
  | "background-finished";

export function formatCommandDuration(durationMs: number) {
  const totalSeconds = Math.floor(Math.max(durationMs, 0) / 1_000);
  if (totalSeconds < 1) return null;
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const secondsPerHour = 3_600;
  const days = Math.floor(totalSeconds / (secondsPerHour * 24));
  const hours = Math.floor(totalSeconds / secondsPerHour) % 24;
  const minutes = Math.floor((totalSeconds % secondsPerHour) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0 || hours > 0) {
    return [
      days > 0 ? `${days}d` : null,
      `${hours}h`,
      `${minutes}m`,
      `${seconds}s`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return `${minutes}m ${seconds}s`;
}

function toAgentStatus(status: CommandExecutionStatus): AgentItemStatus {
  if (status === "interrupted") return "failed";
  if (status === "background-running") return "running";
  if (status === "background-finished") return "completed";
  return status;
}

function isRunning(status: CommandExecutionStatus) {
  return status === "running" || status === "background-running";
}

function copyWithClipboard(text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

function TerminalIcon({ children }: { children?: ReactNode }) {
  if (children !== undefined && children !== null) {
    return (
      <span aria-hidden="true" className="thread-command-execution__icon">
        {children}
      </span>
    );
  }
  return (
    <Terminal aria-hidden="true" className="thread-command-execution__icon thread-command-execution__icon--fallback" />
  );
}

export interface CommandExecutionProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children?: ReactNode;
  command: ReactNode;
  commandLabel?: string;
  compactDetail?: ReactNode;
  completedAtMs?: number;
  copyCommandLabel?: string;
  copyCommandText?: string;
  cwd?: string;
  defaultOpen?: boolean;
  detail?: ReactNode;
  /** Brigadier addition: forwarded to `AgentActivity`. The kit hard-codes the `details`
   *  disclosure; brigadier needs the real `<button aria-expanded>` (landmine 17). */
  disclosureIndicator?: AgentActivityProps["disclosureIndicator"];
  /** Brigadier addition: forwarded to `AgentActivity`. */
  disclosureMode?: AgentActivityProps["disclosureMode"];
  durationMs?: number;
  exitCode?: number;
  footer?: ReactNode;
  hideRawCommand?: boolean;
  indicator?: ReactNode;
  terminalIcon?: ReactNode;
  noOutputLabel?: ReactNode;
  onCopyCommand?: (command: string) => void | Promise<void>;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  shellLabel?: ReactNode;
  startedAtMs?: number;
  status: CommandExecutionStatus;
  summary?: ReactNode;
}

export function CommandExecution({
  children,
  className,
  command,
  commandLabel,
  compactDetail,
  completedAtMs,
  copyCommandLabel = "Copy command",
  copyCommandText,
  cwd,
  defaultOpen = false,
  detail,
  disclosureIndicator,
  disclosureMode,
  durationMs,
  exitCode,
  footer,
  hideRawCommand = false,
  indicator,
  noOutputLabel = "No output",
  onCopyCommand,
  onOpenChange,
  open,
  shellLabel = "Shell",
  startedAtMs,
  status,
  summary,
  terminalIcon,
  ...props
}: CommandExecutionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [commandExpanded, setCommandExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const resolvedOpen = open ?? internalOpen;
  const running = isRunning(status);
  const shouldTick =
    status === "running" &&
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
  const elapsedLabel =
    status === "background-running" || status === "background-finished"
      ? null
      : formatCommandDuration(elapsedMs);
  const timer = elapsedLabel ? (
    <span className="thread-command-execution__duration">
      {` for ${elapsedLabel}`}
    </span>
  ) : null;
  const summaryCommand = (
    <span className="thread-command-execution__summary-command">
      {command}
    </span>
  );
  const defaultSummary = (() => {
    if (status === "pending") return "Pending command";
    if (status === "background-running") {
      return <>Started background terminal with {summaryCommand}</>;
    }
    if (status === "background-finished") {
      return <>Ran {summaryCommand}</>;
    }
    if (status === "running") return <>Running command{timer}</>;
    if (status === "interrupted") {
      return resolvedOpen ? (
        <>Stopped command{timer}</>
      ) : (
        <>Stopped {summaryCommand}{timer}</>
      );
    }
    if (status === "failed") {
      // The sampled Renderer intentionally keeps the collapsed verb as "Ran";
      // the expanded footer is the authoritative exit/failure signal.
      return <>Ran {summaryCommand}{timer}</>;
    }
    return <>Ran {summaryCommand}{timer}</>;
  })();
  const resolvedSummary = summary !== undefined && summary !== null ? (
    <>{summary}{timer}</>
  ) : (
    defaultSummary
  );
  const classes = ["thread-command-execution", className]
    .filter(Boolean)
    .join(" ");
  const rawCommandText =
    copyCommandText ?? (typeof command === "string" ? command : undefined);
  const resolvedCommandLabel =
    commandLabel ??
    (typeof command === "string" ? `$ ${command}` : "Expand command");
  const cwdTitle = cwd === undefined ? undefined : `cwd\n${cwd}`;

  const handleOpenChange = (nextOpen: boolean) => {
    if (open === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const handleCommandKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setCommandExpanded(true);
  };
  const handleCopyCommand = () => {
    if (rawCommandText === undefined) return;
    if (onCopyCommand) {
      void onCopyCommand(rawCommandText);
      return;
    }
    copyWithClipboard(rawCommandText);
  };

  const defaultFooter = (
    <div
      aria-hidden={running || undefined}
      className="thread-command-execution__footer"
      data-status={status}
    >
      {running
        ? null
        : status === "pending"
          ? "Pending"
          : status === "interrupted"
            ? "Stopped"
            : exitCode === 0
              ? <span data-success>Success</span>
              : `Exit code ${exitCode ?? "unknown"}`}
    </div>
  );
  const body = hideRawCommand ? (
    compactDetail === undefined || compactDetail === null ? undefined : (
      <div className="thread-command-execution__compact-detail">
        <TerminalIcon>{terminalIcon}</TerminalIcon>
        <span>{compactDetail}</span>
      </div>
    )
  ) : (
    <div
      className="thread-command-execution__shell"
      data-command-expanded={commandExpanded || undefined}
      title={cwdTitle}
    >
      {shellLabel !== undefined && shellLabel !== null ? (
        <div className="thread-command-execution__shell-label">
          {shellLabel}
        </div>
      ) : null}
      <div className="thread-command-execution__command-row">
        <div
          aria-label={resolvedCommandLabel}
          aria-expanded={commandExpanded}
          className="thread-command-execution__command-line"
          onClick={() => setCommandExpanded(true)}
          onKeyDown={handleCommandKeyDown}
          role="button"
          tabIndex={0}
        >
          <span aria-hidden="true">$</span>
          <code>{command}</code>
        </div>
        {rawCommandText !== undefined ? (
          <button
            aria-label={copyCommandLabel}
            className="thread-command-execution__copy-command"
            onClick={handleCopyCommand}
            title={copyCommandLabel}
            type="button"
          >
            <Copy />
          </button>
        ) : null}
      </div>
      {children ?? <CommandOutput emptyLabel={noOutputLabel} />}
      {footer ?? defaultFooter}
    </div>
  );

  return (
    <AgentActivity
      className={classes}
      data-execution-status={status}
      detail={detail}
      disclosureIndicator={disclosureIndicator}
      disclosureMode={disclosureMode}
      indicator={indicator ?? <TerminalIcon>{terminalIcon}</TerminalIcon>}
      kind="command"
      onOpenChange={handleOpenChange}
      open={resolvedOpen}
      status={toAgentStatus(status)}
      summary={resolvedSummary}
      {...props}
    >
      {body}
    </AgentActivity>
  );
}

export type CommandOutputStream = "stdout" | "stderr";

export interface CommandOutputProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onCopy"> {
  children?: ReactNode;
  copyLabel?: string;
  copyText?: string;
  emptyLabel?: ReactNode;
  onCopy?: (output: string) => void | Promise<void>;
  stream?: CommandOutputStream;
}

export function CommandOutput({
  children,
  className,
  copyLabel = "Copy output",
  copyText,
  emptyLabel = "No output",
  onCopy,
  stream = "stdout",
  "aria-label": ariaLabel = stream === "stderr"
    ? "Standard error"
    : "Standard output",
  ...props
}: CommandOutputProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [fade, setFade] = useState({ bottom: false, top: false });
  const hasOutput =
    typeof children === "string"
      ? /\S/.test(children)
      : children !== undefined && children !== null;
  const rawOutputText =
    copyText ?? (typeof children === "string" ? children : undefined);
  const classes = ["thread-command-output", className]
    .filter(Boolean)
    .join(" ");

  const updateFade = () => {
    const element = preRef.current;
    if (!element) return;
    const maximum = element.scrollHeight - element.clientHeight;
    const reverse =
      getComputedStyle(element).flexDirection === "column-reverse";
    const position = reverse ? -element.scrollTop : element.scrollTop;
    const next = {
      bottom:
        maximum > 1 &&
        (reverse ? position > 1 : position < maximum - 1),
      top:
        maximum > 1 &&
        (reverse ? position < maximum - 1 : position > 1),
    };
    setFade((current) =>
      current.bottom === next.bottom && current.top === next.top
        ? current
        : next,
    );
  };

  useLayoutEffect(() => {
    const element = preRef.current;
    if (!element) return;
    element.scrollTop =
      getComputedStyle(element).flexDirection === "column-reverse"
        ? 0
        : element.scrollHeight;
    updateFade();
  }, [children]);

  const handleCopy = () => {
    if (rawOutputText === undefined) return;
    if (onCopy) {
      void onCopy(rawOutputText);
      return;
    }
    copyWithClipboard(rawOutputText);
  };

  return (
    <div
      className={classes}
      data-empty={!hasOutput || undefined}
      data-fade-bottom={fade.bottom || undefined}
      data-fade-top={fade.top || undefined}
      data-stream={stream}
      {...props}
    >
      <pre
        aria-label={ariaLabel}
        onScroll={updateFade}
        ref={preRef}
        role="region"
        tabIndex={0}
      >
        <code>{hasOutput ? children : emptyLabel}</code>
      </pre>
      {hasOutput && rawOutputText !== undefined ? (
        <button
          aria-label={copyLabel}
          className="thread-command-output__copy"
          onClick={handleCopy}
          title={copyLabel}
          type="button"
        >
          <Copy />
        </button>
      ) : null}
    </div>
  );
}
