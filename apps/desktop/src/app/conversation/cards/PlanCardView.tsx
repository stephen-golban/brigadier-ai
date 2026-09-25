import { memo } from "react";
import { useShallow } from "zustand/react/shallow";

import { TASK_STATE_LABELS } from "@/app/conversation/cards/TaskCardView";
import {
  AgentPlan,
  type AgentPlanStepStatus,
} from "@/components/assistant-ui/elements/agent-plan";
import { mono } from "@/components/assistant-ui/elements/surfaces";
import { Badge } from "@/components/ui/badge";
import type { PlanState, TaskState } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import { useBoard } from "@/state/board";
import { useApp } from "@/state/store";

function stepStatus(state: TaskState | undefined): AgentPlanStepStatus {
  switch (state) {
    case undefined:
    case "queued":
      return "pending";
    case "landed":
    case "done":
      return "done";
    case "failed":
    case "rejected":
    case "stopped":
      return "failed";
    default:
      return "active";
  }
}

function PlanStateBadge({ state, reviewNumber }: { state: PlanState; reviewNumber?: number }) {
  switch (state.type) {
    case "proposed":
      return <Badge variant="warning">Proposed</Badge>;
    case "inReview":
      return (
        <Badge variant="secondary">
          In plan review{reviewNumber === undefined ? "" : ` · task-${reviewNumber}`}
        </Badge>
      );
    case "approved":
      return state.by === "user" ? (
        <Badge variant="success">Approved by you</Badge>
      ) : state.by === "brigadier" ? (
        <Badge variant="success" data-auto-approved>
          Auto-approved by Brigadier
        </Badge>
      ) : (
        <Badge variant="success">Approved after plan review</Badge>
      );
    case "rejected":
      return <Badge variant="destructive">Rejected</Badge>;
    case "superseded":
      return <Badge variant="outline">Superseded</Badge>;
  }
}

/** The orchestrator's plan: its steps with the tasks carrying them out, and its approval. */
export const PlanCardView = memo(function PlanCardView({ cardId }: { cardId: string }) {
  const plan = useBoard((s) => s.board?.plans[cardId]);
  // Only what the steps show of their tasks, so unrelated task updates don't rerender the plan.
  const steps = useBoard(
    useShallow((s) =>
      (plan?.steps ?? []).flatMap((step) => {
        const task = step.taskId ? s.board?.tasks[step.taskId] : undefined;
        return [task?.number ?? null, task?.state ?? null];
      }),
    ),
  );
  const reviewNumber = useBoard((s) =>
    plan?.state.type === "inReview" ? s.board?.tasks[plan.state.taskId]?.number : undefined,
  );
  const permission = useApp((s) => {
    const setup = plan ? s.conversations[plan.conversationId]?.setup : null;
    return setup?.type === "session" ? setup.permission : null;
  });
  if (!plan) return null;

  const proposed = plan.state.type === "proposed";

  return (
    <AgentPlan
      data-card="plan"
      title={plan.title}
      badges={
        <>
          {plan.risky && <Badge variant="warning">Risky</Badge>}
          <PlanStateBadge state={plan.state} {...(reviewNumber === undefined ? {} : { reviewNumber })} />
        </>
      }
      steps={plan.steps.map((step, index) => {
        const number = steps[index * 2] as number | null | undefined;
        const state = steps[index * 2 + 1] as TaskState | null | undefined;
        return {
          key: `${index}`,
          title: step.title,
          detail: step.detail,
          status: stepStatus(state ?? undefined),
          aside:
            number != null ? (
              <span className={cn(mono, "text-muted-foreground shrink-0")}>
                task-{number}
                {state ? ` · ${TASK_STATE_LABELS[state]}` : ""}
              </span>
            ) : undefined,
        };
      })}
      footer={
        <>
          {plan.state.type === "rejected" && plan.state.message && (
            <p className="text-muted-foreground text-xs">Rejected: {plan.state.message}</p>
          )}
          {proposed && permission === "askForApproval" && (
            <p className="text-muted-foreground shimmer text-xs">Waiting for your decision</p>
          )}
          {proposed && permission !== null && permission !== "askForApproval" && (
            <p className="text-muted-foreground text-xs">
              Brigadier decides this plan for you
              {plan.risky ? " after a cross-vendor plan review" : ""}.
            </p>
          )}
        </>
      }
    />
  );
});
