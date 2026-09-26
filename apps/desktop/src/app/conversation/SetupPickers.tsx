import {
  Check,
  Folder,
  Globe,
  HandRaised,
  Settings as SettingsIcon,
  Terminal,
  Warning,
} from "@openai/apps-sdk-ui/components/Icon";
import { type FC, useRef, useState } from "react";

import { useAction } from "@/app/conversation/useAction";
import { ProjectDialog } from "@/app/dialogs/ProjectDialog";
import {
  ModelSelector,
  type ModelGroup,
} from "@/components/assistant-ui/elements/model-selector";
import { ShieldExclamation, ShieldTerminal } from "@/components/glyphs/permission-glyphs";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  Conversation,
  ModelChoice,
  PermissionLevel,
  Project,
} from "@/ipc/generated";
import { openUrl } from "@/ipc/client";
import {
  FULL_ACCESS_STILL_ASKS,
  PERMISSION_DETAILS,
  PERMISSION_LABELS,
  PERMISSION_LEVELS,
  PERMISSIONS_HELP_URL,
  resolveModel,
} from "@/lib/setup";
import { cn } from "@/lib/utils";
import { updateSetup } from "@/state/actions";
import { useApp } from "@/state/store";
import { toast } from "@/state/toasts";

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
  approveForMe: ShieldTerminal,
  fullAccess: ShieldExclamation,
};

/** Opens the README's section on permission levels in the system browser. */
export function openPermissionsHelp(): void {
  openUrl(PERMISSIONS_HELP_URL).catch((error: unknown) =>
    toast(error instanceof Error ? error.message : String(error), { tone: "error" }),
  );
}

/**
 * ChatGPT's permission pill and menu, opening upward: "How should Brigadier's actions be
 * approved?" with "Learn more", each level with its icon and a one-line summary, a check on
 * the one in use, Full access in orange and confirmed before it turns on. In a narrow composer
 * the pill keeps only its icon.
 */
export function PermissionPicker({
  value,
  onChange,
}: {
  value: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const full = value === "fullAccess";
  const Icon = PERMISSION_ICONS[value];
  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-label="Permission level"
            data-slot="permission-picker"
            className={cn(
              pickerTrigger,
              "rounded-capsule hover:bg-foreground/10 data-[state=open]:bg-foreground/10",
              full && "text-full-access hover:text-full-access data-[state=open]:text-full-access",
            )}
          >
            <Icon />
            <span className="truncate @max-md/composer:hidden">{PERMISSION_LABELS[value]}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          data-slot="permission-menu"
          className="max-w-(--radix-dropdown-menu-content-available-width) p-1.5"
        >
          <div className="flex items-baseline justify-between gap-6 px-2 pt-1 pb-1.5 text-sm">
            <p className="text-muted-foreground">How should Brigadier’s actions be approved?</p>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground shrink-0 underline underline-offset-2"
              onClick={() => {
                setOpen(false);
                openPermissionsHelp();
              }}
            >
              Learn more
            </button>
          </div>
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
              const orange = level === "fullAccess";
              return (
                <DropdownMenuRadioItem
                  key={level}
                  value={level}
                  indicator={<Check className="size-icon-md" />}
                  className={cn(
                    "h-auto gap-3 py-1.5 pe-9",
                    orange && "text-full-access focus:text-full-access",
                  )}
                >
                  <LevelIcon className="size-icon-md" />
                  <span className="flex min-w-0 flex-col">
                    <span>{PERMISSION_LABELS[level]}</span>
                    <span
                      className={cn(
                        "whitespace-nowrap",
                        orange ? "text-full-access" : "text-muted-foreground",
                      )}
                    >
                      {PERMISSION_DETAILS[level]}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <FullAccessDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onChange("fullAccess");
        }}
      />
    </>
  );
}

/** What Full access lets workers do, in the confirmation's card. */
const FULL_ACCESS_POWERS: { icon: FC<{ className?: string }>; tone: string; title: string; line: string }[] = [
  {
    icon: Folder,
    tone: "text-link",
    title: "Files and folders",
    line: "Read, create, modify, or delete files anywhere on this computer",
  },
  {
    icon: Terminal,
    tone: "text-muted-foreground",
    title: "Terminal commands",
    line: "Run commands, install software, and change system settings",
  },
  { icon: Globe, tone: "text-link", title: "Internet", line: "Access websites and send data" },
];

/**
 * ChatGPT's "Turn on Full Access?": what workers could do without the sandbox, what still
 * asks, and the risks. Only Confirm changes the level; Esc or Cancel keeps it.
 */
function FullAccessDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Warning className="size-icon-md" />
            Turn on Full Access?
          </DialogTitle>
          <DialogDescription>
            Brigadier’s workers will be able to run commands, use the internet, and create and
            edit files anywhere on this computer without your permission. This includes but is
            not limited to:
          </DialogDescription>
        </DialogHeader>
        <ul className="bg-foreground/5 rounded-surface divide-foreground/10 divide-y px-3">
          {FULL_ACCESS_POWERS.map(({ icon: PowerIcon, tone, title, line }) => (
            <li key={title} className="flex items-center gap-3 py-2.5">
              <PowerIcon className={cn("size-icon-lg shrink-0", tone)} />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{title}</span>
                <span className="text-muted-foreground text-xs">{line}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">
          {FULL_ACCESS_STILL_ASKS} This comes with risks like loss or exposure of sensitive data
          and prompt injection. You can turn this off.{" "}
          <button type="button" className="text-link hover:underline" onClick={openPermissionsHelp}>
            Learn more
          </button>
        </p>
        <DialogFooter>
          <Button ref={cancel} variant="secondary" className="rounded-capsule" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="ghost"
            className="rounded-capsule bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive"
            onClick={onConfirm}
          >
            <Warning />
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
