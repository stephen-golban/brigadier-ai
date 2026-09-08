// Adapted from assistant-ui Elements (MIT). Unknown completion remains unknown.
import { CheckIcon, ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../controls/collapsible";
import type { ReactNode } from "react";
export function ToolCall({
  id,
  label,
  request,
  result,
  failed,
  open,
  onOpenChange,
  actions,
}: {
  id: string;
  label: string;
  request: string;
  result?: string;
  failed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ReactNode;
}) {
  return (
    <Collapsible
      data-trace-id={id}
      data-slot="tool-call"
      open={open}
      onOpenChange={onOpenChange}
      className="w-full"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left text-sm text-text-secondary">
        <ChevronRightIcon
          className={`size-3.5 shrink-0 ${open ? "rotate-90" : ""}`}
        />
        <span className="truncate" title={label}>
          {label}
        </span>
        {failed ? (
          <span className="ml-auto flex items-center gap-1 text-error">
            <CircleAlertIcon className="size-3.5" />
            Failed
          </span>
        ) : result !== undefined ? (
          <CheckIcon className="ml-auto size-3.5 shrink-0" />
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="my-2 overflow-hidden rounded-lg bg-elevated p-3 text-xs">
          <p className="mb-1 text-text-secondary">Request</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">
            {request}
          </pre>
          {result !== undefined && (
            <>
              <p className="mt-3 mb-1 text-text-secondary">
                {failed ? "Error" : "Output"}
              </p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">
                {result}
              </pre>
            </>
          )}
          {actions}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
