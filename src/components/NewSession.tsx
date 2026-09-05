import { SelectMenu } from "./SelectMenu";
import { effortLevels, type Effort } from "../agentOptions";
import type { AgentOptions } from "../agentOptions";
import { PromptInput, useDraft } from "./PromptInput";
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
import { useState } from "react";

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
  }) => void | Promise<boolean>;
}

export function NewSession({
  project,
  models,
  disabled,
  onStart,
}: NewSessionProps) {
  const [prompt, setPrompt] = useDraft(`session:${project?.id ?? "none"}`);
  const [model, setModel] = useState<string>("");
  const [effort, setEffort] = useState<Effort>("auto");
  const [mode, setMode] = useState<PermissionMode>("default");

  const defaultModel = models.find((m) => m.default)?.id ?? models[0]?.id ?? "";
  const chosen = model === "" ? defaultModel : model;
  const ready = project !== null && prompt.trim() !== "" && !disabled;

  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (project === null || prompt.trim() === "" || disabled || sending) return;
    setSending(true);
    try {
      const accepted = await onStart({
        projectId: project.id,
        prompt: prompt.trim(),
        model: chosen === "" ? null : chosen,
        permissionMode: mode,
        ...(effort !== "auto" && effortLevels(chosen).includes(effort)
          ? { options: { effort } }
          : {}),
      });
      if (accepted !== false) setPrompt("");
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
      <div className="dock-box">
        <PromptInput
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
        />
        <div className="dock-actions">
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
          {/* Secondary action slot, matching the turn composer's. */}
          <span className="grow" />

          <button
            type="button"
            className="send wide"
            disabled={!ready || sending}
            onClick={submit}
          >
            Start
          </button>
        </div>
      </div>
    </>
  );
}
