// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import { File, Globe, ShieldCheck, Terminal } from "../../icons";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  getBlockedSurface,
  surfaceBlockedEventName,
  useSurfaceBlockState,
} from "./surfaceBlocked";
import type { ApprovalDecision } from "./types";

export type ApprovalRequestKind =
  | "generic"
  | "command"
  | "file"
  | "network"
  | "permission"
  | "mcp";

export interface ApprovalAction {
  info?: string;
  label?: ReactNode;
  onClick: () => void;
}

const defaultDecisionLabels: Record<ApprovalDecision, string> = {
  approved: "Approved",
  expired: "Expired",
  pending: "Awaiting approval",
  rejected: "Rejected",
};

const defaultIdentityLabels: Record<ApprovalRequestKind, string> = {
  command: "Terminal",
  file: "Edit files",
  generic: "Approval",
  mcp: "Tool request",
  network: "Internet access",
  permission: "Permissions",
};

function ApprovalIdentityIcon({ kind }: { kind: ApprovalRequestKind }) {
  if (kind === "file") {
    return <File aria-hidden="true" />;
  }

  if (kind === "network") {
    return <Globe aria-hidden="true" />;
  }

  if (kind === "command") {
    return <Terminal aria-hidden="true" />;
  }

  if (kind === "permission") {
    return <ShieldCheck aria-hidden="true" />;
  }

  // "generic" and "mcp": src/icons/ has no plain info-circle glyph — kept as the
  // kit's own inline mark rather than reaching for a mismatched icon.
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 6.25v4.5M10 13.75v.01" />
    </svg>
  );
}

export interface ApprovalRequestProps
  extends Omit<HTMLAttributes<HTMLElement>, "children" | "title"> {
  approvalOptionsIcon?: ReactNode;
  approvalOptionsLabel?: string;
  approveDisabled?: boolean;
  approveLabel?: ReactNode;
  approveShortcutLabel?: ReactNode;
  autoFocus?: boolean;
  children?: ReactNode;
  decision?: ApprovalDecision;
  decisionLabel?: ReactNode;
  description?: ReactNode;
  details?: ReactNode;
  disableHotkeys?: boolean;
  disabled?: boolean;
  /** Brigadier addition: label for the Dismiss action shown when `decision === "expired"`. */
  dismissLabel?: ReactNode;
  identity?: ReactNode;
  identityIcon?: ReactNode;
  kind?: ApprovalRequestKind;
  leadingAction?: ApprovalAction;
  loading?: boolean;
  onApprove?: () => void;
  /** Brigadier addition: clears an expired request. Rendered instead of Approve/Reject
   *  when `decision === "expired"`. `disabled: true` alone is not sufficient here — a
   *  disabled Approve/Deny pair is a card the operator cannot clear. */
  onDismiss?: () => void;
  onReject?: () => void;
  presentation?: "composer" | "default";
  reason?: ReactNode;
  rejectLabel?: ReactNode;
  rejectShortcutLabel?: ReactNode;
  showShortcutHints?: boolean;
  scopedApproveAction?: ApprovalAction;
  title: ReactNode;
}

export function ApprovalRequest({
  approvalOptionsIcon,
  approvalOptionsLabel = "Approval options",
  approveDisabled = false,
  approveLabel,
  approveShortcutLabel = "⏎",
  autoFocus = true,
  children,
  className,
  decision = "pending",
  decisionLabel = defaultDecisionLabels[decision],
  description,
  details,
  disableHotkeys = false,
  disabled = false,
  dismissLabel = "Dismiss",
  identity,
  identityIcon,
  kind = "generic",
  leadingAction,
  loading = false,
  onApprove,
  onDismiss,
  onReject,
  presentation = "default",
  reason,
  rejectLabel,
  rejectShortcutLabel = "Esc",
  showShortcutHints,
  scopedApproveAction,
  title,
  "aria-label": ariaLabel = "Approval request",
  ...props
}: ApprovalRequestProps) {
  const classes = ["thread-approval-request", className]
    .filter(Boolean)
    .join(" ");
  const rootRef = useRef<HTMLElement>(null);
  const optionsId = useId();
  const optionsMenuRef = useRef<HTMLDivElement>(null);
  const optionsRootRef = useRef<HTMLDivElement>(null);
  const optionsToggleRef = useRef<HTMLButtonElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsPosition, setOptionsPosition] = useState<CSSProperties>();
  const { blocked: surfaceBlocked, portalsBlocked } =
    useSurfaceBlockState();
  const optionsVisible = optionsOpen && !portalsBlocked;
  const isPending = decision === "pending";
  const isExpired = decision === "expired";
  const actionsDisabled = disabled || loading;
  const primaryDisabled = actionsDisabled || approveDisabled || !onApprove;
  const resolvedApproveLabel =
    approveLabel ?? (kind === "generic" ? "Approve" : "Allow once");
  const resolvedRejectLabel =
    rejectLabel ?? (kind === "generic" ? "Reject" : "Deny");
  const resolvedIdentity = identity ?? defaultIdentityLabels[kind];
  const automaticShortcutHints =
    presentation === "composer" && !disableHotkeys;
  const rejectShortcutVisible =
    showShortcutHints ??
    (automaticShortcutHints && !actionsDisabled && Boolean(onReject));
  const approveShortcutVisible =
    showShortcutHints ?? (automaticShortcutHints && !primaryDisabled);

  useEffect(() => {
    if (!isPending) setOptionsOpen(false);
  }, [isPending]);

  useEffect(() => {
    if (surfaceBlocked && optionsOpen) setOptionsOpen(false);
  }, [optionsOpen, surfaceBlocked]);

  useEffect(() => {
    if (!optionsVisible) return;

    const dismissOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !optionsRootRef.current?.contains(event.target) &&
        !optionsMenuRef.current?.contains(event.target)
      ) {
        setOptionsOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOptionsOpen(false);
      optionsToggleRef.current?.focus();
    };
    const dismissWhenOwnerBlocked = (event: Event) => {
      const blockedSurface = getBlockedSurface(event);
      if (
        blockedSurface &&
        rootRef.current &&
        blockedSurface.contains(rootRef.current)
      ) {
        setOptionsOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    document.addEventListener(
      surfaceBlockedEventName,
      dismissWhenOwnerBlocked,
    );
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener(
        surfaceBlockedEventName,
        dismissWhenOwnerBlocked,
      );
    };
  }, [optionsVisible]);

  useLayoutEffect(() => {
    if (!optionsVisible) return;

    const updatePosition = () => {
      const toggle = optionsToggleRef.current;
      if (!toggle) return;
      const rect = toggle.getBoundingClientRect();
      const menuWidth = optionsMenuRef.current?.offsetWidth || 196;
      const menuHeight = optionsMenuRef.current?.offsetHeight || 68;
      const borderOverlap = 1;
      const edge = 8;
      const left = Math.max(
        edge,
        Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - edge),
      );
      const top =
        rect.bottom - borderOverlap + menuHeight <= window.innerHeight - edge
          ? rect.bottom - borderOverlap
          : Math.max(edge, rect.top - menuHeight - 2);
      setOptionsPosition({ left: left - borderOverlap, top });
    };

    updatePosition();
    optionsMenuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [optionsVisible]);

  useEffect(() => {
    if (
      !isPending ||
      surfaceBlocked ||
      disableHotkeys ||
      actionsDisabled ||
      (!onApprove && !onReject)
    ) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const activeSurfaces = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-thread-approval-surface][data-decision="pending"]:not([data-hotkeys-disabled])',
        ),
      );
      if (activeSurfaces[activeSurfaces.length - 1] !== rootRef.current) return;

      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"]',
        )
      ) {
        return;
      }

      if (
        event.key === "Enter" &&
        onApprove &&
        !approveDisabled &&
        !target?.closest("button, a")
      ) {
        event.preventDefault();
        setOptionsOpen(false);
        onApprove();
      } else if (event.key === "Escape" && onReject) {
        event.preventDefault();
        setOptionsOpen(false);
        onReject();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    actionsDisabled,
    approveDisabled,
    disableHotkeys,
    isPending,
    onApprove,
    onReject,
    surfaceBlocked,
  ]);

  const optionsPortalTarget = optionsVisible
    ? (rootRef.current?.parentElement?.closest<HTMLElement>(
        "[data-theme]",
      ) ?? document.body)
    : null;
  const optionsPortalTheme = optionsVisible
    ? rootRef.current?.closest<HTMLElement>("[data-theme]")?.dataset.theme
    : undefined;
  const handleOptionsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOptionsOpen(false);
      optionsToggleRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOptionsOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    const items = Array.from(
      optionsMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  const approveOnce = () => {
    setOptionsOpen(false);
    if (!primaryDisabled) onApprove?.();
  };
  const optionsMenu =
    optionsVisible && isPending && scopedApproveAction && optionsPortalTarget
      ? createPortal(
          <div
            className="thread-approval-request__options-menu"
            data-theme={optionsPortalTheme}
            id={optionsId}
            onKeyDown={handleOptionsKeyDown}
            ref={optionsMenuRef}
            role="menu"
            style={optionsPosition}
          >
            <button
              disabled={primaryDisabled}
              onClick={approveOnce}
              role="menuitem"
              type="button"
            >
              {resolvedApproveLabel}
            </button>
            <button
              disabled={actionsDisabled}
              onClick={() => {
                setOptionsOpen(false);
                scopedApproveAction.onClick();
              }}
              role="menuitem"
              title={scopedApproveAction.info}
              type="button"
            >
              <span>
                {scopedApproveAction.label ?? "Allow this conversation"}
              </span>
              {scopedApproveAction.info ? (
                <span
                  aria-label={scopedApproveAction.info}
                  className="thread-approval-request__option-info"
                  role="img"
                >
                  i
                </span>
              ) : null}
            </button>
          </div>,
          optionsPortalTarget,
        )
      : null;

  return (
    <section
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      className={classes}
      data-thread-approval-surface
      data-decision={decision}
      data-hotkeys-disabled={
        disableHotkeys || surfaceBlocked || undefined
      }
      data-kind={kind}
      data-presentation={presentation}
      ref={rootRef}
      {...props}
    >
      <header className="thread-approval-request__header">
        <div className="thread-approval-request__identity">
          <span className="thread-approval-request__identity-icon">
            {identityIcon ?? <ApprovalIdentityIcon kind={kind} />}
          </span>
          <span>{resolvedIdentity}</span>
          {!isPending ? (
            <span
              aria-live="polite"
              className="thread-approval-request__decision"
            >
              {decisionLabel}
            </span>
          ) : null}
        </div>
        <div className="thread-approval-request__heading">
          <h3>{title}</h3>
          {description ? (
            <div className="thread-approval-request__description">
              {description}
            </div>
          ) : null}
        </div>
        {reason || details ? (
          <div className="thread-approval-request__context">
            {reason ? (
              <dl className="thread-approval-request__reason">
                <dt>Reason</dt>
                <dd>{reason}</dd>
              </dl>
            ) : null}
            {details ? (
              <div className="thread-approval-request__details">{details}</div>
            ) : null}
          </div>
        ) : null}
      </header>

      {children ? (
        <div className="thread-approval-request__body">{children}</div>
      ) : null}

      {isPending ? (
        <div
          aria-label="Approval actions"
          className="thread-approval-request__actions"
          role="group"
        >
          {leadingAction ? (
            <button
              className="thread-approval-request__button"
              data-action="leading"
              disabled={actionsDisabled}
              onClick={leadingAction.onClick}
              title={leadingAction.info}
              type="button"
            >
              {leadingAction.label ?? "Always allow"}
            </button>
          ) : null}

          <div className="thread-approval-request__action-cluster">
            <button
              className="thread-approval-request__button"
              data-action="reject"
              disabled={actionsDisabled || !onReject}
              onClick={onReject}
              type="button"
            >
              <span className="thread-approval-request__button-label">
                {resolvedRejectLabel}
              </span>
              {rejectShortcutVisible ? (
                <kbd
                  aria-hidden="true"
                  className="thread-approval-request__shortcut"
                >
                  {rejectShortcutLabel}
                </kbd>
              ) : null}
            </button>

            {scopedApproveAction ? (
              <div
                className="thread-approval-request__split"
                ref={optionsRootRef}
              >
                <button
                  autoFocus={autoFocus}
                  className="thread-approval-request__button thread-approval-request__button--primary"
                  data-action="approve"
                  disabled={primaryDisabled}
                  onClick={approveOnce}
                  type="button"
                >
                  {loading ? (
                    <span
                      aria-hidden="true"
                      className="thread-approval-request__spinner"
                    />
                  ) : null}
                  <span className="thread-approval-request__button-label">
                    {resolvedApproveLabel}
                  </span>
                  {approveShortcutVisible ? (
                    <kbd
                      aria-hidden="true"
                      className="thread-approval-request__shortcut"
                    >
                      {approveShortcutLabel}
                    </kbd>
                  ) : null}
                </button>
                <button
                  aria-controls={optionsVisible ? optionsId : undefined}
                  aria-expanded={optionsVisible}
                  aria-haspopup="menu"
                  aria-label={approvalOptionsLabel}
                  className="thread-approval-request__button thread-approval-request__button--primary thread-approval-request__options-toggle"
                  disabled={actionsDisabled}
                  onClick={() => setOptionsOpen((value) => !value)}
                  ref={optionsToggleRef}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="thread-approval-request__options-icon"
                  >
                    {approvalOptionsIcon}
                  </span>
                </button>
                {optionsMenu}
              </div>
            ) : (
              <button
                autoFocus={autoFocus}
                className="thread-approval-request__button thread-approval-request__button--primary"
                data-action="approve"
                disabled={primaryDisabled}
                onClick={approveOnce}
                type="button"
              >
                {loading ? (
                  <span
                    aria-hidden="true"
                    className="thread-approval-request__spinner"
                  />
                ) : null}
                <span className="thread-approval-request__button-label">
                  {resolvedApproveLabel}
                </span>
                {approveShortcutVisible ? (
                  <kbd
                    aria-hidden="true"
                    className="thread-approval-request__shortcut"
                  >
                    {approveShortcutLabel}
                  </kbd>
                ) : null}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {isExpired && onDismiss ? (
        <div
          aria-label="Approval actions"
          className="thread-approval-request__actions"
          role="group"
        >
          <button
            className="thread-approval-request__button"
            data-action="dismiss"
            onClick={onDismiss}
            type="button"
          >
            {dismissLabel}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export interface ApprovalCommandPreviewProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  collapseLabel?: ReactNode;
  collapsedLines?: number;
  command: ReactNode;
  defaultExpanded?: boolean;
  expandLabel?: ReactNode;
  forceCollapsible?: boolean;
}

export interface ApprovalFilePreviewProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  additions?: number;
  deletions?: number;
  directory?: ReactNode;
  fileName: ReactNode;
}

export function ApprovalFilePreview({
  additions = 0,
  className,
  deletions = 0,
  directory,
  fileName,
  "aria-label": ariaLabel = "File change preview",
  ...props
}: ApprovalFilePreviewProps) {
  return (
    <div
      aria-label={ariaLabel}
      className={["thread-approval-file-preview", className]
        .filter(Boolean)
        .join(" ")}
      role="group"
      {...props}
    >
      <span className="thread-approval-file-preview__path">
        {directory ? (
          <span className="thread-approval-file-preview__directory">
            {directory}
          </span>
        ) : null}
        <span className="thread-approval-file-preview__name">
          {fileName}
        </span>
      </span>
      <span
        aria-label={`${additions} additions, ${deletions} deletions`}
        className="thread-approval-file-preview__delta"
      >
        <span data-tone="added">+{additions}</span>
        <span data-tone="removed">-{deletions}</span>
      </span>
    </div>
  );
}

export function ApprovalCommandPreview({
  className,
  collapseLabel = "Collapse",
  collapsedLines = 3,
  command,
  defaultExpanded = false,
  expandLabel = "Expand",
  forceCollapsible,
  style,
  ...props
}: ApprovalCommandPreviewProps) {
  const contentRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [measuredCollapsible, setMeasuredCollapsible] = useState(() => {
    if (typeof command !== "string") return false;
    return command.split(/\r?\n/u).length > collapsedLines || command.length > 96;
  });
  const collapsible = forceCollapsible ?? measuredCollapsible;
  const visuallyExpanded = expanded || forceCollapsible === false;

  useLayoutEffect(() => {
    if (forceCollapsible !== undefined) return;
    const element = contentRef.current;
    if (!element) return;

    const measure = () => {
      const computed = getComputedStyle(element);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      if (!Number.isFinite(lineHeight)) return;
      const paddingBlock =
        Number.parseFloat(computed.paddingTop) +
        Number.parseFloat(computed.paddingBottom);
      setMeasuredCollapsible(
        element.scrollHeight > lineHeight * collapsedLines + paddingBlock + 1,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [collapsedLines, command, forceCollapsible]);

  return (
    <div
      aria-label="Command preview"
      className={["thread-approval-command", className]
        .filter(Boolean)
        .join(" ")}
      data-expanded={visuallyExpanded || undefined}
      role="region"
      style={
        {
          ...style,
          "--thread-approval-command-lines": collapsedLines,
        } as CSSProperties
      }
      {...props}
    >
      <div className="thread-approval-command__surface">
        <code ref={contentRef}>{command}</code>
        {collapsible ? (
          <div className="thread-approval-command__actions">
            <button onClick={() => setExpanded((value) => !value)} type="button">
              {expanded ? collapseLabel : expandLabel}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
