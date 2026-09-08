import { forwardRef, type ComponentProps } from "react";
import { cn } from "../../lib/utils";
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  ComponentProps<"textarea">
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      {...props}
      data-autofocus={props.autoFocus || undefined}
      ref={ref}
      className={cn(
        "textarea min-w-0 rounded-md bg-input px-3 py-2 text-text",
        className,
      )}
    />
  );
});
