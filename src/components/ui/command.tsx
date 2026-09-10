import type { ComponentProps } from "react";

import { Search } from "@/icons";
import { cn } from "@/lib/utils";

/**
 * The design kit's `command.tsx`, ported off `cmdk` onto plain elements.
 *
 * Three forced deviations, all recorded in `UPSTREAM-leaf.md`:
 *  - **no `cmdk`.** `src/dependency-hygiene.test.ts:28-38` asserts `cmdk` is absent from
 *    `package.json` and unimported anywhere in `src/`, and cmdk 1.1.1 pulls four individual
 *    `@radix-ui/react-*` packages (`react-dialog`, `react-id`, `react-primitive`,
 *    `react-compose-refs`) — which `CLAUDE.md` §5 forbids. Selection is driven by the caller
 *    through `aria-activedescendant` instead; see `../controls/search-dialog.tsx`.
 *  - **no `CommandDialog`.** Upstream's builds on `@/components/ui/dialog`, which this repo does
 *    not have yet. `../controls/command.tsx` keeps a `CommandDialog` over the native `Modal`.
 *  - **`aria-selected:` and `bg-selected` in place of `data-[selected=true]:bg-accent`.** cmdk sets
 *    `data-selected`; we set `aria-selected`. The row fill is the same colour either way:
 *    `--color-accent` and `--color-selected` both alias `--accent`.
 *
 * Everything else — geometry, spacing, ink, the `data-slot` names — is the kit's.
 */
function Command({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="command"
      className={cn(
        "bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-xl",
        className,
      )}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ref,
  ...props
}: ComponentProps<"input">) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="border-border flex h-12 shrink-0 items-center gap-2 border-b px-3"
    >
      <Search className="size-4 shrink-0 opacity-50" />
      <input
        data-slot="command-input"
        ref={ref}
        className={cn(
          "placeholder:text-muted-foreground flex h-full w-full min-w-0 flex-1 rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="command-list"
      role="listbox"
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="command-empty"
      role="status"
      className={cn("py-6 text-center text-sm", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  heading,
  children,
  ...props
}: ComponentProps<"div"> & { heading: string }) {
  return (
    <div
      data-slot="command-group"
      role="group"
      aria-label={heading}
      className={cn("text-foreground overflow-hidden p-1", className)}
      {...props}
    >
      <div
        data-slot="command-group-heading"
        className="text-muted-foreground px-2 py-1.5 text-xs font-medium"
      >
        {heading}
      </div>
      {children}
    </div>
  );
}

function CommandSeparator({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="command-separator"
      role="separator"
      className={cn("bg-border -mx-1 h-px", className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="command-item"
      role="option"
      className={cn(
        "aria-selected:bg-selected [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "text-muted-foreground ms-auto text-xs tracking-widest",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
