import { useAui } from "@assistant-ui/react";
import { ArrowLeft, X } from "@openai/apps-sdk-ui/components/Icon";
import { createContext, type FC, memo, useContext, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { isWorking } from "@/app/conversation/blocks";
import { TASK_STATE_LABELS, TaskCardView, taskCardState } from "@/app/conversation/cards/TaskCardView";
import { mono } from "@/components/assistant-ui/elements/surfaces";
import { TaskStateIcon } from "@/components/assistant-ui/elements/task-card";
import { Button } from "@/components/ui/button";
import type { Task } from "@/ipc/generated";
import { formatDuration } from "@/lib/format";
import { modelName, useModelGroups } from "@/lib/setup";
import { cn } from "@/lib/utils";
import { useBoard } from "@/state/board";

/**
 * The session's workers ("agents"): compact chips inside each request's block, and a side
 * panel listing them all, where one opens to show its live transcript, commands and diff.
 */

/** Which worker the agents panel shows: `null` for the list, `undefined` when it is closed. */
export type AgentsPanelState = string | null | undefined;

export const AgentsPanelContext = createContext<{
  panel: AgentsPanelState;
  setPanel: (panel: AgentsPanelState) => void;
}>({ panel: undefined, setPanel: () => {} });

/** One worker as a chip: its state and short title. Opens it in the agents panel. */
const AgentChip = memo(function AgentChip({ taskId }: { taskId: string }) {
  const task = useBoard((s) => s.board?.tasks[taskId]);
  const { setPanel } = useContext(AgentsPanelContext);
  if (!task) return null;
  return (
    <button
      type="button"
      data-slot="agent-chip"
      data-state={task.state}
      title={`task-${task.number} · ${TASK_STATE_LABELS[task.state]}`}
      onClick={() => setPanel(task.id)}
      className="border-border hover:bg-foreground/5 rounded-capsule animate-in fade-in zoom-in-95 flex h-control-sm max-w-xs items-center gap-1.5 border px-button-sm text-xs transition-colors duration-150"
    >
      <TaskStateIcon state={taskCardState(task.state)} />
      <span className="min-w-0 truncate">{task.title}</span>
    </button>
  );
});

/** The workers a request started, fanned out as chips, with how many still work. */
export const AgentChips: FC<{ taskIds: readonly string[] }> = ({ taskIds }) => {
  const { setPanel } = useContext(AgentsPanelContext);
  const [working, waiting, done] = useBoard(
    useShallow((s) => {
      let [busy, idle, over] = [0, 0, 0];
      for (const id of taskIds) {
        const task = s.board?.tasks[id];
        if (!task) continue;
        if (isFinal(task)) over += 1;
        else if (isWorking(task)) busy += 1;
        else idle += 1;
      }
      return [busy, idle, over] as const;
    }),
  );
  return (
    <div data-slot="agent-chips" className="flex flex-wrap items-center gap-1.5">
      {taskIds.map((id) => (
        <AgentChip key={id} taskId={id} />
      ))}
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onClick={() => setPanel(null)}
      >
        {[
          working > 0 && `${working} working`,
          waiting > 0 && `${waiting} waiting`,
          done > 0 && `${done} done`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Button>
    </div>
  );
};

const FINAL: ReadonlySet<Task["state"]> = new Set(["landed", "done", "rejected", "stopped", "failed"]);

function isFinal(task: Task): boolean {
  return FINAL.has(task.state);
}

/** Milliseconds a task has worked: until now while it runs, until its last update after. */
function useTaskElapsed(task: Task): number {
  const final = isFinal(task);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (final) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [final]);
  return Math.max(0, (final ? task.updatedAtMs : now) - task.createdAtMs);
}

const AgentRow = memo(function AgentRow({ taskId }: { taskId: string }) {
  const task = useBoard((s) => s.board?.tasks[taskId]);
  const activity = useBoard((s) => s.board?.activity[taskId]);
  const { setPanel } = useContext(AgentsPanelContext);
  const groups = useModelGroups();
  if (!task) return null;
  return <AgentRowView task={task} activity={activity} model={modelName(groups, task.route.choice)} onOpen={() => setPanel(task.id)} />;
});

function AgentRowView({
  task,
  activity,
  model,
  onOpen,
}: {
  task: Task;
  activity: string | undefined;
  model: string;
  onOpen: () => void;
}) {
  const elapsed = useTaskElapsed(task);
  const working = task.state === "running" || task.state === "starting";
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="hover:bg-foreground/5 rounded-control flex w-full flex-col gap-0.5 px-2 py-1.5 text-start transition-colors"
      >
        <span className="flex w-full items-center gap-2">
          <TaskStateIcon state={taskCardState(task.state)} />
          <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
          <span className={cn(mono, "text-muted-foreground shrink-0 tabular-nums")}>
            {formatDuration(elapsed)}
          </span>
        </span>
        <span className={cn(mono, "text-muted-foreground ms-6 truncate")}>
          {working && activity ? activity : `task-${task.number} · ${TASK_STATE_LABELS[task.state]} · ${model}`}
        </span>
      </button>
    </li>
  );
}

function AgentSection({ title, ids }: { title: string; ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return (
    <section className="flex flex-col gap-0.5 pb-2">
      <h3 className="text-muted-foreground px-2 py-1 text-xs font-medium">
        {title} · {ids.length}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {ids.map((id) => (
          <AgentRow key={id} taskId={id} />
        ))}
      </ul>
    </section>
  );
}

/** Mentions a worker in the composer, so the next message goes to the orchestrator about it. */
function MentionButton({ number }: { number: number }) {
  const aui = useAui();
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => {
        const composer = aui.composer();
        const text = composer.getState().text;
        const mention = `@task-${number} `;
        composer.setText(text && !text.endsWith(" ") ? `${text} ${mention}` : `${text}${mention}`);
      }}
    >
      Mention
    </Button>
  );
}

/** The side panel: every worker of the session, or one of them working. */
export function AgentsPanel({ conversationId }: { conversationId: string }) {
  const { panel, setPanel } = useContext(AgentsPanelContext);
  // Active workers first, then the finished ones, each by number; `|` separates the two.
  const ids = useBoard(
    useShallow((s) => {
      if (s.board?.conversationId !== conversationId) return [];
      const tasks = Object.values(s.board.tasks).toSorted((a, b) => a.number - b.number);
      return [
        ...tasks.filter((task) => !isFinal(task)).map((task) => task.id),
        "|",
        ...tasks.filter(isFinal).map((task) => task.id),
      ];
    }),
  );
  const split = ids.indexOf("|");
  const active = ids.slice(0, Math.max(split, 0));
  const finished = ids.slice(split + 1);
  const selected = useBoard((s) => (panel ? s.board?.tasks[panel] : undefined));
  if (panel === undefined) return null;
  return (
    <aside
      aria-label="Workers"
      className="border-border bg-background w-agents flex h-full shrink-0 flex-col border-s"
    >
      <header className="h-titlebar flex shrink-0 items-center gap-2 px-3">
        {selected ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="All workers" onClick={() => setPanel(null)}>
              <ArrowLeft />
            </Button>
            <h2 className="min-w-0 flex-1 truncate text-sm" title={selected.title}>
              {selected.title}
            </h2>
            <MentionButton number={selected.number} />
          </>
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-sm">Workers</h2>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => setPanel(undefined)}>
          <X />
        </Button>
      </header>
      <div className={cn("min-h-0 flex-1 overflow-y-auto pb-3", selected ? "px-4" : "px-2")}>
        {selected ? (
          <TaskCardView key={selected.id} taskId={selected.id} standalone />
        ) : active.length + finished.length === 0 ? (
          <p className="text-muted-foreground px-2 text-sm">No workers yet.</p>
        ) : (
          <>
            <AgentSection title="Active" ids={active} />
            <AgentSection title="Done" ids={finished} />
          </>
        )}
      </div>
    </aside>
  );
}
