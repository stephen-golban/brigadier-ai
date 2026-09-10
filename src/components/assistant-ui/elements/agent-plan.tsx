// Adapted from assistant-ui Elements (MIT). Each phase carries its own actual state.
import { Spinner } from "../../controls/status";
import { Check, ExclamationMarkCircle } from "../../../icons";
import type { ReactNode } from "react";
export function AgentPlan({
  steps,
}: {
  steps: {
    id: string;
    state: "green" | "running" | "blocked" | "pending";
    content: ReactNode;
  }[];
}) {
  const completed = steps.filter((s) => s.state === "green").length;
  return (
    <div data-slot="agent-plan" className="flex w-full flex-col gap-3">
      <div className="flex justify-between text-xs text-text-secondary">
        <span>Plan</span>
        <span>
          {completed} of {steps.length} complete
        </span>
      </div>
      <progress
        aria-label="Completed phases"
        value={completed}
        aria-valuenow={completed}
        aria-valuemin={0}
        aria-valuemax={Math.max(1, steps.length)}
        max={Math.max(1, steps.length)}
        className="h-1 w-full accent-text-secondary"
      />
      <ol className="flex flex-col gap-3">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3">
            <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
              {step.state === "green" ? (
                <Check className="size-4 text-ok" />
              ) : step.state === "running" ? (
                <Spinner size="sm" />
              ) : step.state === "blocked" ? (
                <ExclamationMarkCircle className="size-4 text-warn" />
              ) : (
                <span className="size-1.5 rounded-full bg-elevated" />
              )}
            </span>
            <div className="min-w-0 flex-1">{step.content}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
