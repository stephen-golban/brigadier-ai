import { useDurableComposer } from "./composer/useDurableComposer";
import { useProviderCatalog } from "../providerCatalog";
import { workbenchApi } from "../workbenchApi";
import { workspaceApi } from "../workspaceApi";
import { ComposerActions as PromptInputActions } from "./assistant-ui/elements/composer";
import { Button } from "./controls/button";
import { SelectMenu } from "./SelectMenu";
import { type Effort } from "../agentOptions";
import type { AgentOptions } from "../agentOptions";
import { PromptInput } from "./PromptInput";
import { useEffect, useRef, useState } from "react";

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
    provider?: string;
    requestId?: string;
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
  disabled: claudeUnavailable,
  onStart,
}: NewSessionProps) {
  const currentProject = useRef(project?.id); currentProject.current = project?.id;
  const durable = useDurableComposer(project ? `project:${project.id}` : null, project?.id ?? null);
  const prompt = durable.draft.text, setPrompt = durable.setText;
  const attachments = durable.attachments, setAttachments = durable.setFiles;
  const [uploading, setUploading] = useState(false);
  const {providers, error: providerError} = useProviderCatalog(models);
  const [providerId, setProviderId] = useState("");
  const provider = providers.find(p => p.id === providerId) ?? providers[0];
  const disabled = claudeUnavailable && (!provider || provider.id === "claude-code");
  const [model, setModel] = useState<string>("");
  const [effort, setEffort] = useState<Effort>("auto");
  const isolated = true;
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
  const chosen = model;
  const availableEfforts = provider?.models.find(m => m.id === (model || defaultModel))?.efforts ?? provider?.efforts ?? [];
  const ready = project !== null && (prompt.trim() !== "" || attachments.length > 0) && !disabled && !uploading;

  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (project === null || (prompt.trim() === "" && attachments.length === 0) || disabled || sending || uploading) return;
    setSending(true);
    try {
      const fingerprint = JSON.stringify({prompt,model:chosen,provider:provider?.id,mode,effort,isolated,branch,attachments:attachments.map(a=>a.id)});
      const key = `brigadier:initial-send:${project.id}`;
      let receipt: {id:string;fingerprint:string}|null = null;
      try {receipt=JSON.parse(localStorage.getItem(key) ?? 'null');} catch { /* recover with a new logical submission */ }
      if(!receipt || receipt.fingerprint!==fingerprint) receipt={id:crypto.randomUUID(),fingerprint};
      localStorage.setItem(key,JSON.stringify(receipt));
      const accepted = await onStart({
        requestId: receipt.id,
        projectId: project.id,
        prompt,
        model: chosen === "" ? null : chosen,
        provider: provider?.id,
        permissionMode: mode,
        isolated,
        ...(attachments.length ? {attachmentIds: attachments.map(a => a.id)} : {}),
        ...(isolated && branch ? { baseBranch: branch } : {}),
        ...(effort !== "auto" && availableEfforts.includes(effort)
          ? { options: { effort } }
          : {}),
      });
      if (accepted !== false) {
        const sent = {text: prompt, attachmentIds: attachments.map(a => a.id)};
        if (currentProject.current === project.id) durable.clearAccepted(sent);
        const pendingKey = `composer-pending:project:${project.id}`;
        if (localStorage.getItem(pendingKey) === JSON.stringify(sent)) localStorage.removeItem(pendingKey);
        localStorage.removeItem(key);
      }
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
        <details className="mx-auto mb-2 max-w-[780px] text-xs text-text-secondary"><summary>Workspace · automatic</summary>
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
        </details>
      )}
      {durable.error && <p role="alert" className="text-error">{durable.error}</p>}
      {providerError && <p role="alert" className="text-error">{providerError}</p>}
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
            : `Do anything in ${project.name}`
        }
        disabled={disabled || sending || project === null || !durable.loaded}
        onText={setPrompt}
        onKeyDown={(e) => {
          if (isSubmitKey(e)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <PromptInputActions className="flex-1 flex-wrap justify-end">
          {provider && <SelectMenu label="Provider" value={provider.id} onChange={value => {setProviderId(value);setModel("");setEffort("auto");if(value==="codex"&&mode==="auto")setMode("default");}} options={providers.map(p => ({value:p.id,label:p.label,description:p.version ?? 'Connected local provider'}))} />}
          <Pickers
            provider={provider?.id}
            models={provider?.modelCatalogKnown ? provider.models.map(m=>({id:m.id,label:m.label,default:false})) : provider?.id === "claude-code" || !provider ? models : []}
            model={chosen}
            onModel={setModel}
            mode={mode}
            onMode={setMode}
            disabled={disabled}
            noPickLabel="Auto"
            modelHint="Use the default orchestrator model. An explicit selection pins this exact model; workers choose independently."
          />

          {provider && !provider.modelCatalogKnown && <input aria-label="Exact model ID" placeholder="Exact model ID (optional)" value={model} onChange={e=>setModel(e.target.value)} className="bg-transparent text-xs max-w-40" />}
          {availableEfforts.length ? (
            <SelectMenu
              label="Effort"
              value={effort}
              onChange={(value) => setEffort(value as Effort)}
              disabled={disabled}
              options={["auto", ...availableEfforts].map((value) => ({
                value,
                label:
                  value === "auto"
                    ? "Default effort"
                    : `${value[0]!.toUpperCase()}${value.slice(1)}`,
                description: ({
                  auto: "Use provider default",
                  low: "Quick responses for simple tasks",
                  medium: "Balance speed and depth",
                  high: "More time for complex work",
                  xhigh: "Extra reasoning for difficult problems",
                  max: "The highest effort supported by this model",
                } as Record<string,string>)[value],
              }))}
            />
          ) : null}
          {/* Secondary action slot, matching the turn composer's. */}
          <span className="grow" />

          <Button
            type="button"
            className="rounded-full"
            variant="primary"
            disabled={!ready || sending}
            onClick={submit}
          >
            {sending ? "Starting…" : "Send"}
          </Button>
        </PromptInputActions>
      </PromptInput>
    </>
  );
}
