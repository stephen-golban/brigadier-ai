import { useAui } from "@assistant-ui/react";
import {
  ArrowLeft,
  Atom,
  Bolt,
  Cube,
  GlobeFilled,
  HeartFilled,
  Snowflake,
  SparklesFilled,
  StarFilled,
  X,
} from "@openai/apps-sdk-ui/components/Icon";
import {
  createContext,
  memo,
  type ReactNode,
  type RefObject,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { isFinal } from "@/app/conversation/blocks";
import { TASK_STATE_LABELS, TaskActions } from "@/app/conversation/cards/TaskCardView";
import { useTaskElapsed, WorkerThread } from "@/app/conversation/WorkerThread";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import type { Task, WorkerStepKind } from "@/ipc/generated";
import { formatAgo, formatDuration } from "@/lib/format";
import { modelName, useModelGroups } from "@/lib/setup";
import { tokenPx } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { useBoard } from "@/state/board";

/** What the UI calls a session's workers (ChatGPT's "Subagents"; the user chose Workers). */
export const WORKERS_LABEL = "Workers";

/**
 * The session's workers ("agents"): their steps as grey rows inside each request's block, and a
 * side panel listing them all, where one opens to show its live transcript, commands and diff.
 */

/** Which worker the agents panel shows: `null` for the list, `undefined` when it is closed. */
export type AgentsPanelState = string | null | undefined;

export const AgentsPanelContext = createContext<{
  panel: AgentsPanelState;
  setPanel: (panel: AgentsPanelState) => void;
}>({ panel: undefined, setPanel: () => {} });

const GLYPHS = [
  { Icon: SparklesFilled, color: "text-glyph-1" },
  { Icon: StarFilled, color: "text-glyph-2" },
  { Icon: HeartFilled, color: "text-glyph-3" },
  { Icon: GlobeFilled, color: "text-glyph-4" },
  { Icon: Atom, color: "text-glyph-5" },
  { Icon: Bolt, color: "text-glyph-6" },
  { Icon: Snowflake, color: "text-glyph-7" },
  { Icon: Cube, color: "text-glyph-8" },
] as const;

/** A worker's own glyph and colour, the same wherever it appears. */
export function WorkerGlyph({ taskId, className }: { taskId: string; className?: string }) {
  let hash = 0;
  for (const char of taskId) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2147483647;
  const glyph = GLYPHS[hash % GLYPHS.length] ?? GLYPHS[0];
  return <glyph.Icon aria-hidden className={cn("size-icon-md shrink-0", glyph.color, className)} />;
}

/** Several workers' glyphs side by side, slightly overlapping. */
export function WorkerGlyphs({ taskIds }: { taskIds: readonly string[] }) {
  return (
    <span className="flex shrink-0 items-center -space-x-0.5">
      {taskIds.map((id) => (
        <WorkerGlyph
          key={id}
          taskId={id}
          className="animate-in fade-in zoom-in-90 duration-300 motion-reduce:animate-none"
        />
      ))}
    </span>
  );
}

/** Names shown in a step row before the rest become "and N more". */
const NAMED = 3;

const STEP_VERBS: Record<WorkerStepKind, [one: string, many: string]> = {
  started: ["started working", "started working"],
  waiting: ["is waiting for you", "are waiting for you"],
  paused: ["was paused", "were paused"],
  resumed: ["continued", "continued"],
  finished: ["finished", "finished"],
  landed: ["landed", "landed"],
  rejected: ["was turned down", "were turned down"],
  stopped: ["was interrupted", "were interrupted"],
  failed: ["finished with errors", "finished with errors"],
};

/**
 * Workers' steps as one grey line in the thread: "Scout, Verify and Review started working".
 * A name opens that worker in the panel; "N more" opens the list.
 */
export const WorkerStepRow = memo(function WorkerStepRow({
  kind,
  taskIds,
}: {
  kind: WorkerStepKind;
  taskIds: readonly string[];
}) {
  const { setPanel } = useContext(AgentsPanelContext);
  const tasks = useBoard(
    useShallow((s) => taskIds.map((id) => s.board?.tasks[id]).filter((task) => task !== undefined)),
  );
  if (tasks.length === 0) return null;
  const named = tasks.length > NAMED + 1 ? tasks.slice(0, NAMED) : tasks;
  const more = tasks.length - named.length;
  const [one, many] = STEP_VERBS[kind];
  const name = (task: Task) => (
    <button
      key={task.id}
      type="button"
      title={`task-${task.number} · ${TASK_STATE_LABELS[task.state]}`}
      onClick={() => setPanel(task.id)}
      className="hover:text-foreground inline-block max-w-xs truncate align-bottom transition-colors"
    >
      {task.title}
    </button>
  );
  const parts: ReactNode[] = [];
  named.forEach((task, index) => {
    if (index > 0) parts.push(index === named.length - 1 && more === 0 ? " and " : ", ");
    parts.push(name(task));
  });
  if (more > 0)
    parts.push(
      " and ",
      <button
        key="more"
        type="button"
        onClick={() => setPanel(null)}
        className="hover:text-foreground align-bottom transition-colors"
      >
        {more} more
      </button>,
    );
  return (
    <div
      data-slot="worker-step"
      data-kind={kind}
      className="text-muted-foreground flex min-h-row-sm items-center gap-2 text-sm"
    >
      <WorkerGlyphs taskIds={named.map((task) => task.id)} />
      <span className="min-w-0 truncate">
        {parts}
        {` ${tasks.length === 1 ? one : many}`}
      </span>
    </div>
  );
});

/** A worker's state in a word or two, under its name in the list. */
function statusLine(task: Task, activity: string | undefined): string | null {
  switch (task.state) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return activity ?? "Working";
    case "blocked":
      return "Asked the orchestrator";
    case "paused":
      return "Paused";
    case "reported":
      return "Reported";
    case "reviewing":
      return "In review";
    case "awaitingApproval":
    case "readyToLand":
      return "Waiting for you";
    case "rejected":
      return "Turned down";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "landed":
    case "done":
      return null;
  }
}

/** Seconds it has worked (ticking) while active; how long ago it ended after. */
function RowTime({ task }: { task: Task }) {
  const elapsed = useTaskElapsed(task);
  const final = isFinal(task);
  const now = useNow(final ? 60_000 : null);
  return (
    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
      {final ? formatAgo(task.updatedAtMs, now) : formatDuration(elapsed)}
    </span>
  );
}

const AgentRow = memo(function AgentRow({ taskId }: { taskId: string }) {
  const task = useBoard((s) => s.board?.tasks[taskId]);
  const activity = useBoard((s) => s.board?.activity[taskId]);
  const { setPanel } = useContext(AgentsPanelContext);
  if (!task) return null;
  const status = statusLine(task, activity);
  return (
    <li>
      <button
        type="button"
        data-task={`task-${task.number}`}
        title={`task-${task.number} · ${TASK_STATE_LABELS[task.state]}`}
        onClick={() => setPanel(task.id)}
        className="hover:bg-foreground/5 rounded-control flex w-full items-center gap-3 px-2 py-1.5 text-start transition-colors"
      >
        <WorkerGlyph taskId={task.id} className="size-icon-lg" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{task.title}</span>
          {status && (
            <span
              className={cn(
                "truncate text-xs",
                task.state === "failed" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {status}
            </span>
          )}
        </span>
        <RowTime task={task} />
      </button>
    </li>
  );
});

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

/** The panel's width once the user dragged it, kept while the app runs. */
let draggedWidth: number | null = null;

/** The panel's width: its token until the user drags the edge between it and the thread. */
function usePanelWidth() {
  const [width, setWidth] = useState(draggedWidth);
  const resize = (next: number) => {
    const min = tokenPx("--spacing-agents");
    const max = Math.max(min, window.innerWidth * 0.6);
    draggedWidth = Math.round(Math.min(max, Math.max(min, next)));
    setWidth(draggedWidth);
  };
  return { width, resize };
}

function Splitter({
  panel,
  onResize,
}: {
  panel: RefObject<HTMLElement | null>;
  onResize: (width: number) => void;
}) {
  const step = tokenPx("--spacing-row");
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${WORKERS_LABEL.toLowerCase()} panel`}
      tabIndex={0}
      className="hover:bg-border focus-visible:bg-ring absolute inset-y-0 -start-0.5 z-10 w-1 cursor-col-resize transition-colors"
      onPointerDown={(event) => {
        const element = panel.current;
        if (!element) return;
        event.preventDefault();
        const start = event.clientX;
        const from = element.getBoundingClientRect().width;
        const move = (next: PointerEvent) => onResize(from + start - next.clientX);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onKeyDown={(event) => {
        const width = panel.current?.getBoundingClientRect().width ?? 0;
        if (event.key === "ArrowLeft") onResize(width + step);
        else if (event.key === "ArrowRight") onResize(width - step);
      }}
    />
  );
}

/** Active workers first, then the finished ones, each by number. */
function useWorkerIds(conversationId: string): { active: string[]; finished: string[] } {
  const ids = useBoard(
    useShallow((s) => {
      if (s.board?.conversationId !== conversationId) return [];
      const tasks = Object.values(s.board.tasks).toSorted((a, b) => a.number - b.number);
      // `|` separates the two lists.
      return [
        ...tasks.filter((task) => !isFinal(task)).map((task) => task.id),
        "|",
        ...tasks.filter(isFinal).map((task) => task.id),
      ];
    }),
  );
  return useMemo(() => {
    const split = ids.indexOf("|");
    return { active: ids.slice(0, Math.max(split, 0)), finished: ids.slice(split + 1) };
  }, [ids]);
}

/** Every worker of the session. The rows hold still while the pointer is over them. */
function WorkerList({ conversationId }: { conversationId: string }) {
  const lists = useWorkerIds(conversationId);
  const [held, setHeld] = useState<typeof lists | null>(null);
  const shown = held ?? lists;
  if (lists.active.length + lists.finished.length === 0) {
    return (
      <p className="text-muted-foreground px-4 text-sm">
        No {WORKERS_LABEL.toLowerCase()} yet.
      </p>
    );
  }
  // A worker that started while the list was held joins it at the end.
  const heldIds = new Set([...shown.active, ...shown.finished]);
  const joined = [...lists.active, ...lists.finished].filter((id) => !heldIds.has(id));
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      onPointerEnter={() => setHeld(lists)}
      onPointerLeave={() => setHeld(null)}
    >
      <AgentSection title="Active" ids={[...shown.active, ...joined]} />
      <AgentSection title="Done" ids={shown.finished} />
    </div>
  );
}

/** One worker: its glyph, name and model in the header, its thread below. */
function WorkerDetail({ task }: { task: Task }) {
  const { setPanel } = useContext(AgentsPanelContext);
  const groups = useModelGroups();
  const choice = task.route.choice;
  const model = `${modelName(groups, choice)}${choice.effort ? ` · ${choice.effort}` : ""}`;
  return (
    <>
      <header className="h-titlebar border-border flex shrink-0 items-center gap-2 border-b px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Back to ${WORKERS_LABEL.toLowerCase()}`}
          onClick={() => setPanel(null)}
        >
          <ArrowLeft />
        </Button>
        <WorkerGlyph taskId={task.id} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={task.title}>
          {task.title}
        </h2>
        <span className="text-muted-foreground shrink-0 text-xs" title={`task-${task.number}`}>
          {model}
        </span>
        <CloseButton />
      </header>
      <div className="border-border flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        <span className="text-muted-foreground text-xs">task-{task.number}</span>
        <span className="flex-1" />
        <TaskActions task={task} />
        <MentionButton number={task.number} />
      </div>
      <WorkerThread key={task.id} task={task} model={model} />
    </>
  );
}

function CloseButton() {
  const { setPanel } = useContext(AgentsPanelContext);
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => setPanel(undefined)}>
      <X />
    </Button>
  );
}

/** The side panel: every worker of the session, or one of them working. */
export function AgentsPanel({ conversationId }: { conversationId: string }) {
  const { panel } = useContext(AgentsPanelContext);
  const selected = useBoard((s) => (panel ? s.board?.tasks[panel] : undefined));
  const { width, resize } = usePanelWidth();
  const ref = useRef<HTMLElement>(null);
  if (panel === undefined) return null;
  return (
    <aside
      ref={ref}
      aria-label={WORKERS_LABEL}
      className={cn(
        "border-border bg-background animate-in fade-in slide-in-from-right-2 relative flex h-full shrink-0 flex-col border-s duration-200",
        width === null && "w-agents",
      )}
      style={width === null ? undefined : { width }}
    >
      <Splitter panel={ref} onResize={resize} />
      {selected ? (
        <WorkerDetail task={selected} />
      ) : (
        <>
          <header className="h-titlebar flex shrink-0 items-center gap-2 px-3">
            <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{WORKERS_LABEL}</h2>
            <CloseButton />
          </header>
          <WorkerList conversationId={conversationId} />
        </>
      )}
    </aside>
  );
}
