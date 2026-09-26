import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  ArrowUp,
  Mic,
  PlayTriangle,
  Spin,
  Stop,
  Warning,
  X,
} from "@openai/apps-sdk-ui/components/Icon";
import {
  type FC,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { type ResolvedDraft, updateDraft } from "@/app/conversation/draftSetup";
import { BranchPopover, ProjectCombobox, WorkInMenu } from "@/app/conversation/RailPickers";
import {
  ConversationModelPicker,
  ConversationPermissionPicker,
  PermissionPicker,
  ProjectSettingsButton,
} from "@/app/conversation/SetupPickers";
import type { ComposerInputProps } from "@/app/conversation/ComposerEditor";
import { type MentionMemory, Mentions } from "@/app/conversation/Mentions";
import { SlashCommands } from "@/app/conversation/SlashCommands";
import { BackgroundWorkers } from "@/app/conversation/BackgroundWorkers";
import {
  COMPOSER_EDITABLE,
  type ComposerTarget,
  ComposerTargetContext,
} from "@/app/conversation/composerTarget";
import { PendingActionCard, usePendingActions, WaitingReminder } from "@/app/conversation/ActionCards";
import { QueueCard } from "@/app/conversation/QueueCard";
import { useComposerDraft } from "@/app/conversation/composerDraft";
import type { BlobAttachmentAdapter } from "@/app/conversation/attachments";
import { StatusCard, StatusCardContext } from "@/app/conversation/StatusCard";
import { PLAN_PLACEHOLDER, PlanChip, PlusMenu, usePlanMode } from "@/app/conversation/PlusMenu";
import { ViewContext } from "@/app/conversation/viewContext";
import { ComposerRail, ComposerRailItem } from "@/components/assistant-ui/elements/composer-rail";
import { ComposerAttachments } from "@/components/assistant-ui/elements/attachment";
import { ModelSelector } from "@/components/assistant-ui/elements/model-selector";
import { ContextRing } from "@/components/assistant-ui/context-ring";
import type { ComposerProps } from "@/components/assistant-ui/thread";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useBoard } from "@/state/board";
import {
  cancelDictation,
  type DictationPhase,
  startDictation,
  stopDictation,
  useDictation,
} from "@/state/dictation";
import { NEW_CHAT_SCOPE } from "@/state/drafts";
import { useApp } from "@/state/store";


const ComposerEditor = lazy(() => import("@/app/conversation/ComposerEditor"));

/**
 * The composer (assistant-ui composer elements, BB parity): attachments, @-mentions of
 * workers, files and conversations, ChatGPT's `/` commands, and the setup pickers. A draft picks its project (or none, for a Chat),
 * environment, branch, permission level and model; a started session can still change its
 * model, effort and permission level, a Chat its model.
 */
export const ConversationComposer: FC<ComposerProps> = ({ autoFocus, placeholder }) => {
  const target = useContext(ComposerTargetContext);
  const [modelOpen, setModelOpen] = useState(false);
  const statusCard = useContext(StatusCardContext);
  const pending = usePendingActions(target?.conversation ?? null);
  const plan = usePlanMode(target);
  // Cards put aside with ×, for the conversation they belong to.
  const [aside, setAside] = useState<{ conversationId: string | null; ids: string[] }>({
    conversationId: null,
    ids: [],
  });
  if (!target) return null;
  const { conversation, resolved, targets } = target;
  const archived = conversation?.lifecycle === "archived";
  const dictationOwner = conversation?.id ?? NEW_CHAT_SCOPE;
  const putAside = aside.conversationId === (conversation?.id ?? null) ? aside.ids : [];
  const waiting = pending.filter((entry) => !putAside.includes(entry.id));
  const current = archived ? undefined : waiting[0];
  const setAsideIds = (ids: string[]) => setAside({ conversationId: conversation?.id ?? null, ids });

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      {!archived && (
        <ComposerDraft
          scope={conversation?.id ?? NEW_CHAT_SCOPE}
          attachments={target.queue.attachments}
          memory={target.mentions}
        />
      )}
      <div data-slot="composer" className="group/composer relative w-full">
        {conversation && (
          <Mentions conversation={conversation} targets={targets} />
        )}
        <SlashCommands
          conversation={conversation}
          groups={resolved.groups}
          onOpenModel={() => setModelOpen(true)}
        />
        {/* Hidden, not unmounted, while the slash menu is open over it, as ChatGPT's is. */}
        <ComposerRail className="transition-[opacity,visibility] group-has-[[data-slot=composer-commands]]/composer:invisible group-has-[[data-slot=composer-commands]]/composer:opacity-0">
          {!conversation && <UtilityBar resolved={resolved} />}
          {/* ChatGPT's order: /status on top, then the cards below it. */}
          {conversation && statusCard.open && (
            <StatusCard conversationId={conversation.id} onClose={() => statusCard.setOpen(false)} />
          )}
          {conversation && !archived && <QueueCard conversationId={conversation.id} />}
          {conversation?.kind === "session" && !archived && (
            <BackgroundWorkers conversationId={conversation.id} />
          )}
          {pending.length > waiting.length && !archived && (
            <ComposerRailItem label="Waiting for you">
              <WaitingReminder count={pending.length - waiting.length} onShow={() => setAsideIds([])} />
            </ComposerRailItem>
          )}
        </ComposerRail>
        <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col gap-1.5">
          {current ? (
            <PendingActionCard
              action={current}
              more={waiting.length - 1}
              onDismiss={() => setAsideIds([...putAside, current.id])}
              message={
                // The user can always talk to the orchestrator; this steers or queues as usual,
                // with the draft's attachments in view.
                <div className="border-foreground/10 flex flex-col gap-1 border-t pt-2">
                  <ComposerAttachments />
                  <div className="flex items-center gap-1">
                    <ComposerInput placeholder="Message Brigadier" autoFocus={false} running={target.running} line />
                    <SendControls running={target.running} onResume={target.onResume} />
                  </div>
                </div>
              }
            />
          ) : (
          /* ChatGPT's card: lifted, an inner hairline for an edge, and no focus ring. */
          <div
            data-slot="aui_composer-shell"
            className="@container/composer bg-composer rounded-composer shadow-hairline relative flex w-full cursor-text flex-col gap-1 p-2 backdrop-blur-lg"
          >
            <ComposerAttachments />
            <ComposerInput
              placeholder={
                archived
                  ? "Restore this conversation to continue it."
                  : plan.on
                    ? PLAN_PLACEHOLDER
                    : placeholder
              }
              autoFocus={autoFocus}
              running={target.running}
            />
            <ComposerFooter owner={dictationOwner}>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
                <PlusMenu />
                {conversation ? (
                  <ConversationPermissionPicker conversation={conversation} />
                ) : (
                  resolved.kind === "session" && (
                    <PermissionPicker
                      value={resolved.permission}
                      onChange={(permission) =>
                        updateDraft(resolved.project?.id ?? null, { permission })
                      }
                    />
                  )
                )}
                <PlanChip />
              </div>
              {conversation && <ComposerContextRing />}
              {conversation ? (
                <ConversationModelPicker
                  conversation={conversation}
                  groups={resolved.groups}
                  open={modelOpen}
                  onOpenChange={setModelOpen}
                />
              ) : (
                <ModelSelector
                  groups={resolved.groups}
                  value={resolved.model}
                  label={resolved.kind === "session" ? "Orchestrator model" : "Model"}
                  onChange={(model) => updateDraft(resolved.project?.id ?? null, { model })}
                  open={modelOpen}
                  onOpenChange={setModelOpen}
                />
              )}
              <SendControls running={target.running} onResume={target.onResume} />
            </ComposerFooter>
          </div>
          )}
          <ComposerHint target={target} />
        </ComposerPrimitive.Root>
      </div>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

/** Keeps the composer's draft for its conversation (or the new chat). */
function ComposerDraft({
  scope,
  attachments,
  memory,
}: {
  scope: string;
  attachments: BlobAttachmentAdapter;
  memory: MentionMemory;
}) {
  useComposerDraft(scope, attachments, memory);
  return null;
}

/**
 * The text field: assistant-ui's Lexical input with ChatGPT's chips (its own chunk, so it
 * doesn't hold up the first paint), a plain field on the same composer text until it loads.
 */
function ComposerInput(props: ComposerInputProps) {
  const { placeholder, autoFocus, line = false } = props;
  return (
    <Suspense
      fallback={
        <ComposerPrimitive.Input
          placeholder={placeholder}
          autoFocus={autoFocus}
          cancelOnEscape={false}
          rows={1}
          aria-label="Message input"
          className={cn(
            "aui-composer-input caret-primary placeholder:text-muted-foreground/60 w-full resize-none bg-transparent outline-none",
            line
              ? "min-h-control-md max-h-control-md px-1 py-1.5 text-sm"
              : "min-h-composer max-h-composer-max px-2 py-2.5 text-base",
          )}
        />
      }
    >
      <ComposerEditor {...props} />
    </Suspense>
  );
}

/** The context ring left of the model picker, once the model has said how full it is. */
function ComposerContextRing() {
  const show = useApp((s) => s.settings.showContextUsage);
  const usage = useBoard((s) => s.board?.context ?? null);
  if (!show || !usage) return null;
  return <ContextRing usage={usage} />;
}

/** Whether a sideways-scrolling row has more past its right edge. */
function overflowsEnd(element: HTMLElement): boolean {
  return element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
}

/**
 * The rail's utility bar on a new chat: project, where the session works and its branch.
 * It scrolls sideways, fading at the edge, when the composer is too narrow.
 */
function UtilityBar({ resolved }: { resolved: ResolvedDraft }) {
  const [overflowing, setOverflowing] = useState(false);
  const bar = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setOverflowing(overflowsEnd(element)));
    // The bar's own width and its row's, which grows with the pills' text.
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <ComposerRailItem variant="controls" label="Composer utility bar">
      <div
        ref={bar}
        onScroll={(event) => setOverflowing(overflowsEnd(event.currentTarget))}
        data-overflowing={overflowing || undefined}
        className="data-overflowing:mask-fade-end hide-scrollbar overflow-x-auto px-1 py-1.25"
      >
        <div className="flex w-max items-center gap-2">
          <ProjectCombobox project={resolved.project} />
          {resolved.kind === "session" && resolved.repoPath && (
            <>
              <WorkInMenu resolved={resolved} />
              <BranchPopover resolved={resolved} />
            </>
          )}
        </div>
      </div>
    </ComposerRailItem>
  );
}

/** A second Esc within this long stops the model (the first one arms the button). */
const ESC_WINDOW_MS = 2000;

/**
 * ChatGPT's two-press stop: the first Esc outside menus and cards arms the send button
 * (it reads "Esc"), a second within two seconds stops the model. Esc in the composer also
 * leaves the field, keeping the text.
 */
function useEscToStop(canCancel: boolean): boolean {
  const aui = useAui();
  const { embedded } = useContext(ViewContext);
  const [armedAt, setArmedAt] = useState<number | null>(null);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // A side chat's Esc is its own; the conversation beside it takes the rest.
      const inSideChat =
        event.target instanceof Element && event.target.closest("[data-embedded-view]") !== null;
      if (inSideChat !== embedded) return;
      // Menus, dialogs and the composer's own popovers take their Esc first.
      if (document.querySelector("[role=dialog], [role=menu], [role=listbox], [data-slot=composer-commands], [data-slot=composer-mentions]")) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches(COMPOSER_EDITABLE)) active.blur();
      if (!canCancel) return;
      const now = event.timeStamp;
      if (armedAt !== null && now - armedAt < ESC_WINDOW_MS) {
        setArmedAt(null);
        aui.composer().cancel();
      } else {
        setArmedAt(now);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [aui, canCancel, armedAt, embedded]);
  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), ESC_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);
  return armedAt !== null && canCancel;
}

type SendState = "starting" | "armed" | "stop" | "steer" | "queue" | "resume" | "send";

const SEND_TIPS: Record<SendState, string> = {
  starting: "Starting your task…",
  armed: "Press Esc again to stop",
  stop: "Stop",
  steer: "Steer",
  queue: "Queue",
  resume: "Resume",
  send: "Send message",
};

/**
 * ChatGPT's one send button, which changes with the state: ↑ to send (its tip "Steer" or
 * "Queue" while the model works), ■ to stop, "Esc" once armed, ▶ to resume a stopped
 * request, and a grey spinner while the conversation's model starts.
 */
function SendControls({
  running,
  onResume,
}: {
  running: boolean;
  onResume: (() => void) | null;
}) {
  const target = useContext(ComposerTargetContext);
  const conversationId = target?.conversation?.id ?? null;
  const queueEnabled = useApp((s) => s.settings.queueEnabled);
  const starting = useBoard(
    (s) => !!conversationId && s.board?.conversationId === conversationId && s.board.run === "starting",
  );
  const empty = useAuiState((s) => s.composer.isEmpty);
  const canCancel = useAuiState((s) => s.composer.canCancel);
  const armed = useEscToStop(canCancel);
  const dictationOwner = conversationId ?? NEW_CHAT_SCOPE;
  const dictation = useDictation(dictationOwner);
  const state: SendState =
    armed
      ? "armed"
      : canCancel && empty
        ? starting
          ? "starting"
          : "stop"
        : running && !empty
          ? queueEnabled
            ? "queue"
            : "steer"
          : !running && empty && onResume
            ? "resume"
            : "send";
  const button = (
    <TooltipIconButton
      tooltip={SEND_TIPS[state]}
      side="bottom"
      type="button"
      variant={state === "starting" ? "secondary" : "default"}
      size="icon-md"
      data-state={state}
      className={cn("aui-composer-send rounded-capsule", state === "armed" && "w-auto px-2 text-xs")}
      onClick={state === "resume" ? (onResume ?? undefined) : undefined}
    >
      {/* Keyed by state, so each glyph eases in as the button changes. */}
      <span key={state} className="animate-in fade-in zoom-in-75 flex items-center duration-200 motion-reduce:animate-none">
        {state === "starting" ? (
          <Spin className="size-icon-sm animate-spin motion-reduce:animate-none" />
        ) : state === "armed" ? (
          "Esc"
        ) : state === "stop" ? (
          <Stop className="size-icon-sm" />
        ) : state === "resume" ? (
          <PlayTriangle />
        ) : (
          <ArrowUp />
        )}
      </span>
    </TooltipIconButton>
  );
  // The one-line field under an action card has no footer to give over to dictation.
  if (dictationActive(dictation.phase)) return <DictationBar owner={dictationOwner} compact />;
  // Idle and empty, the send button's place is the microphone's (ChatGPT's voice button).
  if (state === "send" && empty && dictation.available) {
    const failed = dictation.phase.type === "failed" ? dictation.phase.message : null;
    return (
      <div className="flex shrink-0 items-center gap-1">
        <TooltipIconButton
          tooltip={failed ? `Retry dictation: ${failed}` : "Dictate"}
          side="bottom"
          type="button"
          variant="default"
          size="icon-md"
          data-state={failed ? "retry-dictation" : "dictate"}
          className="aui-composer-dictate rounded-capsule"
          onClick={() => void startDictation(dictationOwner)}
        >
          <span
            key={failed ? "retry" : "dictate"}
            className="animate-in fade-in zoom-in-75 flex items-center duration-200 motion-reduce:animate-none"
          >
            {failed ? <Warning className="size-icon-sm" /> : <Mic className="size-icon-sm" />}
          </span>
        </TooltipIconButton>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      {state === "resume" ? (
        button
      ) : state === "starting" || state === "armed" || state === "stop" ? (
        <ComposerPrimitive.Cancel asChild>{button}</ComposerPrimitive.Cancel>
      ) : (
        <ComposerPrimitive.Send asChild>{button}</ComposerPrimitive.Send>
      )}
    </div>
  );
}

function dictationActive(phase: DictationPhase): boolean {
  return phase.type !== "idle" && phase.type !== "failed";
}

/** The composer's footer row; while dictating, ChatGPT's dictation controls take all of it. */
function ComposerFooter({ owner, children }: { owner: string; children: ReactNode }) {
  const { phase } = useDictation(owner);
  return (
    <div className="flex items-center gap-1">
      {dictationActive(phase) ? <DictationBar owner={owner} /> : children}
    </div>
  );
}

/**
 * Dictation under way (ChatGPT's): Cancel, then the microphone's waveform while it records,
 * Stop (the text goes to the caret) and "Transcribe and send"; a line saying what happens
 * while the speech model downloads, the microphone opens or the text is worked out.
 */
function DictationBar({ owner, compact = false }: { owner: string; compact?: boolean }) {
  const aui = useAui();
  const { phase, levels } = useDictation(owner);
  const note =
    phase.type === "downloading"
      ? `Downloading the speech model${phase.total > 0 ? ` · ${Math.floor((phase.received / phase.total) * 100)}%` : "…"}`
      : phase.type === "starting"
        ? "Starting dictation…"
        : phase.type === "transcribing"
          ? "Transcribing…"
          : null;
  return (
    <div
      data-slot="composer-dictation"
      data-phase={phase.type}
      className={cn("flex min-w-0 items-center gap-1", compact ? "shrink-0" : "flex-1")}
    >
      {phase.type !== "transcribing" && (
        <TooltipIconButton
          tooltip={phase.type === "downloading" ? "Cancel download" : "Cancel dictation"}
          side="bottom"
          type="button"
          size="icon-md"
          className="rounded-capsule"
          onClick={cancelDictation}
        >
          <X className="size-icon-sm" />
        </TooltipIconButton>
      )}
      {phase.type === "recording" ? (
        <div
          aria-hidden
          className={cn(
            "flex h-7 min-w-0 items-center justify-end gap-0.5 overflow-hidden px-1",
            compact ? "w-24" : "flex-1",
          )}
        >
          {levels.map((level, index) => (
            <span
              // Bars shift left as new ones arrive; their place is their identity.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className="bg-foreground w-0.5 shrink-0 rounded-full"
              style={{ height: `${Math.max(2, Math.round(level * 24))}px` }}
            />
          ))}
        </div>
      ) : (
        <span className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-sm">{note}</span>
      )}
      {phase.type === "recording" ? (
        <>
          <TooltipIconButton
            tooltip="Stop dictation"
            side="bottom"
            type="button"
            size="icon-md"
            className="rounded-capsule"
            onClick={() => void stopDictation()}
          >
            <Stop className="size-icon-sm" />
          </TooltipIconButton>
          <TooltipIconButton
            tooltip="Transcribe and send"
            side="bottom"
            type="button"
            variant="default"
            size="icon-md"
            className="rounded-capsule"
            onClick={() => void stopDictation(() => aui.composer().send())}
          >
            <ArrowUp />
          </TooltipIconButton>
        </>
      ) : (
        <TooltipIconButton
          tooltip={note ?? ""}
          side="bottom"
          type="button"
          variant="secondary"
          size="icon-md"
          className="rounded-capsule"
          disabled
        >
          <Spin className="size-icon-sm animate-spin motion-reduce:animate-none" />
        </TooltipIconButton>
      )}
    </div>
  );
}

/** One line under the composer: what blocks sending, or what the setup implies. */
function ComposerHint({ target }: { target: ComposerTarget }) {
  const { conversation, resolved } = target;
  if (conversation) return null;
  const { project, problem, repo, environment, permission } = resolved;
  if (problem) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 px-2 text-xs">
        {problem}
        {project && !resolved.repoPath && <ProjectSettingsButton project={project} />}
        {repo.error && resolved.kind === "session" && (
          <span className="text-destructive">{repo.error}</span>
        )}
      </p>
    );
  }
  const dirty = environment === "localCheckout" && repo.info?.dirty;
  if (resolved.kind !== "session" || (permission !== "fullAccess" && !dirty)) return null;
  return (
    <p className="text-muted-foreground px-2 text-xs">
      {permission === "fullAccess" && (
        <span className="text-full-access">
          Full access: workers run without the OS sandbox.{" "}
        </span>
      )}
      {environment === "localCheckout" &&
        repo.info?.dirty &&
        "Your checkout has uncommitted changes; Brigadier will ask whether workers should see them."}
    </p>
  );
}
