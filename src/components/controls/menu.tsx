import { Dropdown } from "./overlay";
import { cn } from "../../lib/utils";
import type { ComponentProps } from "react";
/**
 * The standard dropdown surface. `side`/`align` are still brigadier's names here and are
 * translated into a `"<side> <align>"` placement string that `Dropdown.Popover` hands to Base UI.
 */
export function DropdownContent({
  side = "bottom",
  align = "start",
  children,
  className,
}: {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  children: ComponentProps<typeof Dropdown.Menu>["children"];
  className?: string;
}) {
  return (
    <Dropdown.Popover
      className={cn("blur-menu min-w-48 text-[13px]", className)}
      placement={
        side === "left" || side === "right"
          ? `${side} ${align === "end" ? "bottom" : "top"}`
          : align === "center"
            ? side
            : `${side} ${align}`
      }
    >
      <Dropdown.Menu aria-label="Actions">{children}</Dropdown.Menu>
    </Dropdown.Popover>
  );
}
