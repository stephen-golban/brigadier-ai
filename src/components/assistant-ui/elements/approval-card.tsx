// Adapted from assistant-ui Elements (MIT). Decision semantics belong to the caller.
import { Surface } from "../../controls/status";
import { ShieldCheck } from "../../../icons";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
export function ApprovalCard({
  heading,
  children,
  className,
  ...props
}: ComponentProps<"div"> & { heading: ReactNode }) {
  return (
    <Surface
      {...props}
      data-slot="approval-card"
      className={cn("flex w-full flex-col gap-3 rounded-md p-4", className)}
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-1 size-5 shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1">{heading}</div>
      </div>
      {children}
    </Surface>
  );
}
