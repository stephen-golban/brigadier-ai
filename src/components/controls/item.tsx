import type { ComponentProps } from "react";
export function Item({
  variant: _variant,
  size: _size,
  ...props
}: ComponentProps<"div"> & { variant?: string; size?: string }) {
  return <div {...props}>{props.children}</div>;
}
export function ItemActions(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={`flex items-center gap-1 ${props.className ?? ""}`}
    />
  );
}
export function ItemGroup(props: ComponentProps<"div">) {
  return <div role="list" {...props} />;
}
