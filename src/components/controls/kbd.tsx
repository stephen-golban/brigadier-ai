import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      {...props}
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-sm bg-selected px-1 font-sans text-[13px] font-normal text-text-secondary select-none [&_svg]:size-3",
        className,
      )}
    />
  );
}
