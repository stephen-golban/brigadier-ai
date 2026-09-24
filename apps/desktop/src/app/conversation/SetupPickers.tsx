import {
  Branch,
  ChevronDown,
  Folder,
  FolderPlus,
  Settings as SettingsIcon,
  ShieldCheck,
  Warning,
} from "@openai/apps-sdk-ui/components/Icon";
import { type ReactNode, useState } from "react";

import { type ResolvedDraft, updateDraft } from "@/app/conversation/draftSetup";
import { useAction } from "@/app/conversation/useAction";
import { ProjectDialog } from "@/app/dialogs/ProjectDialog";
import { NameDialog } from "@/app/NameDialog";
import {
  ModelSelector,
  type ModelGroup,
} from "@/components/assistant-ui/elements/model-selector";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  Conversation,
  EnvironmentKind,
  ModelChoice,
  PermissionLevel,
  Project,
  RepoInfo,
} from "@/ipc/generated";
import {
  ALWAYS_ASK_NOTE,
  environmentLabel,
  PERMISSION_DETAILS,
  PERMISSION_LABELS,
  PERMISSION_LEVELS,
  resolveModel,
} from "@/lib/setup";
import { cn } from "@/lib/utils";
import { select, updateSetup } from "@/state/actions";
import { useApp } from "@/state/store";

const pickerTrigger = "text-muted-foreground min-w-0 max-w-xs justify-between";

function PickerTrigger({
  label,
  icon,
  text,
  className,
  disabled,
}: {
  label: string;
  icon?: ReactNode;
  text: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size="xs"
        aria-label={label}
        disabled={disabled}
        className={cn(pickerTrigger, className)}
      >
        {icon}
        <span className="truncate">{text}</span>
        <ChevronDown />
      </Button>
    </DropdownMenuTrigger>
  );
}

// ----- project ---------------------------------------------------------------------------

/** "No project" makes the draft a Chat; a project makes it a session in that project. */
export function ProjectPicker({ project }: { project: Project | null }) {
  const projects = useApp((s) => s.projects);
  const [creating, setCreating] = useState(false);
  const sorted = Object.values(projects).toSorted((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <DropdownMenu modal={false}>
        <PickerTrigger
          label="Project"
          icon={<Folder />}
          text={project ? project.name : "No project"}
        />
        <DropdownMenuContent align="start" className="max-w-sm">
          <DropdownMenuRadioGroup
            value={project?.id ?? ""}
            onValueChange={(id) =>
              select(id ? { type: "draft", kind: "session", projectId: id } : { type: "draft", kind: "chat" })
            }
          >
            <DropdownMenuRadioItem value="">
              <span className="flex flex-col">
                <span>No project</span>
                <span className="text-muted-foreground text-xs">A Chat with the model you pick</span>
              </span>
            </DropdownMenuRadioItem>
            {sorted.length > 0 && <DropdownMenuSeparator />}
            {sorted.map((entry) => (
              <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{entry.name}</span>
                  {entry.repos[0] && (
                    <span className="text-muted-foreground truncate font-mono text-xs">
                      {entry.repos[0].path}
                    </span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <FolderPlus />
            New project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(created) => select({ type: "draft", kind: "session", projectId: created.id })}
      />
    </>
  );
}

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

// ----- environment and branches ----------------------------------------------------------

const ENVIRONMENTS: Record<EnvironmentKind, { label: string; detail: string }> = {
  localCheckout: {
    label: "Local checkout",
    detail: "Reviewed commits land on the branch you pick, in your own checkout.",
  },
  newWorktree: {
    label: "New worktree",
    detail: "A new session branch in its own worktree, merged into the base on your go-ahead.",
  },
};

export function EnvironmentPicker({ resolved }: { resolved: ResolvedDraft }) {
  const projectId = resolved.project?.id ?? null;
  return (
    <DropdownMenu modal={false}>
      <PickerTrigger label="Environment" text={ENVIRONMENTS[resolved.environment].label} />
      <DropdownMenuContent align="start" className="max-w-sm">
        <DropdownMenuRadioGroup
          value={resolved.environment}
          onValueChange={(value) =>
            updateDraft(projectId, { environment: value as EnvironmentKind })
          }
        >
          {(Object.keys(ENVIRONMENTS) as EnvironmentKind[]).map((kind) => (
            <DropdownMenuRadioItem key={kind} value={kind}>
              <span className="flex flex-col">
                <span>{ENVIRONMENTS[kind].label}</span>
                <span className="text-muted-foreground text-xs">{ENVIRONMENTS[kind].detail}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function branchHint(info: RepoInfo, checkedOutAt: string | null, name: string): string | null {
  if (name === info.currentBranch) return "checked out here";
  if (checkedOutAt && checkedOutAt !== info.path) return "in another worktree";
  return null;
}

type BranchDialog = "new" | "type" | "session" | null;

/**
 * The branch picker: the repository's branches, "New branch…" (local checkout), a typed name
 * for scripted use, and the session branch's name (new worktree).
 */
export function BranchPicker({ resolved }: { resolved: ResolvedDraft }) {
  const [dialog, setDialog] = useState<BranchDialog>(null);
  const projectId = resolved.project?.id ?? null;
  const { info, error, loading } = resolved.repo;
  const local = resolved.environment === "localCheckout";
  const value = local ? (resolved.draft.branch ?? info?.currentBranch ?? "") : (resolved.base ?? "");
  const shown = local
    ? resolved.draft.newBranch
      ? `${resolved.draft.newBranch} (new, from ${value})`
      : value || "Pick a branch"
    : `${resolved.draft.sessionBranch.trim() || "brigadier/…"} from ${value || "?"}`;

  const pick = (name: string) =>
    updateDraft(projectId, local ? { branch: name, newBranch: null } : { base: name });

  return (
    <>
      <DropdownMenu modal={false}>
        <PickerTrigger label={local ? "Branch" : "Base branch"} icon={<Branch />} text={shown} />
        <DropdownMenuContent align="start" className="max-h-(--radix-dropdown-menu-content-available-height) max-w-sm overflow-y-auto">
          <DropdownMenuLabel className="text-muted-foreground text-xs">
            {local ? "Commits land on" : "Session branch starts from"}
          </DropdownMenuLabel>
          {loading && !info && <p className="text-muted-foreground px-2 py-1 text-xs">Reading the repository…</p>}
          {error && (
            <p role="alert" className="text-destructive max-w-xs px-2 py-1 text-xs">
              Branches unavailable: {error}
            </p>
          )}
          {info && (
            <DropdownMenuRadioGroup value={value} onValueChange={pick}>
              {info.branches.map((entry) => {
                const hint = branchHint(info, entry.checkedOutAt, entry.name);
                return (
                  <DropdownMenuRadioItem key={entry.name} value={entry.name}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-xs">{entry.name}</span>
                      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          )}
          <DropdownMenuSeparator />
          {local && (
            <DropdownMenuItem onSelect={() => setDialog("new")} disabled={!value}>
              New branch…
            </DropdownMenuItem>
          )}
          {local && resolved.draft.newBranch && (
            <DropdownMenuItem onSelect={() => updateDraft(projectId, { newBranch: null })}>
              Don't create a new branch
            </DropdownMenuItem>
          )}
          {!local && (
            <DropdownMenuItem onSelect={() => setDialog("session")}>
              Name the session branch…
            </DropdownMenuItem>
          )}
          {!local && resolved.draft.sessionBranch.trim() && (
            <DropdownMenuItem onSelect={() => updateDraft(projectId, { sessionBranch: "" })}>
              Let Brigadier name it
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setDialog("type")}>Type a branch name…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NameDialog
        open={dialog === "new"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="New branch"
        description={`Created from ${value} when the session starts. Commits land on it.`}
        label="Branch name"
        initialValue={resolved.draft.newBranch ?? ""}
        confirmLabel="Use this branch"
        onSubmit={async (name) => updateDraft(projectId, { newBranch: name })}
      />
      <NameDialog
        open={dialog === "type"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={local ? "Branch" : "Base branch"}
        description="An existing branch of the repository."
        label="Branch name"
        initialValue={value}
        confirmLabel="Use this branch"
        onSubmit={async (name) => pick(name)}
      />
      <NameDialog
        open={dialog === "session"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Session branch"
        description="The new branch the session's worktree works on."
        label="Branch name"
        initialValue={resolved.draft.sessionBranch}
        confirmLabel="Use this name"
        onSubmit={async (name) => updateDraft(projectId, { sessionBranch: name })}
      />
    </>
  );
}

/** A started session's environment, which can no longer change. */
export function EnvironmentChip({ conversation }: { conversation: Conversation }) {
  const setup = conversation.setup;
  if (setup?.type !== "session") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="text-muted-foreground h-control-xs px-button-xs flex min-w-0 max-w-xs items-center gap-1 text-xs"
        >
          <Branch className="size-icon-xs shrink-0" />
          <span className="truncate">{environmentLabel(setup.environment)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {setup.repo} · the repository and environment are fixed once a session starts
      </TooltipContent>
    </Tooltip>
  );
}

// ----- permission ------------------------------------------------------------------------

export function PermissionPicker({
  value,
  onChange,
}: {
  value: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
}) {
  const full = value === "fullAccess";
  return (
    <DropdownMenu modal={false}>
      <PickerTrigger
        label="Permission level"
        icon={full ? <Warning /> : <ShieldCheck />}
        text={PERMISSION_LABELS[value]}
        className={cn(full && "bg-full-access/15 text-full-access hover:bg-full-access/25 hover:text-full-access rounded-capsule")}
      />
      <DropdownMenuContent align="start" className="max-w-sm">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(level) => onChange(level as PermissionLevel)}
        >
          {PERMISSION_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level} value={level}>
              <span className="flex flex-col">
                <span className={cn(level === "fullAccess" && "text-full-access")}>
                  {PERMISSION_LABELS[level]}
                  {level === "approveForMe" && (
                    <span className="text-muted-foreground"> (default)</span>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">{PERMISSION_DETAILS[level]}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="text-muted-foreground px-2 py-1 text-xs">{ALWAYS_ASK_NOTE}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ----- model -----------------------------------------------------------------------------

/** Model and effort of a started conversation; changing them updates its setup. */
export function ConversationModelPicker({
  conversation,
  groups,
}: {
  conversation: Conversation;
  groups: ModelGroup[];
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
