import { ChevronRight } from "@openai/apps-sdk-ui/components/Icon";
import { type FC, useContext } from "react";
import { useShallow } from "zustand/react/shallow";

import { AgentsPanelContext, WorkerGlyph } from "@/app/conversation/Agents";
import { isFinal } from "@/app/conversation/blocks";
import { useAction } from "@/app/conversation/useAction";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Task } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import { stopTask } from "@/state/actions";
import { useBoard } from "@/state/board";
import { ComposerRailItem } from "@/components/assistant-ui/elements/composer-rail";

/** What a worker is at, in ChatGPT's words ("is working", "is awaiting instruction"). */
function stateLine(task: Task): string {
  switch (task.state) {
    case "queued":
    case "starting":
    case "running":
    case "reviewing":
      return "is working";
    case "blocked":
    case "paused":
    case "awaitingApproval":
    case "readyToLand":
      return "is awaiting instruction";
    case "failed":
      return "failed";
    case "stopped":
      return "was stopped";
    case "reported":
    case "landed":
    case "done":
    case "rejected":
      return "is done";
  }
}

/** "+12 −3", once a worker has a change. */
const Changes: FC<{ insertions: number; deletions: number }> = ({ insertions, deletions }) =>
  insertions + deletions > 0 ? (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-success">+{insertions}</span>{" "}
      <span className="text-destructive">−{deletions}</span>
    </span>
  ) : null;

/**
 * ChatGPT's "N background agents" strip on the composer: while any worker of the session is
 * still at work, the workers of those requests, what each is doing and its +N −N (a row opens
 * the worker), with the total and Stop all.
 */
export const BackgroundWorkers: FC<{ conversationId: string }> = ({ conversationId }) => {
  const tasks = useBoard(
    useShallow((s) =>
      s.board?.conversationId === conversationId ? Object.values(s.board.tasks) : [],
    ),
  );
  const { setPanel } = useContext(AgentsPanelContext);
  const action = useAction();
  const alive = tasks.filter((task) => !isFinal(task));
  if (alive.length === 0) return null;
  const requests = new Set(alive.map((task) => task.requestId));
  const listed = tasks
    .filter((task) => requests.has(task.requestId))
    .toSorted((a, b) => a.number - b.number);
  const insertions = listed.reduce((sum, task) => sum + (task.candidate?.diffStat.insertions ?? 0), 0);
  const deletions = listed.reduce((sum, task) => sum + (task.candidate?.diffStat.deletions ?? 0), 0);

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
            <button
              key={task.id}
              type="button"
              data-slot="background-worker"
              data-state={task.state}
              onClick={() => setPanel(task.id)}
              className="hover:bg-foreground/5 rounded-control flex min-h-control-sm items-center gap-2 px-1 text-start"
            >
              <WorkerGlyph taskId={task.id} />
              <span className="min-w-0 flex-1 truncate">
                {task.title}{" "}
                <span className={cn(isFinal(task) ? "text-muted-foreground" : "text-foreground/70")}>
                  {stateLine(task)}
                </span>
              </span>
              {task.candidate && (
                <Changes
                  insertions={task.candidate.diffStat.insertions}
                  deletions={task.candidate.diffStat.deletions}
                />
              )}
            </button>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </ComposerRailItem>
  );
};
