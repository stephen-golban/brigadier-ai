import {
  Branch,
  ChevronDown,
  Commit,
  Globe,
  InfoCircle,
  PencilSquare,
  QuestionMarkCircle,
  Sparkle,
  Terminal,
} from "@openai/apps-sdk-ui/components/Icon";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { DiffStatView } from "@/app/conversation/cards/common";
import { useAction } from "@/app/conversation/useAction";
import {
  ActionCard,
  ActionCardCode,
  ActionCardKind,
  ActionCardTitle,
  ActionFreeText,
  ActionOption,
} from "@/components/assistant-ui/elements/action-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Approval, ApprovalDecision, Conversation } from "@/ipc/generated";
import { ALWAYS_ASK_NOTE } from "@/lib/setup";
import { answerCard, answerQuestion, decidePlan } from "@/state/actions";
import { useBoard } from "@/state/board";

/*
 * ChatGPT puts a pending decision in the composer's place: the approval card, the question
 * card and "Implement this plan?". Brigadier keeps a one-line message field in each (the
 * user can always talk to the orchestrator; sending steers or queues as usual).
 */

export type PendingAction = { type: "approval" | "question" | "plan"; id: string };

/** What an answer to a skipped question says, so the asker carries on. */
const SKIPPED = "Skipped: use your best judgment.";

/**
 * The decisions waiting for the user in a conversation, oldest first: approvals, open
 * questions, and plans a session under "Ask for approval" waits on.
 */
export function usePendingActions(conversation: Conversation | null): PendingAction[] {
  // Plan mode hands the plan to the user whatever the permission level.
  const decidesPlans =
    conversation?.setup?.type === "session" &&
    (conversation.setup.permission === "askForApproval" || conversation.setup.planMode);
  const keys = useBoard(
    useShallow((s) => {
      const board = s.board;
      if (!board || board.conversationId !== conversation?.id) return [];
      const waiting: { key: string; position: number }[] = [];
      for (const approval of Object.values(board.approvals)) {
        if (approval.state.type === "pending") {
          waiting.push({ key: `approval:${approval.id}`, position: approval.position });
        }
      }
      for (const question of Object.values(board.questions)) {
        if (question.answer === null && question.answeredAtMs === null) {
          waiting.push({ key: `question:${question.id}`, position: question.position });
        }
      }
      if (decidesPlans) {
        for (const plan of Object.values(board.plans)) {
          if (plan.state.type === "proposed") {
            waiting.push({ key: `plan:${plan.id}`, position: plan.position });
          }
        }
      }
      return waiting.toSorted((a, b) => a.position - b.position).map((entry) => entry.key);
    }),
  );
  return keys.map((key) => {
    const [type, id] = key.split(":") as [PendingAction["type"], string];
    return { type, id };
  });
}

/** Keys typed into a text field (the composer's is contenteditable) are the field's, not the card's. */
function typing(event: KeyboardEvent): boolean {
  const { target } = event;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** The card for one pending decision; `message` is the card's one-line message field. */
export function PendingActionCard({
  action,
  more,
  onDismiss,
  message,
}: {
  action: PendingAction;
  /** How many more wait behind this one. */
  more: number;
  onDismiss: () => void;
  message: ReactNode;
}) {
  const footer = (
    <>
      {more > 0 && (
        <p className="text-muted-foreground px-1 text-xs">
          {more} more {more === 1 ? "decision waits" : "decisions wait"} after this one
        </p>
      )}
      {message}
    </>
  );
  switch (action.type) {
    case "approval":
      return <ApprovalAction key={action.id} id={action.id} footer={footer} />;
    case "question":
      return <QuestionAction key={action.id} id={action.id} onDismiss={onDismiss} footer={footer} />;
    case "plan":
      return <PlanAction key={action.id} id={action.id} onDismiss={onDismiss} footer={footer} />;
  }
}

// ----- approval ----------------------------------------------------------------------------

/** Shell-quotes an argument only where needed, so the exact argv reads unambiguously. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

type Shown = { icon: ReactNode; kind: string; title: string; detail?: string | undefined; body: ReactNode };

/** ChatGPT's kinds ("Terminal", "Edit files", "Internet access") for what is asked. */
function describe(approval: Approval, taskNumber?: number, landingNumber?: number): Shown {
  const actor = taskNumber === undefined ? null : `task-${taskNumber}`;
  const { subject } = approval;
  switch (subject.type) {
    case "cli": {
      const { request } = subject;
      const edits = request.kind === "fileChange" || request.paths.length > 0;
      const web = /web|fetch|search|network/i.test(request.tool);
      const [icon, kind] = request.command
        ? [<Terminal key="icon" />, "Terminal"]
        : edits
          ? [<PencilSquare key="icon" />, "Edit files"]
          : web
            ? [<Globe key="icon" />, "Internet access"]
            : [<Sparkle key="icon" />, request.tool];
      const what = request.command ? "run this command" : edits ? "make these edits" : `use ${request.tool}`;
      return {
        icon,
        kind,
        // The asker's own justification, as ChatGPT shows it; else the plain question.
        title: request.reason || `Do you want ${actor ?? "the model"} to ${what}?`,
        detail: request.reason && actor ? `Asked by ${actor}` : undefined,
        body: (
          <>
            {request.escalation && (
              <Badge variant="warning" className="self-start">
                Outside the sandbox
              </Badge>
            )}
            {request.command && <ActionCardCode>{request.command}</ActionCardCode>}
            {request.paths.length > 0 && <ActionCardCode>{request.paths.join("\n")}</ActionCardCode>}
            {!request.command && request.paths.length === 0 && request.input && (
              <ActionCardCode>{request.input}</ActionCardCode>
            )}
          </>
        ),
      };
    }
    case "outwardCommand":
      return {
        icon: <Terminal />,
        kind: "Terminal",
        title: `Do you want ${actor ?? "the model"} to run a command that reaches outside?`,
        detail: ALWAYS_ASK_NOTE,
        body: <ActionCardCode>{subject.argv.map(quote).join(" ")}</ActionCardCode>,
      };
    case "landing": {
      const task = landingNumber === undefined ? "this task" : `task-${landingNumber}`;
      return {
        icon: <Commit />,
        kind: `Land ${task}`,
        title: `Land ${task} on ${subject.branch}?`,
        detail: "One reviewed commit",
        body: <DiffStatView stat={subject.diffStat} />,
      };
    }
    case "finishSession":
      return {
        icon: <Branch />,
        kind: "Finish session",
        title: `Merge ${subject.branch} into ${subject.base}?`,
        detail: `${subject.commits} commit${subject.commits === 1 ? "" : "s"}`,
        body: <DiffStatView stat={subject.diffStat} />,
      };
    case "action":
      return {
        icon: <Sparkle />,
        kind: actor ?? "Action",
        title: subject.action,
        body: <p className="px-1 text-sm whitespace-pre-wrap">{subject.details}</p>,
      };
  }
}

/** "Deny `Esc`" and "Allow once `↩`", the primary focused so Enter allows. */
function ApprovalAction({ id, footer }: { id: string; footer: ReactNode }) {
  const approval = useBoard((s) => s.board?.approvals[id]);
  const taskNumber = useBoard((s) =>
    approval?.taskId ? s.board?.tasks[approval.taskId]?.number : undefined,
  );
  const landingNumber = useBoard((s) =>
    approval?.subject.type === "landing" ? s.board?.tasks[approval.subject.taskId]?.number : undefined,
  );
  const action = useAction();
  const allow = useRef<HTMLButtonElement>(null);
  useEffect(() => allow.current?.focus(), []);
  if (!approval) return null;

  const shown = describe(approval, taskNumber, landingNumber);
  const request = approval.subject.type === "cli" ? approval.subject.request : null;
  const grant = request?.grant ?? null;
  const answer = (decision: ApprovalDecision) =>
    action.run(() => answerCard(approval.conversationId, approval.id, decision));
  const deny = () => answer({ type: "deny", message: "" });
  return (
    <ActionCard
      aria-label="Approval"
      data-action="approval"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !typing(event) && !action.busy) {
          event.preventDefault();
          deny();
        }
      }}
    >
      <ActionCardKind icon={shown.icon}>{shown.kind}</ActionCardKind>
      <ActionCardTitle detail={shown.detail}>{shown.title}</ActionCardTitle>
      {shown.body}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {action.error && (
          <span role="alert" className="text-destructive me-auto text-xs">
            {action.error}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="rounded-capsule"
          disabled={action.busy}
          onClick={deny}
        >
          Deny
          <Kbd>Esc</Kbd>
        </Button>
        <div className="flex">
          <Button
            ref={allow}
            size="sm"
            className={grant ? "rounded-s-capsule rounded-e-none" : "rounded-capsule"}
            disabled={action.busy}
            onClick={() => answer({ type: "allow" })}
          >
            Allow once
            <Kbd>↩</Kbd>
          </Button>
          {grant && (
            <GrantMenu
              command={grant}
              escalation={request?.escalation ?? false}
              disabled={action.busy}
              onAnswer={answer}
            />
          )}
        </div>
      </div>
      {footer}
    </ActionCard>
  );
}

/**
 * The ⌄ half of ChatGPT's split "Allow once". Its "Allow similar commands" becomes an exact
 * grant: this command, for the rest of this worker's CLI session, never saved.
 */
function GrantMenu({
  command,
  escalation,
  disabled,
  onAnswer,
}: {
  command: string;
  escalation: boolean;
  disabled: boolean;
  onAnswer: (decision: ApprovalDecision) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          aria-label="Approval options"
          className="border-primary-foreground/20 rounded-s-none rounded-e-capsule border-s px-2"
          disabled={disabled}
        >
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAnswer({ type: "allow" })}>Allow once</DropdownMenuItem>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem onSelect={() => onAnswer({ type: "allowSimilar" })}>
              Don't ask again for this command
              <InfoCircle className="text-muted-foreground ms-auto" />
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="right">
            <span>
              Allow <code className="font-mono break-all">{command}</code>
              {escalation && " outside the sandbox"} again for this worker
            </span>
          </TooltipContent>
        </Tooltip>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ----- question ----------------------------------------------------------------------------

/**
 * ChatGPT's question card: numbered answers (1–9 pick, ↑/↓ move, a pick sends after a beat),
 * then "No, and tell Brigadier what to do differently" and Skip. × puts it aside.
 */
function QuestionAction({
  id,
  onDismiss,
  footer,
}: {
  id: string;
  onDismiss: () => void;
  footer: ReactNode;
}) {
  const question = useBoard((s) => s.board?.questions[id]);
  const taskNumber = useBoard((s) =>
    question?.taskId ? s.board?.tasks[question.taskId]?.number : undefined,
  );
  const action = useAction();
  const [highlight, setHighlight] = useState(() => question?.recommended ?? 0);
  const [typed, setTyped] = useState("");
  const card = useRef<HTMLElement>(null);
  useEffect(() => card.current?.focus(), []);
  if (!question) return null;

  const uncommitted = question.kind.type === "uncommittedChanges" ? question.kind.files : null;
  const options = question.options;
  const answer = (text: string) =>
    action.run(() => answerQuestion(question.conversationId, question.id, text));
  // The row lights up, then the answer goes, as ChatGPT's does.
  const choose = (index: number) => {
    const option = options[index];
    if (option === undefined || action.busy) return;
    setHighlight(index);
    setTimeout(() => answer(option), 180);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (typing(event)) return;
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(9, options.length)) {
      event.preventDefault();
      choose(digit - 1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) => (current + step + options.length) % Math.max(1, options.length));
    } else if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      choose(highlight);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
    }
  };

  return (
    <ActionCard ref={card} tabIndex={-1} aria-label="Question" data-action="question" onKeyDown={onKeyDown}>
      <ActionCardTitle
        onDismiss={onDismiss}
        detail={
          uncommitted
            ? "Brigadier asks once, before the first worker starts. They are never committed either way."
            : taskNumber === undefined
              ? undefined
              : `task-${taskNumber} waits for this`
        }
      >
        {uncommitted ? "Should workers see your uncommitted changes?" : question.text}
      </ActionCardTitle>
      {uncommitted && uncommitted.length > 0 && <ActionCardCode>{uncommitted.join("\n")}</ActionCardCode>}
      {options.length > 0 && (
        <div role="radiogroup" aria-label="Answers" className="flex flex-col">
          {options.map((option, index) => (
            <ActionOption
              key={option}
              role="radio"
              aria-checked={index === highlight}
              number={index + 1}
              label={option}
              recommended={question.recommended === index}
              highlighted={index === highlight}
              disabled={action.busy}
              onPointerMove={() => setHighlight(index)}
              onClick={() => choose(index)}
            />
          ))}
        </div>
      )}
      <ActionFreeText
        value={typed}
        aria-label="Your answer"
        placeholder={
          options.length > 0 ? "No, and tell Brigadier what to do differently" : "Type your answer"
        }
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && typed.trim()) {
            event.preventDefault();
            answer(typed.trim());
          }
        }}
      >
        <Button
          variant="outline"
          size="sm"
          className="rounded-capsule"
          disabled={action.busy}
          onClick={() => answer(SKIPPED)}
        >
          Skip
        </Button>
      </ActionFreeText>
      {action.error && (
        <p role="alert" className="text-destructive px-1 text-xs">
          {action.error}
        </p>
      )}
      {footer}
    </ActionCard>
  );
}

// ----- plan --------------------------------------------------------------------------------

/** "Implement this plan?": 1 approves, the free-text row rejects with what should change. */
function PlanAction({
  id,
  onDismiss,
  footer,
}: {
  id: string;
  onDismiss: () => void;
  footer: ReactNode;
}) {
  const plan = useBoard((s) => s.board?.plans[id]);
  const action = useAction();
  const [typed, setTyped] = useState("");
  const card = useRef<HTMLElement>(null);
  useEffect(() => card.current?.focus(), []);
  if (!plan) return null;

  const approve = () =>
    action.run(() => decidePlan(plan.conversationId, plan.id, true, null));
  const reject = (message: string) =>
    action.run(() => decidePlan(plan.conversationId, plan.id, false, message));
  return (
    <ActionCard
      ref={card}
      tabIndex={-1}
      aria-label="Implement this plan?"
      data-action="plan"
      onKeyDown={(event) => {
        if (typing(event)) return;
        if (event.key === "1" || (event.key === "Enter" && event.target === event.currentTarget)) {
          event.preventDefault();
          if (!action.busy) approve();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      <ActionCardTitle onDismiss={onDismiss} detail={plan.title}>
        Implement this plan?
      </ActionCardTitle>
      <ActionOption
        number={1}
        label="Yes, implement this plan"
        highlighted
        disabled={action.busy}
        onClick={approve}
      />
      <ActionFreeText
        value={typed}
        aria-label="What should change"
        placeholder="No, and tell Brigadier what to do differently"
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && typed.trim() && !action.busy) {
            event.preventDefault();
            reject(typed.trim());
          }
        }}
      />
      {action.error && (
        <p role="alert" className="text-destructive px-1 text-xs">
          {action.error}
        </p>
      )}
      {footer}
    </ActionCard>
  );
}

/** What a card put aside with × leaves on the rail, so it stays one click away. */
export function WaitingReminder({
  count,
  onShow,
}: {
  count: number;
  onShow: () => void;
}) {
  return (
    <div className="text-muted-foreground min-h-row flex items-center gap-2 px-3 text-sm">
      <QuestionMarkCircle className="size-icon-sm shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {count === 1 ? "A decision waits for you" : `${count} decisions wait for you`}
      </span>
      <Button size="xs" variant="ghost" onClick={onShow}>
        Show
      </Button>
    </div>
  );
}
