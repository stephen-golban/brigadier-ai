import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Deviations from upstream, both forced and both recorded in `UPSTREAM-leaf.md`:
 *  - `next-themes` is dropped. brigadier is dark-only (`index.html` and `src/main.tsx` stamp a
 *    static `dark` class on `<html>`), so `theme` is a literal.
 *  - the `icons` override is dropped. Upstream draws all five from `lucide-react`, which this repo
 *    does not depend on; sonner's own inline SVGs stand in and cost no dependency.
 */
const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  const { classNames: userClassNames, ...toastOptionsRest } =
    toastOptions ?? {};

  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "bg-popover text-popover-foreground ring-foreground/10 flex w-(--width) items-center gap-2.5 rounded-xl p-3.5 font-sans ring-1 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.25)] data-[type=success]:bg-[color-mix(in_oklab,var(--color-green-500)_8%,var(--popover))] data-[type=success]:ring-green-600/40 dark:data-[type=success]:bg-[color-mix(in_oklab,var(--color-green-500)_14%,var(--popover))] dark:data-[type=success]:ring-green-500/40 data-[type=error]:bg-[color-mix(in_oklab,var(--destructive)_8%,var(--popover))] data-[type=error]:ring-destructive/45 dark:data-[type=error]:bg-[color-mix(in_oklab,var(--destructive)_14%,var(--popover))] data-[type=warning]:bg-[color-mix(in_oklab,var(--color-amber-500)_8%,var(--popover))] data-[type=warning]:ring-amber-600/40 dark:data-[type=warning]:bg-[color-mix(in_oklab,var(--color-amber-500)_14%,var(--popover))] dark:data-[type=warning]:ring-amber-500/40 data-[type=info]:bg-[color-mix(in_oklab,var(--color-blue-500)_8%,var(--popover))] data-[type=info]:ring-blue-500/40 dark:data-[type=info]:bg-[color-mix(in_oklab,var(--color-blue-500)_14%,var(--popover))]",
          content: "flex min-w-0 flex-col gap-0.5",
          title: "text-sm font-medium",
          description: "text-muted-foreground text-xs",
          icon: "relative grid size-4 shrink-0 place-items-center",
          actionButton:
            "bg-background border-foreground/15 hover:border-foreground/30 ms-auto h-6 shrink-0 cursor-pointer rounded-md border px-2 text-xs font-medium transition-colors",
          cancelButton:
            "text-muted-foreground hover:text-foreground ms-auto h-6 shrink-0 cursor-pointer rounded-md px-2 text-xs transition-colors",
          closeButton:
            "text-muted-foreground hover:text-foreground order-last ms-2 grid size-5 shrink-0 cursor-pointer place-items-center rounded-md transition-colors",
          ...userClassNames,
        },
        ...toastOptionsRest,
      }}
      {...props}
    />
  );
};

export { Toaster };
