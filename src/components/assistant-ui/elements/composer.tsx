// Adapted from assistant-ui Elements (MIT). Native controls supply the interaction layer.
import { Textarea as TextArea } from "../../controls/textarea";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { paper } from "@/lib/surfaces";

export function ComposerBar({
  dragActive = false,
  className,
  ...props
}: ComponentProps<"div"> & { dragActive?: boolean }) {
  return (
    <div
      data-slot="composer-bar"
      data-drag-active={dragActive || undefined}
      className={cn(
        paper,
        "bg-input",
        "flex w-full flex-col gap-2 rounded-composer p-3 data-[drag-active=true]:bg-selected",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerInput({
  className,
  ...props
}: React.ComponentProps<typeof TextArea>) {
  return (
    <TextArea
      data-slot="composer-input"
      {...props}
      className={cn(
        "w-full min-h-20 resize-none bg-transparent outline-none shadow-none text-sm leading-relaxed",
        className,
      )}
    />
  );
}

export function ComposerActions({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-actions"
      className={cn("flex items-center gap-1.5", className)}
      {...props}
    />
  );
}
