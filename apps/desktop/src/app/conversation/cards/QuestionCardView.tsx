import { Check, QuestionMarkCircle } from "@openai/apps-sdk-ui/components/Icon";
import { memo, useState } from "react";

import { useAction } from "@/app/conversation/useAction";
import {
  ApprovalCard,
  ApprovalCardCode,
} from "@/components/assistant-ui/elements/approval-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { answerQuestion } from "@/state/actions";
import { useBoard } from "@/state/board";

/**
 * A question only the user can answer: from the orchestrator (for a waiting worker, or its
 * own), or Brigadier asking whether workers should see uncommitted changes. Suggested
 * answers are buttons; any other answer can be typed.
 */
export const QuestionCardView = memo(function QuestionCardView({ cardId }: { cardId: string }) {
  const question = useBoard((s) => s.board?.questions[cardId]);
  const taskNumber = useBoard((s) =>
    question?.taskId ? s.board?.tasks[question.taskId]?.number : undefined,
  );
  const action = useAction();
  const [typed, setTyped] = useState("");
  if (!question) return null;

  const pending = question.answer === null;
  const uncommitted = question.kind.type === "uncommittedChanges" ? question.kind.files : null;
  const answer = (text: string) =>
    action.run(() => answerQuestion(question.conversationId, question.id, text));

  return (
    <ApprovalCard
      data-card="question"
      icon={<QuestionMarkCircle />}
      title={uncommitted ? "Should workers see your uncommitted changes?" : "A question for you"}
      subtitle={
        taskNumber === undefined ? "From the orchestrator" : `task-${taskNumber} waits for this`
      }
      pending={pending}
      resolution={
        <>
          <Check className="text-success size-icon-sm" />
          You answered: {question.answer}
        </>
      }
      actions={
        <div className="flex w-full flex-col gap-2">
          {question.options.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {question.options.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant="outline"
                  disabled={action.busy}
                  onClick={() => answer(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.trim()) answer(typed.trim());
            }}
          >
            <Input
              value={typed}
              placeholder="Type an answer"
              aria-label="Your answer"
              className="h-control-sm flex-1"
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={action.busy || !typed.trim()}>
              Answer
            </Button>
          </form>
          {action.error && (
            <p role="alert" className="text-destructive text-xs">
              {action.error}
            </p>
          )}
        </div>
      }
    >
      {question.text && <p className="text-sm whitespace-pre-wrap">{question.text}</p>}
      {uncommitted && uncommitted.length > 0 && (
        <ApprovalCardCode>{uncommitted.join("\n")}</ApprovalCardCode>
      )}
    </ApprovalCard>
  );
});
