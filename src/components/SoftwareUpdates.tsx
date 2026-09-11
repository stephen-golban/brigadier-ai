import { ArrowDown, ArrowRotateCw, Check, Terminal, Warning } from "../icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { openSettings } from "../settingsNavigation";
import { refreshSoftwareUpdates, updateSoftware, useSoftwareUpdates } from "../softwareUpdates";
import { desktop, errorMessage } from "../workspaceApi";
import { BrandMark } from "./BrandMark";
import { ProviderIcon } from "./composer/ExecutionControls";
import { Button } from "./controls/button";
import { Tooltip } from "./controls/tooltip";
import "./software-updates.css";

function SoftwareIcon({ provider, updateAvailable = false }: { provider: string; updateAvailable?: boolean }) {
  return <span className={updateAvailable ? "text-warn" : "text-text-secondary"}>
    {provider === "brigadier" ? <BrandMark className="size-5 shrink-0 fill-current" />
      : provider === "codex" || provider === "claude-code" ? <span className={`software-provider-icon ${provider}`} role="img" aria-label={provider === "codex" ? "Codex" : "Claude Code"} />
      : <ProviderIcon provider={provider} />}
  </span>;
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
    <Button className="software-status" aria-label={`Software updates: ${summary}`} onClick={() => openSettings({ page: "updates" })}>
      {updates.length > 0 && <ArrowDown className="size-3.5 text-warn" />}
      {appUpdate && <BrandMark className="size-4 fill-current text-warn" />}
      {providers.map(row => <SoftwareIcon key={row.id} provider={row.provider} updateAvailable={row.updateAvailable} />)}
      {!providers.length && !appUpdate && <Terminal className="size-4" />}
    </Button>
  </Tooltip>;
}

export function SoftwareUpdates() {
  const { rows, checking, error, checkedAt, updatingId, updateError } = useSoftwareUpdates();
  const [openError, setOpenError] = useState("");
  return <section className="settings-section software-updates" aria-label="CLI and app updates">
    <div className="software-updates-heading">
      <div><h2>CLI and app updates</h2><p>Installed versions and available releases on this machine.</p></div>
      <Button variant="secondary" disabled={!desktop || checking || !!updatingId} onClick={() => void refreshSoftwareUpdates(true)}><ArrowRotateCw className="size-4" />{checking ? "Checking…" : "Check for updates"}</Button>
    </div>
    {!desktop && <p>CLI update checks are available in the desktop app.</p>}
    {!!rows.length && <div className="software-update-list">
      {rows.map(row => <div className="software-update-row" key={row.id}>
        <SoftwareIcon provider={row.provider} updateAvailable={row.updateAvailable} />
        <div className="software-update-description"><div><strong>{row.label}</strong><span>{row.installedVersion ?? "Version unknown"}{row.updateAvailable && ` → ${row.latestVersion}`}</span></div>
          {row.error && <p>{row.error}</p>}
        </div>
        {updatingId === row.id || (row.updateAvailable && ["codex", "claude-code"].includes(row.provider)) ? <Button variant="secondary" disabled={!desktop || !!updatingId} aria-label={updatingId === row.id ? `Updating ${row.label}` : `Update ${row.label}`} aria-busy={updatingId === row.id} onClick={() => void updateSoftware(row.id)}>
          {updatingId === row.id ? <><ArrowRotateCw className="size-4 motion-safe:animate-spin" />Updating…</> : <><ArrowDown className="size-4" />Update</>}
        </Button>
          : row.updateAvailable && row.releaseUrl ? <Button aria-label={`View ${row.label} update`} title="View release and installation instructions" onClick={() => { setOpenError(""); void openUrl(row.releaseUrl!).catch(error => setOpenError(errorMessage(error))); }}><ArrowDown className="size-4" /></Button>
          : row.error ? <Warning className="size-4 text-text-tertiary" aria-label="Update status unavailable" />
          : <Check className="size-4 text-text-tertiary" aria-label="Up to date" />}
      </div>)}
    </div>}
    {desktop && !checking && checkedAt > 0 && !rows.some(row => row.provider !== "brigadier") && !error && <p>No connected CLIs were found.</p>}
    {(error || openError) && <p role="alert">{error || openError}</p>}
    {updateError && <p role="alert">{updateError}</p>}
    {checkedAt > 0 && <p className="software-checked-at">Last checked {new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>}
  </section>;
}
