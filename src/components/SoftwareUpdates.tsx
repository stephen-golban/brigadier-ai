import { ArrowDown, ArrowRotateCw, Check, Terminal, Warning } from "../icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { openSettings } from "../settingsNavigation";
import { refreshSoftwareUpdates, useSoftwareUpdates } from "../softwareUpdates";
import { desktop, errorMessage } from "../workspaceApi";
import { BrandMark } from "./BrandMark";
import { ProviderIcon } from "./composer/ExecutionControls";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { labelledButtonIcons } from "@/lib/surfaces";
import { Tooltip } from "./controls/tooltip";
import "./software-updates.css";

function SoftwareIcon({ provider }: { provider: string }) {
  if (provider === "brigadier") return <BrandMark className="size-5 shrink-0 fill-current" />;
  if (provider === "codex" || provider === "claude-code") return <span className={`software-provider-icon ${provider}`} role="img" aria-label={provider === "codex" ? "Codex" : "Claude Code"} />;
  return <ProviderIcon provider={provider} />;
}

export function SoftwareStatus() {
  const { rows, checking, error } = useSoftwareUpdates();
  const providers = rows.filter(row => row.provider !== "brigadier");
  const updates = rows.filter(row => row.updateAvailable);
  const appUpdate = updates.some(row => row.provider === "brigadier");
  const summary = updates.length
    ? `${updates.map(row => row.label).join(" and ")} updates available`
    : error ? "Update check unavailable"
    : checking ? "Checking CLI and app updates…"
    : providers.length ? providers.map(row => `${row.label}${row.installedVersion ? ` ${row.installedVersion}` : ""}${row.error ? " · update status unavailable" : ""}`).join(" · ")
    : desktop ? "No connected CLIs" : "CLI status is available in the desktop app";
  return <Tooltip className="ml-auto" content={summary}>
    <Button variant="ghost" size="sm" className={cn(labelledButtonIcons, "software-status")} aria-label={`Software updates: ${summary}`} onClick={() => openSettings({ page: "updates" })}>
      {updates.length > 0 && <ArrowDown className="size-3.5 text-warn" />}
      {appUpdate && <BrandMark className="size-4 fill-current text-warn" />}
      {providers.map(row => <span key={row.id} className={row.updateAvailable ? "text-warn" : "text-text-secondary"}><SoftwareIcon provider={row.provider} /></span>)}
      {!providers.length && !appUpdate && <Terminal className="size-4" />}
    </Button>
  </Tooltip>;
}

export function SoftwareUpdates() {
  const { rows, checking, error, checkedAt } = useSoftwareUpdates();
  const [openError, setOpenError] = useState("");
  return <section className="settings-section software-updates" aria-label="CLI and app updates">
    <div className="software-updates-heading">
      <div><h2>CLI and app updates</h2><p>Installed versions and available releases on this machine.</p></div>
      <Button variant="secondary" size="sm" className={labelledButtonIcons} disabled={!desktop || checking} onClick={() => void refreshSoftwareUpdates(true)}><ArrowRotateCw className="size-4" />{checking ? "Checking…" : "Check for updates"}</Button>
    </div>
    {!desktop && <p>CLI update checks are available in the desktop app.</p>}
    {!!rows.length && <div className="software-update-list">
      {rows.map(row => <div className="software-update-row" key={row.id}>
        <SoftwareIcon provider={row.provider} />
        <div className="software-update-description"><div><strong>{row.label}</strong><span>{row.installedVersion ?? "Version unknown"}{row.updateAvailable && ` → ${row.latestVersion}`}</span></div>
          {row.error && <p>{row.error}</p>}
        </div>
        {row.updateAvailable && row.releaseUrl ? <Button variant="ghost" size="sm" className={labelledButtonIcons} aria-label={`View ${row.label} update`} title="View release and installation instructions" onClick={() => { setOpenError(""); void openUrl(row.releaseUrl!).catch(error => setOpenError(errorMessage(error))); }}><ArrowDown className="size-4" /></Button>
          : row.error ? <Warning className="size-4 text-text-tertiary" aria-label="Update status unavailable" />
          : <Check className="size-4 text-text-tertiary" aria-label="Up to date" />}
      </div>)}
    </div>}
    {desktop && !checking && checkedAt > 0 && !rows.some(row => row.provider !== "brigadier") && !error && <p>No connected CLIs were found.</p>}
    {(error || openError) && <p role="alert">{error || openError}</p>}
    {checkedAt > 0 && <p className="software-checked-at">Last checked {new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>}
  </section>;
}
