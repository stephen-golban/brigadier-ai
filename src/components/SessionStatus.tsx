export function SessionStatus({
  attention,
  working,
}: {
  attention?: boolean;
  working?: boolean;
}) {
  if (attention)
    return (
      <span
        className="attention-dot inline-block size-2 shrink-0 rounded-full bg-attention"
        role="img"
        aria-label="Needs attention"
      />
    );
  return working ? (
    <span
      role="status"
      aria-label="Working"
      className="session-status-spinner inline-flex size-[11px] shrink-0 text-text-secondary"
    >
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6.5"
          stroke="currentColor"
          strokeWidth="2"
          opacity=".25"
        />
        <circle
          cx="8"
          cy="8"
          r="6.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="29 12"
        />
      </svg>
    </span>
  ) : null;
}
