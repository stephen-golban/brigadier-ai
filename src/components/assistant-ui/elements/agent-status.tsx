// Adapted from assistant-ui Elements (MIT). No implied pause/retry actions.
import { Spinner } from "../../controls/status";
import { Check, ExclamationMarkCircle } from "../../../icons";
export function AgentStatus({
  state,
  label,
}: {
  state: "working" | "waiting" | "idle" | "done" | "failed";
  label: string;
}) {
  return (
    <span
      data-slot="agent-status"
      className="inline-flex items-center gap-2 text-xs text-text-secondary"
    >
      {state === "working" ? (
        <Spinner size="sm" />
      ) : state === "done" ? (
        <Check className="size-3 text-ok" />
      ) : state === "failed" ? (
        <ExclamationMarkCircle className="size-3 text-error" />
      ) : (
        <span
          className={`size-1.5 rounded-full ${state === "waiting" ? "bg-selected" : "bg-elevated"}`}
        />
      )}
      <span>{label}</span>
    </span>
  );
}
