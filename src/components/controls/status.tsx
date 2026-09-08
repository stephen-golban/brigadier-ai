import type { ComponentProps } from "react";
export function Spinner({
  size: _size,
  className,
  ...props
}: ComponentProps<"span"> & { size?: string }) {
  return (
    <span
      {...props}
      role="status"
      aria-label={props["aria-label"] ?? "Working"}
      className={`inline-flex size-4 items-center justify-center text-warn ${className ?? ""}`}
    >
      …
    </span>
  );
}
export function Surface({
  variant: _variant,
  ...props
}: ComponentProps<"div"> & { variant?: string }) {
  return (
    <div
      {...props}
      className={`surface rounded-md bg-elevated ${props.className ?? ""}`}
    />
  );
}
