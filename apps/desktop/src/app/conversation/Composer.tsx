import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, PlayTriangle, Spin, Stop } from "@openai/apps-sdk-ui/components/Icon";
import {
  type FC,
  type ClipboardEvent,
  type KeyboardEvent,
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
import { Mentions } from "@/app/conversation/Mentions";
import { SlashCommands } from "@/app/conversation/SlashCommands";
import { BackgroundWorkers } from "@/app/conversation/BackgroundWorkers";
import { type ComposerTarget, ComposerTargetContext } from "@/app/conversation/composerTarget";
import { PendingActionCard, usePendingActions, WaitingReminder } from "@/app/conversation/ActionCards";
import { QueueCard, usePullQueued } from "@/app/conversation/QueueCard";
import { usePromptHistory, useComposerDraft } from "@/app/conversation/composerDraft";
import type { BlobAttachmentAdapter } from "@/app/conversation/attachments";
import { StatusCard, StatusCardContext } from "@/app/conversation/StatusCard";
import { PLAN_PLACEHOLDER, PlanChip, PlusMenu, usePlanMode } from "@/app/conversation/PlusMenu";
import { ComposerRail, ComposerRailItem } from "@/components/assistant-ui/elements/composer-rail";
import { ComposerAttachments } from "@/components/assistant-ui/elements/attachment";
import {
  PASTE_AS_ATTACHMENT_CHARS,
  PASTED_TEXT_NAME,
} from "@/components/assistant-ui/elements/attachment-tile";
import { ModelSelector } from "@/components/assistant-ui/elements/model-selector";
import { ContextRing } from "@/components/assistant-ui/context-ring";
import type { ComposerProps } from "@/components/assistant-ui/thread";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useBoard } from "@/state/board";
import { NEW_CHAT_SCOPE } from "@/state/drafts";
import { useApp } from "@/state/store";


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
        />
      )}
      <div data-slot="composer" className="group/composer relative w-full">
        {conversation && (
          <Mentions conversation={conversation} targets={targets} memory={target.mentions} />
        )}
        <SlashCommands conversation={conversation} onOpenModel={() => setModelOpen(true)} />
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
                // The user can always talk to the orchestrator; this steers or queues as usual.
                <div className="border-foreground/10 flex items-center gap-1 border-t pt-2">
                  <ComposerInput placeholder="Message Brigadier" autoFocus={false} running={target.running} line />
                  <SendControls running={target.running} onResume={target.onResume} />
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
            <div className="flex items-center gap-1">
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
            </div>
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
}: {
  scope: string;
  attachments: BlobAttachmentAdapter;
}) {
  useComposerDraft(scope, attachments);
  return null;
}

/**
 * The text field: grows with its text up to a quarter of the window, then scrolls, the top
 * line fading under the edge once scrolled. ↑ in an empty field edits the last queued message,
 * else walks back through the conversation's prompts (↓ forward); ⌘Enter while the model
 * works does the opposite of the queueing setting, for this message.
 */
function ComposerInput({
  placeholder,
  autoFocus,
  running,
  line = false,
}: {
  placeholder: string;
  autoFocus: boolean;
  running: boolean;
  /** One line (under an action card): it doesn't grow, it scrolls. */
  line?: boolean;
}) {
  const [scrolled, setScrolled] = useState(false);
  const aui = useAui();
  const pull = usePullQueued();
  const history = usePromptHistory();
  const queueEnabled = useApp((s) => s.settings.queueEnabled);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const composer = aui.composer();
    if (event.key === "ArrowUp" && pull && composer.getState().isEmpty) {
      event.preventDefault();
      void pull(-1);
    } else if (history(event)) {
      event.preventDefault();
    } else if (
      event.key === "Enter" &&
      event.metaKey &&
      !event.shiftKey &&
      running &&
      composer.getState().canSend
    ) {
      event.preventDefault();
      // Queueing on: this one steers; off: this one queues.
      composer.send({ steer: queueEnabled });
    }
  };
  // A long paste becomes a "Pasted text" attachment, as ChatGPT does; files are aui's.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (event.clipboardData.files.length > 0 || text.length < PASTE_AS_ATTACHMENT_CHARS) return;
    event.preventDefault();
    const file = new File([text], PASTED_TEXT_NAME, { type: "text/plain" });
    void aui.composer().addAttachment(file);
  };
  return (
    <ComposerPrimitive.Input
      placeholder={placeholder}
      data-scrolled={scrolled || undefined}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      // Esc stops only on a second press (useEscToStop), as ChatGPT's does.
      cancelOnEscape={false}
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
      className={cn(
        "aui-composer-input caret-primary placeholder:text-muted-foreground/60 w-full resize-none bg-transparent text-base outline-none",
        line
          ? "min-h-control-md max-h-control-md px-1 py-1.5 text-sm"
          : "min-h-composer max-h-composer-max data-scrolled:mask-fade-top px-2 py-2.5",
      )}
      rows={1}
      autoFocus={autoFocus}
      enterKeyHint="send"
      aria-label="Message input"
    />
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
  const [armedAt, setArmedAt] = useState<number | null>(null);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // Menus, dialogs and the composer's own popovers take their Esc first.
      if (document.querySelector("[role=dialog], [role=menu], [role=listbox], [data-slot=composer-commands], [data-slot=composer-mentions]")) return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && active.classList.contains("aui-composer-input")) active.blur();
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
  }, [aui, canCancel, armedAt]);
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
