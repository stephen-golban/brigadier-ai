// Installed from assistant-ui Elements (MIT); Brigadier theme and integration extensions.
"use client";

import type { ReactNode } from "react";
import { ChevronRight, ExclamationMarkCircle } from "../../../icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  collapsePanel,
  field,
  mono,
  ShimmerLabel,
  SwapLabel,
} from "@/lib/surfaces";

export interface ToolCallProps {
  label: string;
  icon?: ReactNode;
  activeLabel: string;
  query?: string;
  request?: string;
  result?: string;
  id?: string;
  failed?: boolean;
  completed?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}

export function ToolCall({
  id,
  failed = false,
  children,
  actions,
  label,
  icon,
  activeLabel,
  query,
  request,
  result,
  completed: _completed,
  running,
  open,
  onOpenChange,
  className,
}: ToolCallProps) {
  return (
    <Collapsible
      data-slot="tool-call"
      data-trace-id={id}
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full min-w-0", className)}
    >
      <CollapsibleTrigger className="group/trigger text-text/55 hover:text-text/90 flex max-w-full items-center gap-2 rounded-md py-1.5 text-left focus-visible:ring-1 focus-visible:ring-text/30 text-[13.5px] transition-colors outline-none">
        {icon}
        <SwapLabel
          active={running ? 0 : 1}
          className="min-w-0 max-w-full text-start [&>span]:max-w-full [&>span]:truncate"
        >
          <ShimmerLabel
            active={running}
            className="relative inline-block leading-none"
          >
            {activeLabel}
          </ShimmerLabel>
          <>{label}</>
        </SwapLabel>
        <ChevronRight className="size-3.5 shrink-0 opacity-0 group-hover/trigger:opacity-60 group-focus-visible/trigger:opacity-60 group-data-[state=open]/trigger:opacity-60 transition-transform duration-200 group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none" />
        {query && (
          <span
            className={cn(
              mono,
              "bg-text/[0.06] text-text/70 rounded-md px-1.5 py-0.5",
            )}
          >
            {query}
          </span>
        )}
        {failed && (
          <ExclamationMarkCircle
            aria-hidden={false}
            role="img"
            aria-label="Failed"
            className="size-3.5 text-error"
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        {(request?.trim() || result !== undefined || actions) && (
          <div className={cn(field, "mt-2 overflow-hidden rounded-lg text-xs")}>
            {request?.trim() && (
              <div className="px-3.5 pt-2.5 pb-2">
                <p className={cn(mono, "text-text/35 mb-1")}>Request</p>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-text/55 font-mono">
                  {request}
                </pre>
              </div>
            )}
            {result !== undefined && (
              <>
                <div className="bg-text/[0.06] mx-3.5 h-px" />
                <div className="px-3.5 pt-2 pb-2.5">
                  <p className={cn(mono, "text-text/35 mb-1")}>
                    {failed ? "Error" : "Result"}
                  </p>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-text/90">
                    {result}
                  </pre>
                </div>
              </>
            )}
            {actions && <div className="px-3.5 pb-2.5">{actions}</div>}
          </div>
        )}
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
