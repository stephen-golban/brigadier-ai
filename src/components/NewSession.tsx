import { workbenchApi } from "../workbenchApi";
import { workspaceApi } from "../workspaceApi";
import { ComposerActions as PromptInputActions } from "./assistant-ui/elements/composer";
import { Button } from "./controls/button";
import { SelectMenu } from "./SelectMenu";
import { effortLevels, type Effort } from "../agentOptions";
import type { AgentOptions } from "../agentOptions";
import { PromptInput, useDraft, useAttachmentDraft } from "./PromptInput";
/**
 * Start a session: the dock's **Session** mode.
 *
 * Until 2026-09-05 this was "the composer the window shows when no session is selected", which is
 * how the owner ended up looking at two text fields with nothing saying which was which. It is now
 * one of three bodies `src/components/Dock.tsx` swaps between, chosen explicitly, and it draws
 * only the box — the frame and the context strip are the dock's.
 *
 * The Model and Permissions controls are `src/components/Pickers.tsx`, shared with the dock's Run
 * mode since R4 so the two cannot offer different vocabularies for the same wire field. The
 * permission menu now carries **every** mode the CLI accepts, `bypass-permissions` included: the
 * mode alone never could stop a prompt (brigadier's `PreToolUse` hook runs first), so leaving it
 * out was a gate on a value that changed nothing. `OFFERED_PERMISSION_MODES` in `src/wire.ts`
 * carries the reasoning and `docs/research/permission-modes.md` §3–§5 the measurements.
 *
 * **The model menu here has no "no pick" entry**, and that is unchanged: starting one session has
 * always pre-selected the default model, and the field shows which one. The run's picker offers
 * the empty choice, because for a run "no pick" means the per-role routing stays in charge.
 *
 * The `claude` binary is never bundled (CLAUDE.md §2): if `probe_claude` errors with
 * `claude_not_installed` or `claude_too_old`, the sidebar's bottom row says so and start is
 * blocked here.
 */
import { useEffect, useState } from "react";

import { Pickers } from "./Pickers";
import { isSubmitKey } from "../keys";
import type {
  ModelInfo,
  PermissionMode,
  ProjectId,
  ProjectView,
} from "../wire";

export interface NewSessionProps {
  project: ProjectView | null;
  models: ModelInfo[];
  disabled: boolean;
  onStart: (args: {
    projectId: ProjectId;
    prompt: string;
    model: string | null;
    permissionMode: PermissionMode;
    options?: AgentOptions;
    isolated?: boolean;
    baseBranch?: string;
    attachmentIds?: string[];
  }) => void | Promise<boolean>;
}

export function NewSession({
  project,
  models,
  disabled,
  onStart,
}: NewSessionProps) {
  const [prompt, setPrompt] = useDraft(`session:${project?.id ?? "none"}`);
  const [attachments, setAttachments] = useAttachmentDraft(`session:${project?.id ?? "none"}`);
  const [uploading, setUploading] = useState(false);
  const [model, setModel] = useState<string>("");
  const [effort, setEffort] = useState<Effort>("auto");
  const [isolated, setIsolated] = useState(true);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [currentBranch, setCurrentBranch] = useState("");
  const [starterFocus, setStarterFocus] = useState("");
  useEffect(() => {
    let live = true;
    setBranches([]);
    setBranch("");
    setCurrentBranch("");
    if (project) {
      const context = { projectId: project.id, sessionId: null };
      void Promise.all([
        workbenchApi.gitDetails(context),
        workspaceApi.git(context),
      ])
        .then(([details, git]) => {
          if (live) {
            const localBranches = details.localBranches ?? details.branches;
            setBranches(localBranches);
            setCurrentBranch(git.branch);
            setBranch(localBranches.includes(git.branch) ? git.branch : "");
          }
        })
        .catch(() => {});
    }
    const starter = (event: Event) => {
      const detail = (
        event as CustomEvent<{ projectId: string; prompt: string }>
      ).detail;
      if (detail.projectId === project?.id) {
        setPrompt(detail.prompt);
        setStarterFocus(crypto.randomUUID());
      }
    };
    window.addEventListener("workbench-starter", starter);
    return () => {
      live = false;
      window.removeEventListener("workbench-starter", starter);
    };
  }, [project?.id]);
  const [mode, setMode] = useState<PermissionMode>("default");

  const defaultModel = models.find((m) => m.default)?.id ?? models[0]?.id ?? "";
  const chosen = model === "" ? defaultModel : model;
  const ready = project !== null && prompt.trim() !== "" && !disabled && !uploading;

  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (project === null || prompt.trim() === "" || disabled || sending || uploading) return;
    setSending(true);
    try {
      const accepted = await onStart({
        projectId: project.id,
        prompt: prompt.trim(),
        model: chosen === "" ? null : chosen,
        permissionMode: mode,
        isolated,
        ...(attachments.length ? {attachmentIds: attachments.map(a => a.id)} : {}),
        ...(isolated && branch ? { baseBranch: branch } : {}),
        ...(effort !== "auto" && effortLevels(chosen).includes(effort)
          ? { options: { effort } }
          : {}),
      });
      if (accepted !== false) { setPrompt(""); setAttachments([]); }
    } finally {
      setSending(false);
    }
  };

  /*
   * R2, 2026-09-05: the `.dock` frame and the context strip moved to `src/components/Dock.tsx`,
   * which draws them once for all three modes. What is left here is what was always specific to
   * starting a session — the prompt, the model and the permission mode — and it is now reached by
   * choosing "Session" on the dock rather than by having no session selected.
   */
  return (
    <>
      {branches.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-[780px] items-center gap-2 text-xs text-text-secondary">
          <SelectMenu
            searchable
            label="Base branch"
            value={isolated ? branch : currentBranch}
            onChange={setBranch}
            disabled={!isolated || disabled || sending}
            options={branches.map((value) => ({
              value,
              label: value,
              description:
                value === currentBranch
                  ? "Includes current uncommitted files"
                  : "Start from this branch’s committed files",
            }))}
          />
          <span className="text-[10px] text-text-tertiary">
            {isolated
              ? branch === currentBranch
                ? "Includes uncommitted files"
                : "Clean branch contents"
              : "Project checkout"}
          </span>
        </div>
      )}
      <PromptInput
        attachmentProjectId={project?.id}
        attachments={attachments}
        onAttachments={setAttachments}
        onUploadChange={setUploading}
        focusKey={starterFocus}
        rows={2}
        value={prompt}
        placeholder={
          project === null
            ? "Add a project first"
            : `What should we run in ${project.name}? Return to start, Shift+Return for a new line.`
        }
        disabled={disabled || sending || project === null}
        onText={setPrompt}
        onKeyDown={(e) => {
          if (isSubmitKey(e)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <PromptInputActions className="flex-1 flex-wrap justify-end">
          <Pickers
            models={models}
            model={chosen}
            onModel={setModel}
            mode={mode}
            onMode={setMode}
            disabled={disabled}
            noPickLabel={null}
          />

          {effortLevels(chosen).length ? (
            <SelectMenu
              label="Effort"
              value={effort}
              onChange={(value) => setEffort(value as Effort)}
              disabled={disabled}
              options={effortLevels(chosen).map((value) => ({
                value,
                label:
                  value === "auto"
                    ? "Default effort"
                    : `${value[0]!.toUpperCase()}${value.slice(1)}`,
                description: {
                  auto: "Let Claude choose",
                  low: "Quick responses for simple tasks",
                  medium: "Balance speed and depth",
                  high: "More time for complex work",
                  xhigh: "Extra reasoning for difficult problems",
                  max: "The highest effort supported by this model",
                }[value],
              }))}
            />
          ) : null}
          <SelectMenu
            label="Working folder"
            value={isolated ? "isolated" : "shared"}
            onChange={(v) => setIsolated(v === "isolated")}
            options={[
              {
                value: "shared",
                label: "Project folder",
                description: "Share the project checkout",
              },
              {
                value: "isolated",
                label: "Isolated worktree",
                description: "Create a separate branch and working folder",
              },
            ]}
          />
          {/* Secondary action slot, matching the turn composer's. */}
          <span className="grow" />

          <Button
            type="button"
            className="rounded-full"
            variant="primary"
            disabled={!ready || sending}
            onClick={submit}
          >
            {sending ? "Starting…" : "Start"}
          </Button>
        </PromptInputActions>
      </PromptInput>
    </>
  );
}
