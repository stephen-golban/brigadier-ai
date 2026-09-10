import { TerminalIcon, CaretDownIcon } from "@phosphor-icons/react";
import type { SessionStartup } from "../sessionStartup";
import { ChatPanelUserMessage } from "./assistant-ui/elements/chat-panel";
import { Button } from "./controls/button";
import "./session-provisioning.css";

export function SessionProvisioning({ startup, onRetry }: { startup: SessionStartup; onRetry?: () => void }) {
  const ready = !!startup.sessionId;
  return <div className="session-provisioning" aria-label="Task provisioning">
    <details>
      <summary><TerminalIcon size={14}/><span role="status">{startup.error ? "Task setup failed" : ready ? "Provisioned task" : "Setting up your task…"}</span>{!ready && !startup.error && <span className="composer-spinner"/>}<CaretDownIcon size={12}/></summary>
      <pre>{startup.progress.map(item => item.detail).join("\n")}</pre>
    </details>
    {startup.error && <div role="alert" className="provisioning-error"><p>{startup.error}</p>{onRetry && <Button onClick={onRetry}>Retry setup</Button>}</div>}
  </div>;
}
export function StartupMessage({ startup }: { startup: SessionStartup }) {
  return <div className="aui-message user"><ChatPanelUserMessage className="startup-message">{startup.args.prompt}{!!startup.args.attachmentIds?.length && <small>{startup.args.attachmentIds.length} attached file{startup.args.attachmentIds.length === 1 ? "" : "s"}</small>}</ChatPanelUserMessage></div>;
}
export function ProvisioningConversation({ startup, onRetry }: { startup: SessionStartup; onRetry?: () => void }) {
  return <div className="provisioning-conversation"><StartupMessage startup={startup}/><SessionProvisioning startup={startup} onRetry={onRetry}/></div>;
}
