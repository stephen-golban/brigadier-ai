import { Branch, Tasks } from "@openai/apps-sdk-ui/components/Icon";
import { type ReactNode, useContext, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { AgentsPanelContext, WORKERS_LABEL, WorkerGlyphs } from "@/app/conversation/Agents";
import { isFinal, isWorking } from "@/app/conversation/blocks";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import type { Conversation, DiffStat, Plan, Task } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import { getSessionDiff, setPinnedSummary } from "@/state/actions";
import { useBoard } from "@/state/board";
import { useApp } from "@/state/store";

/** Glyphs shown on the Workers row. */
const GLYPHS = 4;

const NO_TASKS: Readonly<Record<string, Task>> = {};

/** The branch's +N −N against its base, read again whenever a worker lands. */
function useSessionDiff(conversationId: string, worktree: boolean): DiffStat | null {
  const landed = useBoard(
    (s) => Object.values(s.board?.tasks ?? {}).filter((task) => task.state === "landed").length,
  );
  const [stat, setStat] = useState<DiffStat | null>(null);
  useEffect(() => {
    if (!worktree) return;
    let current = true;
    getSessionDiff(conversationId)
      .then((next) => current && setStat(next))
      // The card shows the branch alone when git can't tell.
      .catch(() => current && setStat(null));
    return () => {
      current = false;
    };
    // Each landing changes the branch: read it again.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [conversationId, worktree, landed]);
  return worktree ? stat : null;
}

/** The plan being carried out, or waiting for the user, if any. */
function currentPlan(plans: readonly Plan[]): Plan | null {
  const open = plans.filter(
    (plan) => plan.state.type !== "superseded" && plan.state.type !== "rejected",
  );
  return open.toSorted((a, b) => b.position - a.position)[0] ?? null;
}

function planLine(plan: Plan, tasks: Readonly<Record<string, Task>>): string {
  const total = plan.steps.length;
  if (plan.state.type === "proposed") return `${total} steps · waiting for you`;
  if (plan.state.type === "inReview") return `${total} steps · in review`;
  const finished = plan.steps.filter((step) => {
    const task = step.taskId ? tasks[step.taskId] : undefined;
    return task !== undefined && isFinal(task);
  }).length;
  if (finished >= total) return `Done · ${total}/${total}`;
  const step = plan.steps[finished];
  return `Step ${finished + 1}/${total}${step ? ` · ${step.title}` : ""}`;
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="border-border flex flex-col gap-1 border-t pt-2">
    <h3 className="text-muted-foreground text-xs">{title}</h3>
    {children}
  </section>
);

/**
 * A session's summary, pinned at the top right of its thread as ChatGPT does: the project,
 * the branch (with what it changed, for a worktree session), the workers and the plan.
 */
export function PinnedSummary({ conversation }: { conversation: Conversation }) {
  const shown = useApp((s) => s.pinnedSummary);
  const project = useApp((s) =>
    conversation.projectId ? (s.projects[conversation.projectId]?.name ?? null) : null,
  );
  const { setPanel } = useContext(AgentsPanelContext);
  const workers = useBoard(
    useShallow((s) => {
      if (s.board?.conversationId !== conversation.id) return [];
      return Object.values(s.board.tasks).toSorted((a, b) => a.number - b.number);
    }),
  );
  const plan = useBoard((s) =>
    s.board?.conversationId === conversation.id ? currentPlan(Object.values(s.board.plans)) : null,
  );
  const tasks = useBoard((s) => s.board?.tasks ?? NO_TASKS);
  const setup = conversation.setup?.type === "session" ? conversation.setup : null;
  const worktree = setup?.environment.type === "newWorktree";
  const diff = useSessionDiff(conversation.id, worktree);
  if (!shown || !setup) return null;

  const active = workers.filter((task) => !isFinal(task));
  const working = active.filter(isWorking).length;
  const waiting = active.length - working;
  const done = workers.length - active.length;
  const glyphs = [...active, ...workers.filter(isFinal)]
    .slice(0, GLYPHS)
    .map((task) => task.id);

  return (
    <aside
      aria-label="Session summary"
      className="bg-card border-border rounded-surface animate-in fade-in absolute end-3 top-3 z-10 flex w-xs flex-col gap-2 border p-3 duration-200"
    >
      {project && <h2 className="text-muted-foreground truncate text-xs">{project}</h2>}
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Branch aria-hidden className="text-muted-foreground size-icon-md shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={setup.environment.branch}>
          {setup.environment.branch}
        </span>
        {diff && (diff.insertions > 0 || diff.deletions > 0) && (
          <span className="shrink-0 text-xs tabular-nums">
            <span className="text-success">+{diff.insertions}</span>{" "}
            <span className="text-destructive">−{diff.deletions}</span>
          </span>
        )}
      </div>
      {workers.length > 0 && (
        <Section title={WORKERS_LABEL}>
          <button
            type="button"
            onClick={() => setPanel(null)}
            className="hover:bg-foreground/5 rounded-control -mx-1 flex items-center gap-2 px-1 py-0.5 text-start text-sm transition-colors"
          >
            <WorkerGlyphs taskIds={glyphs} />
            <span className="min-w-0 truncate">
              {[
                working > 0 && `${working} working`,
                waiting > 0 && `${waiting} waiting`,
                done > 0 && `${done} done`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </button>
        </Section>
      )}
      {plan && (
        <Section title="Plan">
          <p className="truncate text-sm" title={plan.title}>
            {planLine(plan, tasks)}
          </p>
        </Section>
      )}
    </aside>
  );
}

/** The header button that shows or hides the pinned summary. */
export function PinnedSummaryToggle() {
  const shown = useApp((s) => s.pinnedSummary);
  return (
    <TooltipIconButton
      tooltip="Toggle pinned summary"
      size="icon-md"
      aria-pressed={shown}
      className={cn(shown && "bg-muted")}
      onClick={() => setPinnedSummary(!shown)}
    >
      <Tasks />
    </TooltipIconButton>
  );
}
