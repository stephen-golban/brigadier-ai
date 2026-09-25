import { Pause, Play, Stop } from "@openai/apps-sdk-ui/components/Icon";
import { memo, type ReactNode, useState } from "react";

import { ArtifactDialog } from "@/app/conversation/ArtifactDialog";
import { DiffStatView, Lines, Section, short } from "@/app/conversation/cards/common";
import { useAction } from "@/app/conversation/useAction";
import { WorkerTranscript } from "@/app/conversation/WorkerTranscript";
import { PROVIDER_LABELS } from "@/app/inspector/providers/shared";
import { mono } from "@/components/assistant-ui/elements/surfaces";
import { TaskCard, type TaskCardState } from "@/components/assistant-ui/elements/task-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { openArtifact, saveArtifact } from "@/ipc/client";
import type { ArtifactRef, KeptWork, RestoreOutcome, Task, TaskState } from "@/ipc/generated";
import { formatBytes } from "@/lib/format";
import { modelName, useModelGroups } from "@/lib/setup";
import { cn } from "@/lib/utils";
import { pauseTask, restoreKeptWork, resumeTask, stopTask } from "@/state/actions";
import { useBoard } from "@/state/board";

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  blocked: "Blocked",
  paused: "Paused",
  reported: "Reported",
  reviewing: "In review",
  awaitingApproval: "Waiting for approval",
  readyToLand: "Ready to land",
  landed: "Landed",
  done: "Done",
  rejected: "Rejected",
  stopped: "Stopped",
  failed: "Failed",
};

const CARD_STATES: Record<TaskState, TaskCardState> = {
  queued: "waiting",
  starting: "working",
  running: "working",
  blocked: "waiting",
  paused: "paused",
  reported: "working",
  reviewing: "working",
  awaitingApproval: "waiting",
  readyToLand: "waiting",
  landed: "done",
  done: "done",
  rejected: "cancelled",
  stopped: "cancelled",
  failed: "failed",
};

/** How a task's state shows on its card and chip. */
export function taskCardState(state: TaskState): TaskCardState {
  return CARD_STATES[state];
}

/** States in which a worker (or its task) can still be stopped. */
const ACTIVE: ReadonlySet<TaskState> = new Set([
  "queued",
  "starting",
  "running",
  "blocked",
  "paused",
  "reported",
  "reviewing",
  "awaitingApproval",
  "readyToLand",
]);

/** One worker, read from the open board by id so only its own updates rerender it. */
export const TaskCardView = memo(function TaskCardView({
  taskId,
  standalone = false,
}: {
  taskId: string;
  /** On its own in the workers panel, which names the worker: always open, no toggle. */
  standalone?: boolean;
}) {
  const task = useBoard((s) => s.board?.tasks[taskId]);
  const activity = useBoard((s) => s.board?.activity[taskId]);
  const [open, setOpen] = useState(standalone);
  const groups = useModelGroups();
  if (!task) return null;

  const choice = task.route.choice;
  const model = `${modelName(groups, choice)}${choice.effort ? ` · ${choice.effort}` : ""}`;
  const working = task.state === "running" || task.state === "starting";
  const actions = ACTIVE.has(task.state) && <TaskActions task={task} />;

  return (
    <TaskCard
      data-task={`task-${task.number}`}
      label={task.title}
      state={CARD_STATES[task.state]}
      stateLabel={TASK_STATE_LABELS[task.state]}
      badges={
        <>
          <Badge variant="outline">{task.kind}</Badge>
          <Badge variant={task.state === "failed" ? "destructive" : "secondary"}>
            {TASK_STATE_LABELS[task.state]}
          </Badge>
        </>
      }
      meta={`task-${task.number} · ${model}`}
      activity={working ? activity : undefined}
      actions={actions || undefined}
      result={taskResult(task)}
      open={open}
      onOpenChange={setOpen}
      standalone={standalone}
    >
      <TaskDetails task={task} model={model} />
    </TaskCard>
  );
});

/** Pause or resume a worker, or stop it, while it is active. */
export function TaskActions({ task }: { task: Task }) {
  const action = useAction();
  if (!ACTIVE.has(task.state)) return null;
  const working = task.state === "running" || task.state === "starting";
  const codex = task.route.choice.provider === "codex";
  return (
    <>
      {task.state === "paused" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={action.busy}
          onClick={() => action.run(() => resumeTask(task.id))}
        >
          <Play />
          Resume
        </Button>
      ) : (
        working && (
          <Button
            size="xs"
            variant="outline"
            disabled={action.busy}
            onClick={() => action.run(() => pauseTask(task.id))}
          >
            <Pause />
            Pause
          </Button>
        )
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={action.busy}
        onClick={() => action.run(() => stopTask(task.id))}
      >
        <Stop />
        Stop
      </Button>
      {working && codex && (
        <span className="text-muted-foreground text-xs">
          Pausing Codex lets its current command finish first.
        </span>
      )}
      {action.error && (
        <span role="alert" className="text-destructive text-xs">
          {action.error}
        </span>
      )}
    </>
  );
}

/** The one-line outcome under the card: why it waits, what it reported, where it landed. */
function taskResult(task: Task): ReactNode {
  if (task.blockedReason) {
    return <span className="text-warning">{task.blockedReason}</span>;
  }
  if (task.error) return <span className="text-destructive">{task.error}</span>;
  if (task.landed) {
    return (
      <span>
        Landed as <span className="font-mono">{short(task.landed)}</span>
        {task.workspace?.target && ` on ${task.workspace.target}`}
      </span>
    );
  }
  if (task.report) return <span className="line-clamp-2">{task.report.summary}</span>;
  return undefined;
}

function ArtifactButtons({
  artifacts,
  onOpen,
}: {
  artifacts: readonly ArtifactRef[];
  onOpen: (artifact: ArtifactRef) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {artifacts.map((artifact) => (
        <Button key={artifact.id} size="xs" variant="outline" onClick={() => onOpen(artifact)}>
          {artifact.title}
          <span className="text-muted-foreground">{artifact.kind}</span>
        </Button>
      ))}
    </div>
  );
}

/** Whether the in-app viewer can show it (text); everything else opens in its own app. */
function isText(artifact: ArtifactRef): boolean {
  return artifact.mime.startsWith("text/") || artifact.mime === "application/json";
}

const EXTENSIONS: Record<string, string> = {
  "text/markdown": ".md",
  "text/x-diff": ".diff",
  "text/plain": ".txt",
  "application/json": ".json",
  "image/png": ".png",
  "image/jpeg": ".jpg",
};

/** The name a file is opened and saved under. */
function fileNameOf(artifact: ArtifactRef): string {
  return artifact.fileName ?? `${artifact.id.slice(0, 12)}${EXTENSIONS[artifact.mime] ?? ""}`;
}

/** One stored file: view it (text), open it in its app, or save it where the user picks. */
function ArtifactFile({
  artifact,
  onView,
}: {
  artifact: ArtifactRef;
  onView: (artifact: ArtifactRef) => void;
}) {
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const name = fileNameOf(artifact);
  const open = () => action.run(() => openArtifact(artifact.id, name));
  const save = () =>
    action.run(async () => {
      setSaved(await saveArtifact(artifact.id, name));
    });
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          className="min-w-0 flex-1 justify-start"
          onClick={isText(artifact) ? () => onView(artifact) : open}
        >
          <span className="truncate">{artifact.title}</span>
          {name !== artifact.title && (
            <span className="text-muted-foreground truncate font-mono">{name}</span>
          )}
        </Button>
        <span className="text-muted-foreground shrink-0 text-xs">
          {formatBytes(artifact.bytes)}
        </span>
        <Button size="xs" variant="outline" disabled={action.busy} onClick={open}>
          Open
        </Button>
        <Button size="xs" variant="outline" disabled={action.busy} onClick={save}>
          Save to…
        </Button>
      </div>
      {saved && !action.error && <p className="text-muted-foreground text-xs">Saved.</p>}
      {action.error && (
        <p role="alert" className="text-destructive text-xs">
          {action.error}
        </p>
      )}
    </li>
  );
}

function ArtifactFiles({
  artifacts,
  onView,
}: {
  artifacts: readonly ArtifactRef[];
  onView: (artifact: ArtifactRef) => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {artifacts.map((artifact) => (
        <ArtifactFile key={artifact.id} artifact={artifact} onView={onView} />
      ))}
    </ul>
  );
}

/** Unfinished work saved as a patch (its branch is gone), with "Restore as branch". */
function KeptPatch({
  taskId,
  kept,
  target,
  onOpen,
}: {
  taskId: string;
  kept: Extract<KeptWork, { type: "diff" }>;
  target: string | null;
  onOpen: (artifact: ArtifactRef) => void;
}) {
  const action = useAction();
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);
  const restore = () =>
    action.run(async () => setOutcome(await restoreKeptWork(taskId)));
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs">
        Saved as a patch, not a branch: it could not be kept as a clean commit on{" "}
        {target ? <span className="font-mono">{target}</span> : "the target branch"} (for
        example, it overlaps uncommitted changes you let workers see).
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <ArtifactButtons artifacts={[kept.artifact]} onOpen={onOpen} />
        {kept.restored === null && target && (
          <Button size="xs" variant="outline" disabled={action.busy} onClick={restore}>
            Restore as branch
          </Button>
        )}
      </div>
      {kept.restored !== null && (
        <p className={mono}>Restored as {kept.restored}</p>
      )}
      {outcome?.type === "conflicts" && (
        <p role="alert" className="text-destructive text-xs">
          It can't be restored on {target}: it conflicts with {target} in{" "}
          {outcome.paths.join(", ")}. Nothing was created.
        </p>
      )}
      {outcome?.type === "failed" && (
        <p role="alert" className="text-destructive text-xs">
          It can't be restored: {outcome.reason} Nothing was created.
        </p>
      )}
      {action.error && (
        <p role="alert" className="text-destructive text-xs">
          {action.error}
        </p>
      )}
    </div>
  );
}

/**
 * What a worker set out to do and produced: model, workspace, report, outputs, commit, review.
 * Under its thread in the workers panel (`inThread`), the thread already shows the model, the
 * report's summary and the transcript.
 */
export function TaskDetails({
  task,
  model,
  inThread = false,
}: {
  task: Task;
  model: string;
  inThread?: boolean;
}) {
  const [artifact, setArtifact] = useState<ArtifactRef | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const subjectNumber = useBoard((s) =>
    task.subject ? s.board?.tasks[task.subject]?.number : undefined,
  );
  const reviewNumber = useBoard((s) =>
    task.review ? s.board?.tasks[task.review.taskId]?.number : undefined,
  );
  const { report, candidate, review, workspace, kept } = task;

  return (
    <>
      <Section title="Model">
        {!inThread && (
          <p className="text-sm">
            {PROVIDER_LABELS[task.route.choice.provider]} · {model}
          </p>
        )}
        <p className="text-muted-foreground text-xs">Why this model: {task.route.reason}</p>
      </Section>

      {(workspace || subjectNumber !== undefined) && (
        <Section title="Workspace">
          {subjectNumber !== undefined && (
            <p className="text-xs">
              {task.kind === "review" ? "Reviews" : "Works on"} task-{subjectNumber}
            </p>
          )}
          {workspace?.branch && (
            <p className={mono}>
              {workspace.branch}
              {workspace.target && ` → ${workspace.target}`}
              {workspace.base && ` (from ${short(workspace.base)})`}
            </p>
          )}
          {workspace?.worktree && (
            <p className={cn(mono, "text-muted-foreground truncate")}>{workspace.worktree}</p>
          )}
        </Section>
      )}

      {report ? (
        <>
          {!inThread && (
            <Section title="Report">
              <p className="text-sm whitespace-pre-wrap">{report.summary}</p>
            </Section>
          )}
          <Section title="Changes">
            <Lines items={report.changes} />
          </Section>
          <Section title="Decisions">
            <Lines items={report.decisions} />
          </Section>
          <Section title="Verification">
            <Lines items={report.verification} />
          </Section>
          {report.openQuestions.length > 0 && (
            <Section title="Open questions">
              <Lines items={report.openQuestions} />
            </Section>
          )}
          {report.verdict && (
            <Section title="Verdict">
              <Badge variant={report.verdict === "approve" ? "success" : "warning"}>
                {report.verdict === "approve" ? "Approved" : "Changes requested"}
              </Badge>
            </Section>
          )}
          {report.artifacts.length > 0 && (
            <Section title="Artifacts">
              <ArtifactFiles artifacts={report.artifacts} onView={setArtifact} />
            </Section>
          )}
        </>
      ) : (
        !inThread && <p className="text-muted-foreground text-xs">No report yet.</p>
      )}

      {task.outputs.length > 0 && (
        <Section title="Outputs">
          <ArtifactFiles artifacts={task.outputs} onView={setArtifact} />
        </Section>
      )}

      {candidate && (
        <Section title="Candidate commit">
          <p className="text-sm">
            <span className="font-mono">{short(candidate.commit)}</span> {candidate.message}
          </p>
          <p className={cn(mono, "text-muted-foreground")}>on {short(candidate.onto)}</p>
          <DiffStatView stat={candidate.diffStat} />
          {candidate.excluded.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <p className="text-xs">Left out by the litter guard:</p>
              <ul className={cn(mono, "flex flex-col gap-0.5")}>
                {candidate.excluded.map((file) => (
                  <li key={file.path}>
                    {file.path} <span className="text-muted-foreground">— {file.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {candidate.diff && (
            <ArtifactButtons artifacts={[candidate.diff]} onOpen={setArtifact} />
          )}
        </Section>
      )}

      {review && (
        <Section title="Review">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {review.verdict === null ? (
              <Badge variant="secondary">In review</Badge>
            ) : (
              <Badge variant={review.verdict === "approve" ? "success" : "warning"}>
                {review.verdict === "approve" ? "Approved" : "Changes requested"}
              </Badge>
            )}
            {reviewNumber !== undefined && <span className="text-xs">by task-{reviewNumber}</span>}
            <span className="text-muted-foreground text-xs">
              {review.crossVendor
                ? "cross-vendor"
                : "same vendor (only one was available)"}{" "}
              · of {short(review.commit)}
            </span>
          </p>
        </Section>
      )}

      {task.landed && (
        <Section title="Landed">
          <p className={mono}>
            {task.landed}
            {workspace?.target && ` on ${workspace.target}`}
          </p>
        </Section>
      )}

      {kept && (
        <Section title="Kept work">
          {kept.type === "branch" ? (
            <p className={mono}>
              {kept.branch} at {short(kept.commit)}
            </p>
          ) : (
            <KeptPatch
              taskId={task.id}
              kept={kept}
              target={workspace?.target ?? null}
              onOpen={setArtifact}
            />
          )}
        </Section>
      )}

      {!inThread && (
        <Collapsible open={transcriptOpen} onOpenChange={setTranscriptOpen}>
          <CollapsibleTrigger asChild>
            <Button size="xs" variant="ghost" className="self-start">
              {transcriptOpen ? "Hide live transcript" : "Show live transcript"}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5">
            {transcriptOpen && (
              <WorkerTranscript conversationId={task.conversationId} taskId={task.id} />
            )}
          </CollapsibleContent>
        </Collapsible>
      )}

      <ArtifactDialog artifact={artifact} onOpenChange={(next) => !next && setArtifact(null)} />
    </>
  );
}
