import { revealPlan } from "@/app/conversation/summaryState";
import { Button } from "@/components/ui/button";
import { useBoard } from "@/state/board";

/** Thread history and the action rail point to one actionable card under the summary. */
export function PlanCardLink({ cardId }: { cardId: string }) {
  const plan = useBoard((s) => s.board?.plans[cardId]);
  const current = useBoard((s) => {
    if (!plan || !s.board) return null;
    // A superseded revision opens its latest successor, whose review retains the findings.
    let latest = plan;
    const seen = new Set<string>();
    while (!seen.has(latest.id)) {
      seen.add(latest.id);
      const next = Object.values(s.board.plans).find(
        (candidate) => candidate.revises === latest.id,
      );
      if (!next) break;
      latest = next;
    }
    return latest.id;
  });
  if (!plan || !current) return null;
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto min-w-0 justify-start px-0 text-start whitespace-normal wrap-anywhere"
      onClick={() => revealPlan(current)}
    >
      View plan: {plan.title}
    </Button>
  );
}
