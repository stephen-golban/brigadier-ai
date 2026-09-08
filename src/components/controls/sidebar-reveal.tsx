import type { ReactNode } from "react";
/** Grid tracks interpolate intrinsic content height, including interruptions mid-toggle. */
export function SidebarReveal({
  open,
  id,
  children,
}: {
  open: boolean;
  id?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className="sidebar-reveal"
      data-open={open}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
