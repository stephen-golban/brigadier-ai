import { useAui } from "@assistant-ui/react";
import {
  Branch,
  Copy,
  DotsHorizontal,
  FolderOpen,
  Link,
  Plus,
  Tasks,
} from "@openai/apps-sdk-ui/components/Icon";
import { type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { AgentsPanelContext, WORKERS_LABEL, WorkerGlyphs } from "@/app/conversation/Agents";
import { isFinal, isWorking } from "@/app/conversation/blocks";
import { GitActions } from "@/app/conversation/GitActions";
import { COMPOSER_EDITABLE } from "@/app/conversation/composerTarget";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { openFolder, openUrl } from "@/ipc/client";
import type { Conversation, DiffStat, Plan, Task } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import { getSessionDiff, select, setPinnedSummary, setProjectExpanded } from "@/state/actions";
import { useBoard } from "@/state/board";
import { useApp } from "@/state/store";
import { toast } from "@/state/toasts";

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

const Section = ({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-1">
    <h3 className="text-muted-foreground flex h-control-xs items-center justify-between text-xs">
      {title}
      {action}
    </h3>
    {children}
  </section>
);

/** Web links in `text`, without trailing punctuation. */
function linksIn(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>()"'`]+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, ""));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The session's sources, as ChatGPT's pinned card lists them: links in the user's messages
 * (as soon as they are sent) and pages the orchestrator read, first seen first.
 */
function useSources(conversationId: string): string[] {
  const messages = useApp((s) => s.threads[conversationId]?.items);
  const read = useBoard(
    useShallow((s) =>
      s.board?.conversationId === conversationId
        ? s.board.orchestratorSteps.flatMap((step) =>
            step.kind.type === "readPage" ? [step.kind.url] : [],
          )
        : [],
    ),
  );
  return useMemo(() => {
    const said = (messages ?? []).flatMap((message) =>
      message.role === "user" ? linksIn(message.text) : [],
    );
    return [...new Set([...said, ...read])];
  }, [messages, read]);
}

function openLink(url: string): void {
  openUrl(url).catch((error: unknown) =>
    toast(error instanceof Error ? error.message : String(error), { tone: "error" }),
  );
}

const SourceRow = ({ url, dim }: { url: string; dim?: boolean }) => (
  <button
    type="button"
    title={url}
    onClick={() => openLink(url)}
    className={cn(
      "hover:bg-foreground/5 rounded-control -mx-1 flex h-control-sm items-center gap-2 px-1 text-start text-sm transition-colors",
      dim && "text-muted-foreground",
    )}
  >
    <Link aria-hidden className="text-muted-foreground size-icon-sm shrink-0" />
    <span className="min-w-0 truncate">{hostOf(url)}</span>
  </button>
);

/** Sources shown before "View all". */
const SOURCES = 3;

/** "Sources": the first links, "View all" for every one, and "+" to add one to the message. */
function Sources({ conversationId }: { conversationId: string }) {
  const sources = useSources(conversationId);
  const aui = useAui();
  if (sources.length === 0) return null;
  const add = () => {
    const composer = aui.composer();
    const text = composer.getState().text;
    composer.setText(text && !text.endsWith(" ") ? `${text} https://` : `${text}https://`);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(COMPOSER_EDITABLE)?.focus());
  };
  return (
    <Section
      title="Sources"
      action={
        <TooltipIconButton tooltip="Add source" size="icon-xs" onClick={add}>
          <Plus />
        </TooltipIconButton>
      }
    >
      {sources.slice(0, SOURCES).map((url) => (
        <SourceRow key={url} url={url} />
      ))}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground -mx-1 flex h-control-sm items-center gap-2 px-1 text-start text-sm transition-colors"
          >
            <Link aria-hidden className="size-icon-sm shrink-0 opacity-60" />
            View all
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex max-h-80 w-xs flex-col overflow-y-auto">
          {sources.map((url) => (
            <button
              key={url}
              type="button"
              onClick={() => openLink(url)}
              className="hover:bg-muted rounded-control flex flex-col px-2 py-1 text-start"
            >
              <span className="truncate text-sm">{hostOf(url)}</span>
              <span className="text-muted-foreground truncate text-xs">{url}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </Section>
  );
}

/** The project's ⋯ "Actions": a new session, its folder, and its path. */
function ProjectActions({ projectId, path }: { projectId: string; path: string }) {
  const mac = useApp((s) => s.info?.platform === "macos");
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton tooltip="Actions" size="icon-xs">
          <DotsHorizontal />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            setProjectExpanded(projectId, true);
            select({ type: "draft", kind: "session", projectId });
          }}
        >
          <Plus />
          New session
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            void openFolder(path).catch((error: unknown) =>
              toast(error instanceof Error ? error.message : String(error), { tone: "error" }),
            )
          }
        >
          <FolderOpen />
          {mac ? "Reveal in Finder" : "Open in File Manager"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            navigator.clipboard.writeText(path).then(
              () => toast("Copied path"),
              () => toast("Failed to copy path", { tone: "error" }),
            )
          }
        >
          <Copy />
          Copy path
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const sources = useSources(conversation.id).length > 0;
  if (!shown || !setup) return null;
  const checkout =
    setup.environment.type === "newWorktree" ? (setup.environment.path ?? setup.repo) : setup.repo;

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
      <div className="flex h-control-xs items-center gap-2">
        <h2 className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{project ?? setup.repo}</h2>
        {conversation.projectId && (
          <ProjectActions projectId={conversation.projectId} path={checkout} />
        )}
      </div>
      <GitActions conversationId={conversation.id}>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
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
      </GitActions>
      {(workers.length > 0 || plan || sources) && <div className="border-border border-t" />}
      {workers.length > 0 && (
        <Section title={WORKERS_LABEL}>
          <button
            type="button"
            onClick={() => setPanel(null)}
            className="hover:bg-foreground/5 rounded-control -mx-1 flex h-control-sm items-center gap-2 px-1 text-start text-sm transition-colors"
          >
            <WorkerGlyphs taskIds={glyphs} />
            <span className="min-w-0 flex-1 truncate">
              {active.length > 0
                ? [working > 0 && `${working} working`, waiting > 0 && `${waiting} waiting`]
                    .filter(Boolean)
                    .join(" · ")
                : `${done} done`}
            </span>
            {active.length > 0 && done > 0 && (
              <span className="text-muted-foreground shrink-0">{done} done</span>
            )}
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
      <Sources conversationId={conversation.id} />
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
