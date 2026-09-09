import { ProviderIcon, providerLabel } from "./ExecutionControls";
import type { ExecutionChange } from "../../taskSettings";

/** assistant-ui day-separator treatment inside the rich thread; this is configuration history. */
export function ProviderChangeDivider({ change }: { change: ExecutionChange }) {
  return <details className="provider-change-divider">
    <summary><span /><span><ProviderIcon provider={change.provider} />Switched to {providerLabel(change.provider)}</span><span /></summary>
    <div>{providerLabel(change.previousProvider)} → {providerLabel(change.provider)}{change.model ? ` · ${change.model}` : " · provider default"}{change.effort ? ` · ${change.effort}` : ""}<p>Applies to subsequent work in this task. The current response keeps its original settings.</p></div>
  </details>;
}
