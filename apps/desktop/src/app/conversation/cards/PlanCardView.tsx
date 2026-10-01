import { memo } from "react";
import { useShallow } from "zustand/react/shallow";

import { Lines } from "@/app/conversation/cards/common";
import { WorkerChip } from "@/app/conversation/WorkerChip";
import {
  AgentPlan,
  type AgentPlanStepStatus,
} from "@/components/assistant-ui/elements/agent-plan";
import { Badge } from "@/components/ui/badge";
import type { Gate, GateMember, Plan, PlanState, TaskState } from "@/ipc/generated";
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
    case "revising":
      return <Badge variant="warning">Being revised</Badge>;
  }
}

/** The reviewers of a round that are on the board, as chips. */
function Reviewers({ members }: { members: readonly GateMember[] }) {
  const onBoard = useBoard(
    useShallow((s) => members.map((member) => Boolean(s.board?.tasks[member.taskId]))),
  );
  const shown = members.filter((_, index) => onBoard[index]);
  if (shown.length === 0) return "the reviewer";
  return shown.map((member, index) => (
    <span key={member.taskId}>
      {index > 0 && " and "}
      <WorkerChip taskId={member.taskId} label="Review" />
    </span>
  ));
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The plan's independent review: how the revision answered the earlier round's findings, and
 * the current round with its findings or notes.
 */
function PlanReview({ plan }: { plan: Plan }) {
  // The round before, on the plan this one revises.
  const before = useBoard((s) =>
    plan.revises ? (s.board?.plans[plan.revises]?.gate ?? null) : null,
  );
  const declined = plan.responses.filter((response) => !response.accepted);
  return (
    <>
      {before && plan.responses.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
            Round {before.round} reviewed by <Reviewers members={before.members} />:{" "}
            {count(plan.responses.length, "finding")}, {plan.responses.length - declined.length}{" "}
            accepted, {declined.length} declined.
          </p>
          {declined.length > 0 && (
            <Lines
              items={declined.map(
                (response) => `${response.id} declined: ${response.finding} (why: ${response.note})`,
              )}
            />
          )}
        </div>
      )}
      {plan.gate && <ReviewRound gate={plan.gate} notes={plan.reviewNotes} />}
    </>
  );
}

function ReviewRound({ gate, notes }: { gate: Gate; notes: readonly string[] }) {
  const outcome = gate.outcome?.type ?? null;
  if (outcome === "superseded") return null;
  const reasons = gate.members.flatMap((member) =>
    member.result?.type === "noResult" || member.result?.type === "unverified"
      ? [member.result.reason]
      : [],
  );
  return (
    <div className="flex flex-col gap-1">
      <p
        className={cn(
          "text-muted-foreground flex flex-wrap items-center gap-1 text-xs",
          outcome === null && "shimmer",
        )}
      >
        Round {gate.round}:{" "}
        {outcome === null ? (
          <>
            in review by <Reviewers members={gate.members} />
          </>
        ) : outcome === "passed" ? (
          <>
            approved by <Reviewers members={gate.members} />
            {notes.length > 0 && `, with ${count(notes.length, "note")}`}
          </>
        ) : outcome === "failed" ? (
          <>
            <Reviewers members={gate.members} /> found {count(gate.findings.length, "problem")}
          </>
        ) : (
          "the review could not finish"
        )}
      </p>
      {outcome === "passed" && notes.length > 0 && <Lines items={notes} />}
      {outcome === "failed" && (
        <Lines items={gate.findings.map((finding) => `${finding.id}: ${finding.text}`)} />
      )}
      {(outcome === "noResult" || outcome === "unverified") && reasons.length > 0 && (
        <Lines items={reasons} />
      )}
    </div>
  );
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
          <PlanReview plan={plan} />
          {plan.state.type === "rejected" && plan.state.message && (
            <p className="text-muted-foreground text-xs">Rejected: {plan.state.message}</p>
          )}
          {proposed && decider === "user" && (
            <p className="text-muted-foreground shimmer text-xs">Waiting for your decision</p>
          )}
          {proposed && decider === "brigadier" && (
            <p className="text-muted-foreground text-xs">
              Brigadier decides this plan for you
              {plan.risky || plan.steps.length > 1 ? " after an independent review" : ""}.
            </p>
          )}
        </>
      }
    />
  );
});
