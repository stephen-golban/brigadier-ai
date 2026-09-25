import { AuiIf, ComposerPrimitive, useAui } from "@assistant-ui/react";
import { ArrowUp, PlayTriangle, Stop } from "@openai/apps-sdk-ui/components/Icon";
import {
  type FC,
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
import { QueueCard, usePullQueued } from "@/app/conversation/QueueCard";
import { StatusCard, StatusCardContext } from "@/app/conversation/StatusCard";
import { ComposerRail, ComposerRailItem } from "@/components/assistant-ui/elements/composer-rail";
import {
  ComposerAddAttachment,
  ComposerAttachments,
} from "@/components/assistant-ui/elements/attachment";
import { ModelSelector } from "@/components/assistant-ui/elements/model-selector";
import { ContextRing } from "@/components/assistant-ui/context-ring";
import type { ComposerProps } from "@/components/assistant-ui/thread";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useBoard } from "@/state/board";
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
  if (!target) return null;
  const { conversation, resolved, targets } = target;
  const archived = conversation?.lifecycle === "archived";

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <div className="group/composer relative w-full">
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
        </ComposerRail>
        <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col gap-1.5">
          {/* ChatGPT's card: lifted, an inner hairline for an edge, and no focus ring. */}
          <div
            data-slot="aui_composer-shell"
            className="@container/composer bg-composer rounded-composer shadow-hairline relative flex w-full cursor-text flex-col gap-1 p-2 backdrop-blur-lg"
          >
            <ComposerAttachments />
            <ComposerInput
              placeholder={archived ? "Restore this conversation to continue it." : placeholder}
              autoFocus={autoFocus}
              running={target.running}
            />
            <div className="flex items-center gap-1">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
                <ComposerAddAttachment />
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
          <ComposerHint target={target} />
        </ComposerPrimitive.Root>
      </div>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

/**
 * The text field: grows with its text up to a quarter of the window, then scrolls, the top
 * line fading under the edge once scrolled. ↑ in an empty field edits the last queued message;
 * ⌘Enter while the model works does the opposite of the queueing setting, for this message.
 */
function ComposerInput({
  placeholder,
  autoFocus,
  running,
}: {
  placeholder: string;
  autoFocus: boolean;
  running: boolean;
}) {
  const [scrolled, setScrolled] = useState(false);
  const aui = useAui();
  const pull = usePullQueued();
  const queueEnabled = useApp((s) => s.settings.queueEnabled);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const composer = aui.composer();
    if (event.key === "ArrowUp" && pull && composer.getState().isEmpty) {
      event.preventDefault();
      void pull(-1);
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
  return (
    <ComposerPrimitive.Input
      placeholder={placeholder}
      data-scrolled={scrolled || undefined}
      onKeyDown={onKeyDown}
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
      className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 min-h-composer max-h-composer-max data-scrolled:mask-fade-top w-full resize-none bg-transparent px-2 py-2.5 text-base outline-none"
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

function SendControls({
  running,
  onResume,
}: {
  running: boolean;
  onResume: (() => void) | null;
}) {
  const queueEnabled = useApp((s) => s.settings.queueEnabled);
  const sendTip = running ? (queueEnabled ? "Queue" : "Steer") : "Send message";
  // One button, as ChatGPT's: ■ while the model works and nothing is typed, ↑ to send (or
  // steer, or queue), ▶ to resume a stopped request.
  return (
    <div className="flex shrink-0 items-center gap-1">
      <AuiIf condition={(s) => s.composer.canCancel && s.composer.isEmpty}>
        <ComposerPrimitive.Cancel asChild>
          <TooltipIconButton
            tooltip="Stop"
            side="bottom"
            variant="default"
            size="icon-md"
            className="rounded-capsule"
          >
            <Stop className="size-icon-sm" />
          </TooltipIconButton>
        </ComposerPrimitive.Cancel>
      </AuiIf>
      {running ? (
        <AuiIf condition={(s) => !s.composer.isEmpty}>
          <SendButton tooltip={sendTip} />
        </AuiIf>
      ) : onResume ? (
        <>
          <AuiIf condition={(s) => s.composer.isEmpty}>
            <TooltipIconButton
              tooltip="Resume"
              side="bottom"
              type="button"
              variant="default"
              size="icon-md"
              className="rounded-capsule"
              onClick={onResume}
            >
              <PlayTriangle />
            </TooltipIconButton>
          </AuiIf>
          <AuiIf condition={(s) => !s.composer.isEmpty}>
            <SendButton tooltip={sendTip} />
          </AuiIf>
        </>
      ) : (
        <SendButton tooltip={sendTip} />
      )}
    </div>
  );
}

function SendButton({ tooltip }: { tooltip: string }) {
  return (
    <ComposerPrimitive.Send asChild>
      <TooltipIconButton
        tooltip={tooltip}
        side="bottom"
        type="button"
        variant="default"
        size="icon-md"
        className="aui-composer-send rounded-capsule"
      >
        <ArrowUp />
      </TooltipIconButton>
    </ComposerPrimitive.Send>
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
