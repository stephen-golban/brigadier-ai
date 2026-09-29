import { Clock, Shuffle } from "@openai/apps-sdk-ui/components/Icon";

import { Section } from "@/app/conversation/cards/common";
import { PROVIDER_LABELS } from "@/app/inspector/providers/shared";
import type { ModelGroup } from "@/components/assistant-ui/elements/model-selector";
import { Badge } from "@/components/ui/badge";
import { useNow } from "@/hooks/use-now";
import type { Attempt, Explanation, QuotaWait, Task } from "@/ipc/generated";
import { formatCountdown, formatDateTime, formatTime } from "@/lib/format";
import {
  choiceName,
  formatDelta,
  formatScore,
  handoffLine,
  handoffs,
  limitPhrase,
  TIER_LABELS,
} from "@/lib/routing";
import { cn } from "@/lib/utils";
import { useApp } from "@/state/store";

/**
 * Why a worker runs on its model, on its row and in the Workers panel: the one-line reason, the
 * hand-off that brought it there, a wait for quota, and in the details the explanation behind
 * the choice and every model that ran it. None of it goes into the conversation's thread.
 */

/** The routing reason in one muted line, the full text on hover. */
export function RouteReason({ task, className }: { task: Task; className?: string }) {
  if (!task.route.reason) return null;
  return (
    <span
      data-slot="route-reason"
      title={task.route.reason}
      className={cn("text-muted-foreground block truncate text-xs", className)}
    >
      {task.route.reason}
    </span>
  );
}

/** The latest hand-off, when the task changed models: "Claude Opus 5.5 hit its … → Codex …". */
export function HandoffLine({
  task,
  groups,
  className,
}: {
  task: Task;
  groups: readonly ModelGroup[];
  className?: string;
}) {
  const providers = useApp((s) => s.providers.view?.providers);
  const now = useNow(60_000);
  const last = handoffs(task.attempts).at(-1);
  if (!last) return null;
  const line = `Handed off: ${handoffLine(last[0], last[1], groups, providers, now)}`;
  return (
    <span
      data-slot="route-handoff"
      title={line}
      className={cn("text-muted-foreground flex min-w-0 items-center gap-1 text-xs", className)}
    >
      <Shuffle aria-hidden className="size-icon-xs shrink-0" />
      <span className="truncate">{line}</span>
    </span>
  );
}

/**
 * A task paused for quota: what it waits for, the countdown to the reset, and the user rule
 * that keeps it from other models. It resumes on its own.
 */
export function QuotaWaitLine({ wait }: { wait: QuotaWait }) {
  const now = useNow(30_000);
  return (
    <span data-slot="quota-wait" className="flex flex-col gap-0.5">
      <span className="text-warning flex items-center gap-1">
        <Clock aria-hidden className="size-icon-xs shrink-0" />
        <span>
          Waiting for quota: {wait.reason}
          {wait.resetsAtMs !== null && ` · ${formatCountdown(wait.resetsAtMs, now)} left`}
        </span>
      </span>
      {wait.rule && <span>Your rule keeps it from other models: {wait.rule}</span>}
      <span>It resumes on its own when quota frees up.</span>
    </span>
  );
}

/** The explanation behind a choice: its factors, the runners-up and what decided it. */
export function ExplanationView({
  explanation,
  groups,
}: {
  explanation: Explanation;
  groups: readonly ModelGroup[];
}) {
  const { score, factors, alternatives, rule, trial, balancing } = explanation;
  return (
    <div data-slot="route-explanation" className="flex flex-col gap-2">
      {(trial || balancing || rule) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {trial && (
            <Badge variant="warning" title="An unrated model trying out low-risk work">
              Trial
            </Badge>
          )}
          {balancing && (
            <Badge variant="secondary" title="Quota balancing moved this work off a provider running hot">
              Balancing
            </Badge>
          )}
          {rule && <span className="text-xs">Your rule decided it: {rule}</span>}
        </div>
      )}
      {factors.length > 0 && (
        <table className="w-full text-xs">
          <caption className="sr-only">Score</caption>
          <tbody>
            {factors.map((factor, index) => (
              <tr key={index}>
                <td className="py-0.5 pe-3">{factor.label}</td>
                <td className="text-muted-foreground w-0 py-0.5 text-end tabular-nums whitespace-nowrap">
                  {formatDelta(factor.delta)}
                </td>
              </tr>
            ))}
            {score !== null && (
              <tr className="border-t">
                <td className="py-0.5 pe-3 font-medium">Score</td>
                <td className="w-0 py-0.5 text-end font-medium tabular-nums">{formatScore(score)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {alternatives.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="text-muted-foreground text-xs">Also considered</p>
          <ul className="flex flex-col gap-0.5 text-xs">
            {alternatives.map((alternative) => (
              <li key={`${alternative.provider}/${alternative.model}`} className="flex gap-2">
                <span className="shrink-0">
                  {choiceName(groups, {
                    provider: alternative.provider,
                    model: alternative.model,
                    effort: null,
                  })}
                  {alternative.score !== null && (
                    <span className="text-muted-foreground tabular-nums">
                      {" "}
                      ({formatScore(alternative.score)})
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground min-w-0">{alternative.whyNot}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function attemptEnd(
  attempt: Attempt,
  providers: Parameters<typeof limitPhrase>[2],
  now: number,
): string | null {
  const end = attempt.end;
  if (!end) return null;
  return end.type === "limit"
    ? `It ${limitPhrase(end.limit, attempt.route.choice.provider, providers, now)}.`
    : `It failed: ${end.message}`;
}

/** Every model that ran the task, oldest first, with how each run ended. */
export function AttemptsView({
  attempts,
  groups,
}: {
  attempts: readonly Attempt[];
  groups: readonly ModelGroup[];
}) {
  const providers = useApp((s) => s.providers.view?.providers);
  const now = useNow(60_000);
  return (
    <ol data-slot="route-attempts" className="flex flex-col gap-1.5">
      {attempts.map((attempt, index) => {
        const end = attemptEnd(attempt, providers, now);
        const current = index === attempts.length - 1 && attempt.endedAtMs === null;
        return (
          <li key={attempt.startedAtMs} className="flex flex-col text-xs">
            <span>
              {choiceName(groups, attempt.route.choice)}
              {attempt.route.choice.effort && ` · ${attempt.route.choice.effort}`}
              <span className="text-muted-foreground">
                {" "}
                · {formatDateTime(attempt.startedAtMs)}
                {attempt.endedAtMs !== null
                  ? `–${formatTime(attempt.endedAtMs)}`
                  : current
                    ? " · now"
                    : ""}
              </span>
            </span>
            <span className="text-muted-foreground truncate" title={attempt.route.reason}>
              {attempt.route.reason}
            </span>
            {end && <span className="text-warning">{end}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The details' routing sections: why this model (with its explanation) and its attempts. */
export function RouteSections({
  task,
  model,
  groups,
  inThread,
}: {
  task: Task;
  model: string;
  groups: readonly ModelGroup[];
  inThread: boolean;
}) {
  const { route } = task;
  return (
    <>
      <Section title="Why this model">
        {!inThread && (
          <p className="text-sm">
            {PROVIDER_LABELS[route.choice.provider]} · {model}
          </p>
        )}
        <p className="text-muted-foreground text-xs">{route.reason}</p>
        <p className="text-muted-foreground text-xs">
          Quality floor: {TIER_LABELS[task.floor]}
          {task.areas.length > 0 && ` · touches ${task.areas.join(", ")}`}
        </p>
        {route.explanation && <ExplanationView explanation={route.explanation} groups={groups} />}
      </Section>
      {(task.attempts.length > 1 || task.attempts.some((attempt) => attempt.end !== null)) && (
        <Section title="Models that ran it">
          <AttemptsView attempts={task.attempts} groups={groups} />
        </Section>
      )}
    </>
  );
}
