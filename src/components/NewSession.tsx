/**
 * Start a session, and the `probe_claude` banner.
 *
 * The permission-mode menu deliberately omits `bypass-permissions`. It is a real wire value
 * (`crates/core/src/driver.rs:93`) and the harness will pass it through if something else sets
 * it, but offering it in the UI would hand the operator a switch that silently disables the
 * approval prompts this app exists to show.
 *
 * The `claude` binary is never bundled (CLAUDE.md §2): if `probe_claude` errors with
 * `claude_not_installed` or `claude_too_old`, the banner says so and start is blocked.
 */
import { useState } from "react";

import { OFFERED_PERMISSION_MODES } from "../wire";
import type { AppError, ClaudeStatus, ModelInfo, PermissionMode, ProjectId } from "../wire";

export interface ClaudeBannerProps {
  status: ClaudeStatus | null;
  error: AppError | null;
}

export function ClaudeBanner({ status, error }: ClaudeBannerProps) {
  if (error !== null) {
    const missing = error.code === "claude_not_installed" || error.code === "claude_too_old";
    return (
      <div className="banner bad">
        {missing
          ? "Claude Code not found: install it and restart"
          : `probe_claude failed (${error.code})`}
        <span className="dim"> — {error.message}</span>
      </div>
    );
  }
  if (status === null) return <div className="banner idle">probing claude…</div>;
  return (
    <div className="banner ok">
      claude {status.version}
      <span className="dim"> — {status.binary}</span>
    </div>
  );
}

export interface NewSessionProps {
  projectId: ProjectId | null;
  models: ModelInfo[];
  disabled: boolean;
  onStart: (args: {
    projectId: ProjectId;
    prompt: string;
    model: string | null;
    permissionMode: PermissionMode;
  }) => void;
}

export function NewSession({ projectId, models, disabled, onStart }: NewSessionProps) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("");
  const [mode, setMode] = useState<PermissionMode>("default");

  const defaultModel = models.find((m) => m.default)?.id ?? models[0]?.id ?? "";
  const chosen = model === "" ? defaultModel : model;

  const submit = () => {
    if (projectId === null || prompt.trim() === "" || disabled) return;
    onStart({
      projectId,
      prompt: prompt.trim(),
      model: chosen === "" ? null : chosen,
      permissionMode: mode,
    });
    setPrompt("");
  };

  return (
    <section className="new-session">
      <header className="pane-head">
        <span>new session</span>
        <span className="dim">{projectId ?? "pick a project"}</span>
      </header>
      <textarea
        rows={4}
        value={prompt}
        placeholder="first prompt…"
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      <div className="row">
        <label>
          model
          <select value={chosen} onChange={(e) => setModel(e.target.value)}>
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
          permissions
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {OFFERED_PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ok"
          disabled={disabled || projectId === null || prompt.trim() === ""}
          onClick={submit}
        >
          start
        </button>
      </div>
    </section>
  );
}
