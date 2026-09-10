import { useEffect, useRef, useState } from "react";
import { useDurableComposer } from "./composer/useDurableComposer";
import { useProviderCatalog } from "../providerCatalog";
import { useProjectComposerPreferences, type ComposerMode, type PermissionPolicy } from "../taskSettings";
import { ExecutionControl, ModeControl, PermissionControl, supportedExecutionEfforts } from "./composer/ExecutionControls";
import { composerWorkspaceApi, type ComposerWorkspaceOptions } from "../composerWorkspaceApi";
import { TaskSetupRail, invalidBranchName } from "./composer/TaskSetupRail";
import { errorMessage } from "../workspaceApi";
import { ComposerActions } from "./assistant-ui/elements/composer";
import { Button } from "@/components/ui/button";
import { iconButton } from "@/lib/surfaces";
import { cn } from "@/lib/utils";
import { PromptInput } from "./PromptInput";
import { ArrowUp } from "../icons";
import { isSubmitKey } from "../keys";
import type { StartSessionArgs } from "../bridge";
import type { ModelInfo, ProjectView } from "../wire";

export interface NewSessionProps {
  project: ProjectView | null;
  projects?: ProjectView[];
  onSelectProject?: (id: string) => void;
  onNewProject?: () => void; onProjectless?: () => void;
  models: ModelInfo[];
  disabled: boolean;
  onStart: (args: StartSessionArgs) => void | Promise<boolean>;
}

export function NewSession({ project, projects, onSelectProject, onNewProject, onProjectless, models, disabled: claudeUnavailable, onStart }: NewSessionProps) {
  const currentProject = useRef(project?.id); currentProject.current = project?.id;
  const durable = useDurableComposer(project ? `project:${project.id}` : null, project?.id ?? null);
  const preferences = useProjectComposerPreferences(project?.id ?? null);
  const picks = project?.projectless ? {...preferences.value,isolated:false,baseBranch:null,newBranch:null,workspacePath:null} : preferences.value;
  const { providers, error: providerError, loaded: catalogLoaded } = useProviderCatalog(models);
  const selection = picks.manual.provider ? picks.manual : { ...picks.manual, provider: providers[0]?.id ?? "" };
  const provider = providers.find(p => p.id === selection.provider);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [workspaceEntry, setWorkspaceEntry] = useState<{projectId:string; options:ComposerWorkspaceOptions} | null>(null);
  const workspace = workspaceEntry?.projectId === project?.id ? workspaceEntry?.options ?? null : null;
  const [setupError, setSetupError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [starterFocus, setStarterFocus] = useState("");
  useEffect(() => {
    let live = true;
    let refreshVersion = 0;
    setWorkspaceEntry(null); setSetupError(null); setSending(false); setSendError(null);
    const refresh = () => {
      const version = ++refreshVersion;
      if (project?.projectless) { setWorkspaceEntry({projectId:project.id,options:{isGit:false,currentBranch:null,branches:[],worktrees:[]}}); return; }
      if (project) void composerWorkspaceApi.options(project.id).then(options => {
        if (live && version === refreshVersion) { setWorkspaceEntry({projectId:project.id,options}); setSetupError(null); }
      }).catch(e => { if (live && version === refreshVersion) setSetupError(errorMessage(e)); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    const refreshTimer = setInterval(refresh, 5000);
    const starter = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; prompt: string }>).detail;
      if (detail.projectId === project?.id) { durable.setText(detail.prompt); setStarterFocus(crypto.randomUUID()); }
    };
    const focus = () => setStarterFocus(crypto.randomUUID());
    window.addEventListener("brigadier-focus-composer", focus);
    window.addEventListener("workbench-starter", starter);
    return () => { window.removeEventListener("brigadier-focus-composer", focus); live = false; clearInterval(refreshTimer); window.removeEventListener("focus", refresh); window.removeEventListener("workbench-starter", starter); };
  }, [project?.id]);
  const unavailableModel = picks.mode === "custom" && !!selection.model && !!provider?.modelCatalogKnown && !provider.models.some(m => m.id === selection.model || (!!selection.model && m.resolvedId === selection.model));
  const unavailableEffort = picks.mode === "custom" && !!provider && !!selection.effort && !supportedExecutionEfforts(provider, selection.model).includes(selection.effort);
  const missingBranch = !!picks.baseBranch && !!workspace && !workspace.branches.some(branch => branch.name === picks.baseBranch);
  const selectedWorktree = workspace?.worktrees.find(tree => tree.path === picks.workspacePath);
  const workspaceError = picks.workspacePath && workspace && (!selectedWorktree || !selectedWorktree.available)
    ? selectedWorktree?.reason ?? "The selected worktree is unavailable or in use. Choose another workspace."
    : workspace && !workspace.isGit && (picks.isolated || picks.baseBranch || picks.newBranch)
      ? "This folder is not a Git repository. Choose Work locally to use its files." : null;
  const branchError = picks.newBranch && (invalidBranchName(picks.newBranch) || workspace?.branches.some(branch => !branch.remote && branch.name === picks.newBranch))
    ? "The new branch name is invalid or already exists. Choose a different name or Checkout." : null;
  // With no project picked there are no per-project execution settings to be unavailable: the
  // saved picks are the defaults, not the user's. Saying so would be a second false alarm beside
  // the one `docs/STATUS.md` §7 already lists, and Send is disabled by `!!project` regardless.
  const unavailable = !project ? false : picks.mode === "custom" ? !provider || unavailableModel || (claudeUnavailable && provider.id === "claude-code") : !providers.some(p => p.id !== "claude-code" || !claudeUnavailable);
  // An empty catalogue is "not known yet" until the hook says it settled: the first read of a
  // launch lands before discovery does (`docs/research/execution-settings-banner.md`), and the
  // old copy blamed the user's saved settings for it. Auto mode has no saved provider to blame.
  const unavailableMessage = !unavailable || !preferences.loaded || !catalogLoaded ? null
    : picks.mode === "custom" ? "The selected execution settings are unavailable. Open execution settings to choose a connected provider and model."
    : providers.length === 0 ? "No provider CLI is connected. Install Claude Code or Codex and reopen."
    : "The connected provider is unavailable. Check its CLI, or open execution settings to choose another provider.";
  const ready = !!project && preferences.loaded && durable.loaded && !unavailable && !unavailableEffort && !!workspace && !setupError && !workspaceError && !branchError && !missingBranch && !uploading && !sending && (!!durable.draft.text.trim() || durable.attachments.length > 0);
  const changeMode = (mode: ComposerMode) => preferences.save({ ...picks, mode, ...(mode === "custom" && !picks.manual.provider ? { manual: selection } : {}) });
  const submit = async () => {
    if (!project || !ready) return;
    const projectId = project.id;
    setSending(true); setSendError(null);
    try {
      const draft = { text: durable.draft.text, attachmentIds: durable.attachments.map(a => a.id) };
      const custom = picks.mode === "custom";
      const fingerprint = JSON.stringify({ ...draft, picks });
      const key = `brigadier:initial-send:${projectId}`;
      let receipt: { id: string; fingerprint: string } | null = null;
      try { receipt = JSON.parse(localStorage.getItem(key) ?? "null"); } catch { /* backend receipt is authoritative */ }
      if (!receipt || receipt.fingerprint !== fingerprint) receipt = { id: crypto.randomUUID(), fingerprint };
      localStorage.setItem(key, JSON.stringify(receipt));
      const accepted = await onStart({
        requestId: receipt.id, projectId, prompt: draft.text,
        composerMode: picks.mode, composerPermission: picks.permission,
        model: custom ? selection.model : null,
        ...(custom ? { provider: selection.provider } : {}),
        permissionMode: picks.permission === "full" ? "bypass-permissions" : "default",
        isolated: picks.isolated,
        ...(picks.baseBranch ? { baseBranch: picks.baseBranch } : {}),
        ...(picks.workspacePath ? { workspacePath: picks.workspacePath } : {}),
        ...(picks.newBranch ? { newBranch: picks.newBranch } : {}),
        ...(draft.attachmentIds.length ? { attachmentIds: draft.attachmentIds } : {}),
        ...(custom && selection.effort ? { options: { effort: selection.effort } } : {}),
      });
      if (accepted !== false) {
        if (currentProject.current === projectId) durable.clearAccepted(draft);
        if (localStorage.getItem(`composer-pending:project:${projectId}`) === JSON.stringify(draft)) localStorage.removeItem(`composer-pending:project:${projectId}`);
        localStorage.removeItem(key);
      }
    } catch (e) { if (currentProject.current === projectId) setSendError(errorMessage(e)); }
    finally { if (currentProject.current === projectId) setSending(false); }
  };
  const controlDisabled = sending || !preferences.loaded || !project;
  return <>
    <TaskSetupRail key={project?.id} project={project} projects={projects} picks={picks} options={workspace} disabled={sending || !preferences.loaded && !!project} onChange={preferences.save} onSelectProject={onSelectProject} onNewProject={onNewProject} onProjectless={onProjectless} />
    <PromptInput attachmentProjectId={project?.id} attachments={durable.attachments} onAttachments={durable.setFiles} onUploadChange={setUploading}
      focusKey={starterFocus} rows={2} value={durable.draft.text} aria-label="Message" placeholder={project?.projectless ? "Ask anything" : project ? `Do anything in ${project.name}` : "Ask anything"}
      disabled={sending || !project || !durable.loaded} onText={durable.setText} onKeyDown={event => { if (isSubmitKey(event)) { event.preventDefault(); void submit(); } }}>
      <ComposerActions className="composer-main-actions">
        <PermissionControl value={picks.permission as PermissionPolicy} onChange={permission => preferences.save({ ...picks, permission })} disabled={controlDisabled} />
        <span className="composer-control-spacer" />
        <ModeControl value={picks.mode} onChange={changeMode} disabled={controlDisabled} />
        {picks.mode === "custom" && <ExecutionControl selection={selection} providers={providers} onChange={manual => preferences.save({ ...picks, manual })} disabled={controlDisabled} />}
        <Button type="button" variant="ghost" size="icon" className={cn(iconButton, "composer-send")} aria-label={sending ? "Preparing task" : "Send"} disabled={!ready} onClick={() => void submit()}>{sending ? <span className="composer-spinner" /> : <ArrowUp />}</Button>
      </ComposerActions>
    </PromptInput>
    {sending && <p role="status" className="composer-feedback">Preparing task…</p>}
    {[durable.error, preferences.error, providerError, sendError, setupError, workspaceError, branchError, unavailableEffort ? `Saved effort “${selection.effort}” is unavailable for this model. Open execution settings to choose a supported effort or reset to default.` : null, missingBranch ? `Saved branch “${picks.baseBranch}” is unavailable. Choose a branch.` : null, unavailableMessage].filter(Boolean).map((message, i) => <p key={i} role="alert" className="composer-error composer-feedback">{message}</p>)}
  </>;
}
