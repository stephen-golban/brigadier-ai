import { AuiIf, ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUp, PlayTriangle, Stop } from "@openai/apps-sdk-ui/components/Icon";
import { createContext, type FC, useContext } from "react";

import { type ResolvedDraft, updateDraft } from "@/app/conversation/draftSetup";
import {
  BranchPicker,
  ConversationModelPicker,
  ConversationPermissionPicker,
  EnvironmentChip,
  EnvironmentPicker,
  PermissionPicker,
  ProjectPicker,
  ProjectSettingsButton,
} from "@/app/conversation/SetupPickers";
import {
  ComposerAddAttachment,
  ComposerAttachments,
} from "@/components/assistant-ui/elements/attachment";
import {
  ComposerMentions,
  type MentionTarget,
} from "@/components/assistant-ui/elements/composer-mentions";
import { ModelSelector } from "@/components/assistant-ui/elements/model-selector";
import type { ComposerProps } from "@/components/assistant-ui/thread";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import type { Conversation } from "@/ipc/generated";
import { useApp } from "@/state/store";

/** What the composer is attached to: a draft being set up, or a started conversation. */
export type ComposerTarget = {
  conversation: Conversation | null;
  resolved: ResolvedDraft;
  targets: readonly MentionTarget[];
  running: boolean;
  /** Set while the latest request is stopped: continues it (the ▶ send button). */
  onResume: (() => void) | null;
};

export const ComposerTargetContext = createContext<ComposerTarget | null>(null);

/**
 * The composer (assistant-ui composer elements, BB parity): attachments, @-mentions of
 * workers, and the setup pickers. A draft picks its project (or none, for a Chat),
 * environment, branch, permission level and model; a started session can still change its
 * model, effort and permission level, a Chat its model.
 */
export const ConversationComposer: FC<ComposerProps> = ({ autoFocus, placeholder }) => {
  const target = useContext(ComposerTargetContext);
  if (!target) return null;
  const { conversation, resolved, targets } = target;
  const archived = conversation?.lifecycle === "archived";

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <div className="relative w-full">
        {conversation?.kind === "session" && <ComposerMentions targets={targets} />}
        <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col gap-1.5">
          <div
            data-slot="aui_composer-shell"
            className="border-foreground/10 focus-within:border-foreground/25 bg-muted/30 rounded-thread flex w-full cursor-text flex-col gap-2 border p-2 transition-[border-color]"
          >
            <ComposerAttachments />
            <ComposerPrimitive.Input
              placeholder={archived ? "Restore this conversation to continue it." : placeholder}
              className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 min-h-composer max-h-48 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
              rows={1}
              autoFocus={autoFocus}
              enterKeyHint="send"
              aria-label="Message input"
            />
            <div className="flex items-center gap-1">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
                <ComposerAddAttachment />
                {conversation ? (
                  <>
                    <EnvironmentChip conversation={conversation} />
                    <ConversationPermissionPicker conversation={conversation} />
                  </>
                ) : (
                  <DraftPickers resolved={resolved} />
                )}
              </div>
              {conversation ? (
                <ConversationModelPicker conversation={conversation} groups={resolved.groups} />
              ) : (
                <ModelSelector
                  groups={resolved.groups}
                  value={resolved.model}
                  label={resolved.kind === "session" ? "Orchestrator model" : "Model"}
                  onChange={(model) => updateDraft(resolved.project?.id ?? null, { model })}
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

function DraftPickers({ resolved }: { resolved: ResolvedDraft }) {
  const projectId = resolved.project?.id ?? null;
  return (
    <>
      <ProjectPicker project={resolved.project} />
      {resolved.kind === "session" && resolved.repoPath && (
        <>
          <EnvironmentPicker resolved={resolved} />
          <BranchPicker resolved={resolved} />
        </>
      )}
      {resolved.kind === "session" && (
        <PermissionPicker
          value={resolved.permission}
          onChange={(permission) => updateDraft(projectId, { permission })}
        />
      )}
    </>
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
  const sendTip = running
    ? queueEnabled
      ? "Queue message (sends when this turn ends)"
      : "Steer: send into the running turn"
    : "Send message";
  return (
    <div className="flex shrink-0 items-center gap-1">
      <AuiIf condition={(s) => s.composer.canCancel}>
        <ComposerPrimitive.Cancel asChild>
          <TooltipIconButton
            tooltip="Stop the turn"
            side="bottom"
            variant="outline"
            size="icon-md"
            className="rounded-capsule"
          >
            <Stop className="size-icon-sm" />
          </TooltipIconButton>
        </ComposerPrimitive.Cancel>
      </AuiIf>
      {onResume ? (
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
  if (resolved.kind !== "session") return null;
  return (
    <p className="text-muted-foreground px-2 text-xs">
      {permission === "fullAccess" && (
        <span className="text-full-access">
          Full access: workers run without the OS sandbox.{" "}
        </span>
      )}
      {environment === "localCheckout" && repo.info?.dirty
        ? "Your checkout has uncommitted changes; Brigadier will ask whether workers should see them."
        : resolved.repoPath}
    </p>
  );
}
