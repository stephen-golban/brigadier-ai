import { useState } from "react";
import { ArrowRotateCcw, Bolt, Check, ChevronSmallDown, HandRaised, SettingsSlider, Sparkle, Terminal, Warning, type IconComponent } from "../../icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { iconButton, labelledButtonIcons } from "@/lib/surfaces";
import { Popover, navigateItems } from "../controls/overlay";
import type { ProviderCatalogEntry } from "../../providerCatalog";
import type { ComposerMode, ExecutionSelection, PermissionPolicy } from "../../taskSettings";

export const providerLabel = (id: string) => id === "codex" ? "Codex" : id === "claude-code" ? "Claude Code" : id || "Provider";
export function ProviderIcon({ provider }: { provider: string }) {
  return provider === "claude-code" ? <Sparkle width={17} height={17} aria-hidden={false} role="img" aria-label="Claude Code" /> : <Terminal width={17} height={17} aria-hidden={false} role="img" aria-label={providerLabel(provider)} />;
}
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const permissions: { id: PermissionPolicy; label: string; description: string; Icon: IconComponent }[] = [
  { id: "ask", label: "Ask for approval", description: "You decide when an action needs approval.", Icon: HandRaised },
  { id: "approve", label: "Approve for me", description: "Brigadier checks authorization and asks when a decision needs you.", Icon: Terminal },
  { id: "full", label: "Full access", description: "Run without permission prompts. Your explicit restrictions still apply.", Icon: Warning },
];
export function PermissionControl({ value, onChange, disabled }: { value: PermissionPolicy; onChange: (value: PermissionPolicy) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const selected = permissions.find(p => p.id === value)!;
  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button variant="ghost" size="sm" className={cn(labelledButtonIcons, `composer-permission composer-control ${value === "full" ? "is-full" : ""}`)} disabled={disabled} aria-label="Permissions" title={selected.label}>
      <selected.Icon width={17} height={17} /><span className="composer-permission-label">{selected.label}</span><ChevronSmallDown className="composer-control-chevron" width={12} height={12} />
    </Button>
    <Popover.Content placement="top start" className="composer-popover permission-popover">
      <Popover.Dialog aria-label="Permissions">
        <p className="composer-popover-heading">How should actions be approved?</p>
        <div role="listbox" aria-label="Permission policy" onKeyDown={navigateItems}>
          {permissions.map(({ id, label, description, Icon }) => <button type="button" role="option" aria-selected={id === value} key={id} disabled={disabled} className={`permission-option ${id === "full" ? "is-full" : ""}`} onClick={() => { onChange(id); setOpen(false); }}>
            <Icon width={20} height={20} /><span><span>{label}</span><small>{description}</small></span>{id === value && <Check width={17} height={17} />}
          </button>)}
        </div>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}

const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** Use actual model capabilities, then order known levels monotonically and retain unknown levels in source order. */
export function supportedExecutionEfforts(provider: ProviderCatalogEntry | undefined, modelId: string | null): string[] {
  if (!provider) return [];
  const model = modelId ? provider.models.find(item => item.id === modelId || item.resolvedId === modelId) : undefined;
  const efforts = !modelId ? provider.efforts : model ? model.efforts : provider.modelCatalogKnown ? [] : provider.efforts;
  return [...efforts].sort((a, b) => {
    const rankA = effortOrder.indexOf(a), rankB = effortOrder.indexOf(b);
    return (rankA < 0 ? effortOrder.length : rankA) - (rankB < 0 ? effortOrder.length : rankB);
  });
}

/** Mode remains visible independently of the Custom execution picker. */
export function ModeControl({ value, onChange, started = false, disabled = false, selection, providers = [] }: {
  value: ComposerMode; onChange: (mode: ComposerMode) => void; started?: boolean; disabled?: boolean;
  selection?: ExecutionSelection; providers?: ProviderCatalogEntry[];
}) {
  const [open, setOpen] = useState(false);
  const Icon = value === "auto" ? Bolt : SettingsSlider;
  const model = providers.find(p => p.id === selection?.provider)?.models.find(m => m.id === selection?.model || (!!selection?.model && m.resolvedId === selection.model));
  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button variant="ghost" size="sm" className={cn(labelledButtonIcons, "composer-mode composer-control")} disabled={disabled} aria-label="Mode" title={capitalize(value)}>
      <Icon width={17} height={17} /><span>{capitalize(value)}</span><ChevronSmallDown className="composer-control-chevron" width={12} height={12} />
    </Button>
    <Popover.Content placement="top end" className="composer-popover permission-popover mode-popover">
      <Popover.Dialog aria-label="Execution mode">
        <p className="composer-popover-heading">How should execution settings be chosen?</p>
        <div role="listbox" aria-label="Mode" onKeyDown={navigateItems}>
          <button type="button" role="option" aria-selected={value === "auto"} disabled={disabled || (started && value === "custom")} className="permission-option" onClick={() => { onChange("auto"); setOpen(false); }}>
            <Bolt width={20} height={20} /><span><span>Auto</span><small>{started && value === "custom" ? "This task is now Custom. Auto is available when starting a new task." : "Brigadier chooses execution settings as the task progresses. Workers choose independently."}</small></span>{value === "auto" && <Check width={17} height={17} />}
          </button>
          <button type="button" role="option" aria-selected={value === "custom"} disabled={disabled} className="permission-option" onClick={() => { onChange("custom"); setOpen(false); }}>
            <SettingsSlider width={20} height={20} /><span><span>Custom</span><small>{started && value === "auto" ? "Take control of subsequent work. The current response continues unchanged." : "Choose the provider, model and effort for this task."}</small></span>{value === "custom" && <Check width={17} height={17} />}
          </button>
        </div>
        {value === "auto" && started && selection && <p className="composer-mode-current">Current: {providerLabel(selection.provider)} · {model?.label ?? selection.model ?? "Provider default"} · {selection.effort ? capitalize(selection.effort) : "Default effort"}</p>}
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}

/** Custom execution settings stay open across provider, model and effort edits. */
export function ExecutionControl({ selection, providers, onChange, disabled = false }: {
  selection: ExecutionSelection; providers: ProviderCatalogEntry[]; onChange: (selection: ExecutionSelection) => void; disabled?: boolean;
  mode?: ComposerMode; onMode?: (mode: ComposerMode) => void; started?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const provider = providers.find(p => p.id === selection.provider);
  const model = provider?.models.find(m => m.id === selection.model || (!!selection.model && m.resolvedId === selection.model));
  const efforts = supportedExecutionEfforts(provider, selection.model);
  const unavailableEffort = !!provider && !!selection.effort && !efforts.includes(selection.effort);
  const effortIndex = efforts.indexOf(selection.effort ?? "");
  const label = model?.label ?? selection.model ?? "Provider default";
  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button variant="ghost" size="sm" className={cn(labelledButtonIcons, "composer-execution composer-control")} aria-label="Execution settings" title={`${providerLabel(selection.provider)} · ${label} · ${selection.effort ?? "default effort"}`} disabled={disabled}>
      <ProviderIcon provider={selection.provider} /><span className="composer-model-label">{label}</span>
      <span className="composer-effort-label">{selection.effort ? capitalize(selection.effort) : "Default"}</span><ChevronSmallDown className="composer-control-chevron" width={13} height={13} />
    </Button>
    <Popover.Content placement="top end" className="composer-popover execution-popover">
      <Popover.Dialog aria-label="Provider, model and effort">
        {/* Segmented selector adapted from assistant-ui SettingsPanel (MIT), https://r.assistant-ui.com/elements-settings-panel.json. */}
        <div className="execution-providers" role="group" aria-label="Provider">
          {providers.map(p => <button type="button" key={p.id} disabled={disabled} aria-pressed={p.id === selection.provider} onClick={() => { if (p.id !== selection.provider) onChange({ provider: p.id, model: null, effort: null }); }}><ProviderIcon provider={p.id} /><span>{providerLabel(p.id)}</span></button>)}
        </div>
        {!provider && <p role="alert" className="composer-error">{selection.provider ? `${providerLabel(selection.provider)} is unavailable. Choose a connected provider.` : "Choose a connected provider."}</p>}
        {provider && <>
          <p className="composer-popover-heading">Orchestrator model</p>
          <div className="execution-models" role="listbox" aria-label="Model" onKeyDown={navigateItems}>
            <button type="button" role="option" aria-selected={!selection.model} disabled={disabled} onClick={() => onChange({ ...selection, model: null, effort: null })}><span>Provider default</span>{!selection.model && <Check width={16} height={16} />}</button>
            {provider.models.map(m => <button type="button" role="option" key={m.id} aria-selected={selection.model === m.id || (!!selection.model && selection.model === m.resolvedId)} disabled={disabled} onClick={() => onChange({ ...selection, model: m.id, effort: m.efforts.includes(selection.effort ?? "") ? selection.effort : null })}><span>{m.label}</span>{(selection.model === m.id || (!!selection.model && selection.model === m.resolvedId)) && <Check width={16} height={16} />}</button>)}
          </div>
          {!provider.modelCatalogKnown && <label className="execution-exact">Exact model ID<input aria-label="Exact model ID" disabled={disabled} value={selection.model ?? ""} onChange={e => onChange({ ...selection, model: e.target.value || null, effort: null })} /></label>}
          {provider.modelCatalogKnown && selection.model && !model && <p role="alert" className="composer-error">Saved model “{selection.model}” is unavailable. Choose a listed model.</p>}
          <div className="execution-effort">
            {unavailableEffort && <p role="alert" className="composer-error">Saved effort “{selection.effort}” is unavailable for this model. Choose a supported effort or reset to default.</p>}
            <div className="execution-effort-heading"><Bolt width={19} height={19} /><span><strong>{selection.effort ? capitalize(selection.effort) : "Default"}</strong><small>{label}</small></span><Button variant="ghost" size="icon" className={iconButton} disabled={disabled || !selection.effort} aria-label="Reset effort to default" title="Use the model or provider default" onClick={() => onChange({ ...selection, effort: null })}><ArrowRotateCcw width={17} height={17} /></Button></div>
            {efforts.length > 0 ? <>
              <div className={`effort-track ${effortIndex < 0 ? "is-default" : ""}`}>
                <input type="range" aria-label="Reasoning effort" min={0} max={Math.max(0, efforts.length - 1)} step={1} value={Math.max(0, effortIndex)} aria-valuetext={unavailableEffort ? `Unavailable saved effort: ${selection.effort}` : selection.effort ?? "Provider default"} aria-invalid={unavailableEffort || undefined} disabled={disabled} style={{ "--effort-fill": `${effortIndex < 0 ? 0 : efforts.length < 2 ? 100 : effortIndex / (efforts.length - 1) * 100}%` } as React.CSSProperties} onKeyDown={event => { if (effortIndex < 0 && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); onChange({ ...selection, effort: efforts[event.key === "End" ? efforts.length - 1 : 0]! }); } }} onChange={e => onChange({ ...selection, effort: efforts[Number(e.target.value)]! })} />
                <div className="effort-ticks" aria-hidden="true">{efforts.map(e => <span key={e} />)}</div>
              </div>
              <div className="effort-levels">{efforts.map(e => <button type="button" key={e} disabled={disabled} aria-label={`Use ${e} effort`} aria-pressed={selection.effort === e} onClick={() => onChange({ ...selection, effort: e })}>{capitalize(e)}</button>)}</div>
            </> : <small>Effort controls are unavailable for this model.</small>}
          </div>
        </>}
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
