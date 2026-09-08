import type { ComponentProps, ReactNode } from "react";
export function Checkbox({
  children,
  onCheckedChange,
  className,
  ...props
}: ComponentProps<"input"> & {
  children?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return (
    <label
      className={`inline-flex flex-row! items-center gap-2 text-[13px] ${className ?? ""}`}
    >
      <input
        {...props}
        type="checkbox"
        className="size-4 accent-text-secondary"
        onChange={(event) => {
          props.onChange?.(event);
          onCheckedChange?.(event.target.checked);
        }}
      />
      {children}
    </label>
  );
}
