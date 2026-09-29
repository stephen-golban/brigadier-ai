import { memo } from "react";
import { useShallow } from "zustand/react/shallow";

import { WorkerChip } from "@/app/conversation/WorkerChip";
import {
  AgentPlan,
  type AgentPlanStepStatus,
} from "@/components/assistant-ui/elements/agent-plan";
import { Badge } from "@/components/ui/badge";
import type { PlanState, TaskState } from "@/ipc/generated";
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

function PlanStateBadge({ state }: { state: PlanState }) {
  switch (state.type) {
    case "proposed":
      return <Badge variant="warning">Proposed</Badge>;
    case "inReview":
      return <Badge variant="secondary">In plan review</Badge>;
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
        return [task?.id ?? null, task?.state ?? null];
      }),
    ),
  );
  const reviewer = useBoard((s) =>
    plan?.state.type === "inReview" && s.board?.tasks[plan.state.taskId] ? plan.state.taskId : null,
  );
  // Who decides a proposed plan: the user under Ask for approval or in plan mode.
  const decider = useApp((s) => {
    const setup = plan ? s.conversations[plan.conversationId]?.setup : null;
    if (setup?.type !== "session") return null;
    return setup.permission === "askForApproval" || setup.planMode ? "user" : "brigadier";
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
          <PlanStateBadge state={plan.state} />
          {reviewer !== null && <WorkerChip taskId={reviewer} label="Review" className="shrink-0" />}
        </>
      }
      steps={plan.steps.map((step, index) => {
        const taskId = steps[index * 2] as string | null | undefined;
        const state = steps[index * 2 + 1] as TaskState | null | undefined;
        return {
          key: `${index}`,
          title: step.title,
          detail: step.detail,
          status: stepStatus(state ?? undefined),
          // The worker carrying it out; its state shows on hover and in the step's mark.
          aside: taskId ? <WorkerChip taskId={taskId} /> : undefined,
        };
      })}
      footer={
        <>
          {plan.state.type === "rejected" && plan.state.message && (
            <p className="text-muted-foreground text-xs">Rejected: {plan.state.message}</p>
          )}
          {proposed && decider === "user" && (
            <p className="text-muted-foreground shimmer text-xs">Waiting for your decision</p>
          )}
          {proposed && decider === "brigadier" && (
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
