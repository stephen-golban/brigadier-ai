import {
  Check,
  ExclamationMarkCircle,
  HandRaised,
  Settings as SettingsIcon,
  SimpleSmile,
} from "@openai/apps-sdk-ui/components/Icon";
import { type FC, useState } from "react";

import { useAction } from "@/app/conversation/useAction";
import { ProjectDialog } from "@/app/dialogs/ProjectDialog";
import {
  ModelSelector,
  type ModelGroup,
} from "@/components/assistant-ui/elements/model-selector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  Conversation,
  ModelChoice,
  PermissionLevel,
  Project,
} from "@/ipc/generated";
import {
  ALWAYS_ASK_NOTE,
  PERMISSION_DETAILS,
  PERMISSION_LABELS,
  PERMISSION_LEVELS,
  resolveModel,
} from "@/lib/setup";
import { cn } from "@/lib/utils";
import { updateSetup } from "@/state/actions";
import { useApp } from "@/state/store";

/** Opens a project's settings, for a project that has no repository yet. */
export function ProjectSettingsButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <SettingsIcon />
        Project settings
      </Button>
      <ProjectDialog open={open} onOpenChange={setOpen} project={project} />
    </>
  );
}

const pickerTrigger = "text-muted-foreground min-w-0 max-w-xs justify-between";

// ----- permission ------------------------------------------------------------------------

const PERMISSION_ICONS: Record<PermissionLevel, FC<{ className?: string }>> = {
  askForApproval: HandRaised,
  approveForMe: SimpleSmile,
  fullAccess: ExclamationMarkCircle,
};

/**
 * ChatGPT's permission pill and menu: "How should Brigadier's actions be approved?", each
 * level with its icon and what it means, a check on the one in use, Full access in orange and
 * confirmed before it turns on. In a narrow composer the pill keeps only its icon.
 */
export function PermissionPicker({
  value,
  onChange,
}: {
  value: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const full = value === "fullAccess";
  const Icon = PERMISSION_ICONS[value];
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-label="Permission level"
            data-slot="permission-picker"
            className={cn(pickerTrigger, full && "text-full-access hover:text-full-access")}
          >
            <Icon />
            <span className="truncate @max-md/composer:hidden">{PERMISSION_LABELS[value]}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-sm">
          <p className="text-muted-foreground px-2 py-1.5 text-sm">
            How should Brigadier’s actions be approved?
          </p>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              const level = next as PermissionLevel;
              if (level === "fullAccess" && !full) setConfirming(true);
              else onChange(level);
            }}
          >
            {PERMISSION_LEVELS.map((level) => {
              const LevelIcon = PERMISSION_ICONS[level];
              return (
                <DropdownMenuRadioItem
                  key={level}
                  value={level}
                  indicator={<Check className="size-icon-md" />}
                  className={cn("items-start gap-2", level === "fullAccess" && "text-full-access")}
                >
                  <LevelIcon className="mt-0.5 size-icon-md shrink-0" />
                  <span className="flex min-w-0 flex-col">
                    <span>{PERMISSION_LABELS[level]}</span>
                    <span
                      className={cn(
                        "text-xs",
                        level === "fullAccess" ? "text-full-access" : "text-muted-foreground",
                      )}
                    >
                      {PERMISSION_DETAILS[level]}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="text-muted-foreground px-2 py-1 text-xs">{ALWAYS_ASK_NOTE}</p>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Turn on full access?</DialogTitle>
            <DialogDescription>
              Workers will run without the OS sandbox: they can read and change any file on your
              computer and use the internet. {ALWAYS_ASK_NOTE}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                onChange("fullAccess");
              }}
            >
              Turn on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ----- model -----------------------------------------------------------------------------

/** Model and effort of a started conversation; changing them updates its setup. */
export function ConversationModelPicker({
  conversation,
  groups,
  open,
  onOpenChange,
}: {
  conversation: Conversation;
  groups: ModelGroup[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const settings = useApp((s) => s.settings);
  const project = useApp((s) =>
    conversation.projectId ? (s.projects[conversation.projectId] ?? null) : null,
  );
  const action = useAction();
  const setup = conversation.setup;
  const current: ModelChoice =
    setup?.type === "session"
      ? setup.orchestrator
      : setup?.type === "chat"
        ? setup.model
        : resolveModel(null, conversation.kind, project, settings, groups);
  // A session created before setups existed gets one on first use; until then it can't change.
  const fixed = setup === null && conversation.kind === "session";

  return (
    <>
      {action.error && (
        <span role="alert" className="text-destructive max-w-xs truncate text-xs" title={action.error}>
          {action.error}
        </span>
      )}
      <ModelSelector
        groups={groups}
        value={current}
        disabled={fixed || action.busy}
        open={open}
        onOpenChange={onOpenChange}
        label={conversation.kind === "session" ? "Orchestrator model" : "Model"}
        onChange={(choice) =>
          action.run(() =>
            updateSetup(
              conversation.id,
              setup?.type === "session"
                ? { ...setup, orchestrator: choice }
                : { type: "chat", model: choice },
            ),
          )
        }
      />
    </>
  );
}

/** Permission level of a started session. */
export function ConversationPermissionPicker({ conversation }: { conversation: Conversation }) {
  const action = useAction();
  const setup = conversation.setup;
  if (setup?.type !== "session") return null;
  return (
    <>
      <PermissionPicker
        value={setup.permission}
        onChange={(permission) =>
          action.run(() => updateSetup(conversation.id, { ...setup, permission }))
        }
      />
      {action.error && (
        <span role="alert" className="text-destructive max-w-xs truncate text-xs" title={action.error}>
          {action.error}
        </span>
      )}
    </>
  );
}
