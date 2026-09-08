import type { ComponentProps } from "react";
/** User-supplied search-svgrepo-com.svg, without its white artboard. */
export function SearchIcon({
  size = 16,
  ...props
}: ComponentProps<"svg"> & { size?: number }) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="10.5"
        cy="10.5"
        r="6.5"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <path
        d="M15 15l5 5"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}
