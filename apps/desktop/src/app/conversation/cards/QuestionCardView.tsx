import { Check, QuestionMarkCircle } from "@openai/apps-sdk-ui/components/Icon";
import { memo } from "react";

import { WaitingRow } from "@/app/conversation/cards/common";
import {
  ApprovalCard,
  ApprovalCardCode,
} from "@/components/assistant-ui/elements/approval-card";
import { useBoard } from "@/state/board";

/**
 * A question only the user can answer, in the thread: a waiting row while its card is in the
 * composer, then the question and the answer given (or why it was withdrawn).
 */
export const QuestionCardView = memo(function QuestionCardView({ cardId }: { cardId: string }) {
  const question = useBoard((s) => s.board?.questions[cardId]);
  const taskNumber = useBoard((s) =>
    question?.taskId ? s.board?.tasks[question.taskId]?.number : undefined,
  );
  if (!question) return null;

  // Closed without an answer when the user edited or redid the request that asked.
  const pending = question.answer === null && question.answeredAtMs === null;
  if (pending) return <WaitingRow icon={<QuestionMarkCircle />}>Waiting for your answer</WaitingRow>;
  const uncommitted = question.kind.type === "uncommittedChanges" ? question.kind.files : null;

  return (
    <ApprovalCard
      data-card="question"
      icon={<QuestionMarkCircle />}
      title={uncommitted ? "Should workers see your uncommitted changes?" : "A question for you"}
      subtitle={
        uncommitted
          ? "Brigadier asks once, before the first worker starts"
          : taskNumber === undefined
            ? "From the orchestrator"
            : `task-${taskNumber} waited for this`
      }
      pending={false}
      resolution={
        question.answer === null ? (
          "Withdrawn: you changed the request that asked"
        ) : (
          <>
            <Check className="text-success size-icon-sm" />
            You answered: {question.answer}
          </>
        )
      }
    >
      {question.text && <p className="text-sm whitespace-pre-wrap">{question.text}</p>}
      {uncommitted && uncommitted.length > 0 && (
        <ApprovalCardCode>{uncommitted.join("\n")}</ApprovalCardCode>
      )}
    </ApprovalCard>
  );
});
