import { ApprovalCardView } from "@/app/conversation/cards/ApprovalCardView";
import { PlanCardView } from "@/app/conversation/cards/PlanCardView";
import { QuestionCardView } from "@/app/conversation/cards/QuestionCardView";
import { TaskCardView } from "@/app/conversation/cards/TaskCardView";

export type CardType = "task" | "approval" | "question" | "plan";

/** The card a thread item shows. Loaded with the first card, not at startup: worker cards
 * bring the transcript renderer and its virtualizer. */
export default function CardBody({ type, id }: { type: CardType; id: string }) {
  switch (type) {
    case "task":
      return <TaskCardView taskId={id} />;
    case "approval":
      return <ApprovalCardView cardId={id} />;
    case "question":
      return <QuestionCardView cardId={id} />;
    case "plan":
      return <PlanCardView cardId={id} />;
  }
}
