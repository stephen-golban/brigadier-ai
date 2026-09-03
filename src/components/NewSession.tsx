/**
 * Start a session. This is the composer the window shows when no session is selected, the way
 * the reference app shows a fresh empty chat with its composer waiting for the first prompt.
 *
 * The permission-mode menu deliberately omits `bypass-permissions`. It is a real wire value
 * (`crates/core/src/driver.rs:93`) and the harness will pass it through if something else sets
 * it, but offering it in the UI would hand the operator a switch that silently disables the
 * approval prompts this app exists to show.
 *
 * The `claude` binary is never bundled (CLAUDE.md §2): if `probe_claude` errors with
 * `claude_not_installed` or `claude_too_old`, the sidebar's bottom row says so and start is
 * blocked here.
 */
import { useState } from "react";

import { PathIcon, ProjectIcon } from "./icons";
import { OFFERED_PERMISSION_MODES } from "../wire";
import type { ModelInfo, PermissionMode, ProjectId, ProjectView } from "../wire";

export interface NewSessionProps {
  project: ProjectView | null;
  models: ModelInfo[];
  disabled: boolean;
  onStart: (args: {
    projectId: ProjectId;
    prompt: string;
    model: string | null;
    permissionMode: PermissionMode;
  }) => void;
}

export function NewSession({ project, models, disabled, onStart }: NewSessionProps) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("");
  const [mode, setMode] = useState<PermissionMode>("default");

  const defaultModel = models.find((m) => m.default)?.id ?? models[0]?.id ?? "";
  const chosen = model === "" ? defaultModel : model;
  const ready = project !== null && prompt.trim() !== "" && !disabled;

  const submit = () => {
    if (project === null || prompt.trim() === "" || disabled) return;
    onStart({
      projectId: project.id,
      prompt: prompt.trim(),
      model: chosen === "" ? null : chosen,
      permissionMode: mode,
    });
    setPrompt("");
  };

  return (
    <section className="dock">
      <div className="dock-context">
        <span title={project?.root_path}>
          <span className="glyph">
            <ProjectIcon />
          </span>
          {project?.name ?? "no project"}
        </span>
        {project !== null ? (
          <span title={project.root_path}>
            <span className="glyph">
              <PathIcon />
            </span>
            {project.root_path}
          </span>
        ) : null}
      </div>

      <div className="dock-box">
        <textarea
          rows={2}
          value={prompt}
          placeholder={
            project === null
              ? "Add a project first"
              : `What should we run in ${project.name}? Cmd+Return to start.`
          }
          disabled={disabled || project === null}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <div className="dock-actions">
          <label>
            Model
            <select
              value={chosen}
              disabled={disabled}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.length === 0 ? <option value="">(none)</option> : null}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.default ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Permissions
            <select
              value={mode}
              disabled={disabled}
              onChange={(e) => setMode(e.target.value as PermissionMode)}
            >
              {OFFERED_PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          {/* Secondary action slot, matching the turn composer's. */}
          <span className="grow" />

          <button
            type="button"
            className="send wide"
            disabled={!ready}
            onClick={submit}
          >
            Start
          </button>
        </div>
      </div>
    </section>
  );
}
