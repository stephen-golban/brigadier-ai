import type { ComponentProps } from "react";
export function ButtonGroup(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      role="group"
      className={`button-group flex items-center gap-1 ${props.className ?? ""}`}
    />
  );
}
