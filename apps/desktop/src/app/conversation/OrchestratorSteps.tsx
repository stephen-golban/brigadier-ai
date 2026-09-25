import {
  Book,
  Chat,
  Check,
  ChevronRight,
  Globe,
} from "@openai/apps-sdk-ui/components/Icon";
import { type FC, type ReactNode, useContext } from "react";

import { AgentsPanelContext } from "@/app/conversation/Agents";
import type { BlockOrchestratorStep } from "@/app/conversation/blocks";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { OrchestratorStepKind } from "@/ipc/generated";
import { cn } from "@/lib/utils";
import { useBoard } from "@/state/board";

type Kind = OrchestratorStepKind["type"];

const ICONS: Record<Kind, FC<{ className?: string }>> = {
  messaged: Chat,
  readReport: Book,
  readArtifact: Book,
  accepted: Check,
  searchedWeb: Globe,
  readPage: Globe,
};

/** How a run of steps sums them up, as ChatGPT does ("Read reports, messaged a worker"). */
const PLURALS: Record<Kind, [one: string, many: string]> = {
  messaged: ["messaged a worker", "messaged workers"],
  readReport: ["read a report", "read reports"],
  readArtifact: ["read a file", "read files"],
  accepted: ["accepted a change", "accepted changes"],
  searchedWeb: ["searched the web", "searched the web"],
  readPage: ["read a page", "read pages"],
};

/** A grey line of the thread's work, as ChatGPT draws its tool rows. */
export const STEP_ROW = "text-muted-foreground flex min-h-row-sm min-w-0 items-center gap-2 text-sm";
const row = STEP_ROW;

/** A worker's name in a row: it opens the worker in the panel. */
const WorkerName: FC<{ taskId: string }> = ({ taskId }) => {
  const { setPanel } = useContext(AgentsPanelContext);
  const title = useBoard((s) => s.board?.tasks[taskId]?.title ?? null);
  if (title === null) return <>a worker</>;
  return (
    <button
      type="button"
      onClick={() => setPanel(taskId)}
      className="hover:text-foreground inline-block max-w-xs truncate align-bottom transition-colors"
    >
      {title}
    </button>
  );
};

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function label(kind: OrchestratorStepKind): ReactNode {
  switch (kind.type) {
    case "messaged":
      return (
        <>
          Sent message to <WorkerName taskId={kind.taskId} />
        </>
      );
    case "readReport":
      return (
        <>
          Read <WorkerName taskId={kind.taskId} />’s report
        </>
      );
    case "readArtifact":
      return `Read ${kind.name}`;
    case "accepted":
      return (
        <>
          Accepted <WorkerName taskId={kind.taskId} />’s change
        </>
      );
    case "searchedWeb":
      return `Searched the web for ${kind.query}`;
    case "readPage":
      return `Read ${hostOf(kind.url)}`;
  }
}

const StepRow: FC<{ step: BlockOrchestratorStep }> = ({ step }) => {
  const Icon = ICONS[step.kind.type];
  return (
    <div data-slot="orchestrator-step" data-kind={step.kind.type} className={row}>
      <Icon aria-hidden className="size-icon-md shrink-0" />
      <span className="min-w-0 truncate">{label(step.kind)}</span>
    </div>
  );
};

/**
 * What the orchestrator did between two replies, as ChatGPT tells its tool use: one grey line
 * per step ("Sent message to Add tests"), and a run of steps summed up in one line that opens
 * to each of them.
 */
export const OrchestratorSteps: FC<{ steps: readonly BlockOrchestratorStep[] }> = ({ steps }) => {
  const [first] = steps;
  if (steps.length === 1 && first) return <StepRow step={first} />;
  const counts = new Map<Kind, number>();
  for (const step of steps) counts.set(step.kind.type, (counts.get(step.kind.type) ?? 0) + 1);
  const [dominant] = [...counts].toSorted((a, b) => b[1] - a[1])[0] ?? ["messaged" as const];
  const Icon = ICONS[dominant];
  const summary = [...counts].map(([kind, count]) => PLURALS[kind][count === 1 ? 0 : 1]).join(", ");
  return (
    <Collapsible data-slot="orchestrator-steps">
      <CollapsibleTrigger className={cn(row, "group hover:text-foreground w-full text-start")}>
        <Icon aria-hidden className="size-icon-md shrink-0" />
        <span className="min-w-0 truncate">
          {summary.charAt(0).toUpperCase() + summary.slice(1)}
        </span>
        <ChevronRight
          aria-hidden
          className="size-icon-xs shrink-0 opacity-0 transition-[rotate,opacity] group-hover:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-action-list overflow-y-auto ps-6">
        {steps.map((step) => (
          <StepRow key={step.position} step={step} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
};
