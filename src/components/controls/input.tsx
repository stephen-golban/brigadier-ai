import { forwardRef, type ComponentProps } from "react";
import { cn } from "../../lib/utils";
export const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        {...props}
        data-autofocus={props.autoFocus || undefined}
        ref={ref}
        className={cn(
          "input min-w-0 rounded-md bg-input px-3 py-2 text-text",
          className,
        )}
      />
    );
  },
);
