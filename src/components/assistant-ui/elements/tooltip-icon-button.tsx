import { Button } from "../../controls/button";
import type { ComponentProps, ReactNode } from "react";
export function TooltipIconButton({
  tooltip,
  children,
  ...props
}: ComponentProps<typeof Button> & { tooltip: ReactNode }) {
  return (
    <Button
      {...props}
      size="icon"
      title={typeof tooltip === "string" ? tooltip : undefined}
      aria-label={typeof tooltip === "string" ? tooltip : props["aria-label"]}
    >
      {children}
    </Button>
  );
}
export function MessageAction({
  tooltip,
  children,
}: {
  tooltip: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-flex"
      title={typeof tooltip === "string" ? tooltip : undefined}
    >
      {children}
    </span>
  );
}
