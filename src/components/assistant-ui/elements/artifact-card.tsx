// Adapted from assistant-ui Elements (MIT). File actions are supplied by the workspace.
import { Surface } from "../../controls/status";
import { FileTextIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
export function ArtifactCard({
  heading,
  children,
  className,
  ...props
}: ComponentProps<"div"> & { heading: ReactNode }) {
  return (
    <Surface
      {...props}
      data-slot="artifact-card"
      className={cn("flex w-full flex-col gap-2 rounded-md p-4", className)}
    >
      <header className="flex items-center gap-3">
        <FileTextIcon className="size-5 shrink-0 text-text-secondary" />
        {heading}
      </header>
      {children}
    </Surface>
  );
}
