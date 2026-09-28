import { ChevronRight } from "@openai/apps-sdk-ui/components/Icon";
import type { FC } from "react";
import { useShallow } from "zustand/react/shallow";

import { isFinal } from "@/app/conversation/blocks";
import { useAction } from "@/app/conversation/useAction";
import { Changes, WorkerSummaryRow, workerStat } from "@/app/conversation/WorkerSummary";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { stopTask } from "@/state/actions";
import { useBoard } from "@/state/board";
import { ComposerRailItem } from "@/components/assistant-ui/elements/composer-rail";

/**
 * The "N background agents" strip on the composer: while any worker of the session is still
 * at work, the workers of those requests, what each is doing and its +N −N (a row opens the
 * worker), with the total and Stop all.
 */
export const BackgroundWorkers: FC<{ conversationId: string }> = ({ conversationId }) => {
  const tasks = useBoard(
    useShallow((s) =>
      s.board?.conversationId === conversationId ? Object.values(s.board.tasks) : [],
    ),
  );
  const diffs = useBoard((s) => s.board?.diffs);
  const action = useAction();
  const alive = tasks.filter((task) => !isFinal(task));
  if (alive.length === 0) return null;
  const requests = new Set(alive.map((task) => task.requestId));
  const listed = tasks
    .filter((task) => requests.has(task.requestId))
    .toSorted((a, b) => a.number - b.number);
  const stats = listed.flatMap((task) => workerStat(task, diffs) ?? []);
  const insertions = stats.reduce((sum, stat) => sum + stat.insertions, 0);
  const deletions = stats.reduce((sum, stat) => sum + stat.deletions, 0);

  return (
    <ComposerRailItem label="Background workers">
      <Collapsible data-slot="background-workers" className="px-3 py-1.5 text-sm">
        <div className="flex min-h-control-sm items-center gap-2">
          <CollapsibleTrigger className="group text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-1 text-start">
            <ChevronRight
              aria-hidden
              className="size-icon-xs shrink-0 transition-[rotate] group-data-[state=open]:rotate-90"
            />
            <span className="truncate">
              {alive.length} background {alive.length === 1 ? "worker" : "workers"}
              <span className="text-muted-foreground/70"> (@ to tag workers)</span>
            </span>
          </CollapsibleTrigger>
          <Changes insertions={insertions} deletions={deletions} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={action.busy}
                onClick={() => action.run(() => Promise.all(alive.map((task) => stopTask(task.id))))}
                className="text-muted-foreground hover:text-foreground shrink-0 transition-colors disabled:opacity-50"
              >
                Stop all
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Stop all workers in this session</TooltipContent>
          </Tooltip>
        </div>
        {action.error && (
          <p role="alert" className="text-destructive text-xs">
            {action.error}
          </p>
        )}
        <CollapsibleContent className="flex flex-col">
          {listed.map((task) => (
            <WorkerSummaryRow key={task.id} taskId={task.id} className="px-1" />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </ComposerRailItem>
  );
};
