import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { SearchIcon } from "../SearchIcon";
import { cn } from "../../lib/utils";
import { Modal } from "./modal";

// Command-palette composition from the supplied shadcn example, using our
// native dialog and semantic tokens so desktop and browser share one surface.
export function CommandDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Modal.Backdrop isOpen={open} onOpenChange={onOpenChange}>
      <Modal.Dialog
        aria-label="Search"
        className="command-dialog w-[min(512px,calc(100vw-32px))]! overflow-hidden rounded-xl! p-0! shadow-xl"
      >
        {children}
      </Modal.Dialog>
    </Modal.Backdrop>
  );
}
export function Command(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("flex flex-col overflow-hidden text-text", props.className)}
    />
  );
}
export const CommandInput = forwardRef<
  HTMLInputElement,
  ComponentProps<"input">
>(function CommandInput(props, ref) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-3 text-text-secondary">
      <SearchIcon className="shrink-0" />
      <input
        {...props}
        ref={ref}
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-tertiary",
          props.className,
        )}
      />
    </div>
  );
});
export const CommandList = forwardRef<HTMLDivElement, ComponentProps<"div">>(
  function CommandList(props, ref) {
    return (
      <div
        {...props}
        ref={ref}
        role="listbox"
        className={cn(
          "max-h-[320px] overflow-y-auto overflow-x-hidden p-1",
          props.className,
        )}
      />
    );
  },
);
export function CommandGroup({
  heading,
  children,
  ...props
}: ComponentProps<"div"> & { heading: string }) {
  return (
    <div {...props} role="group" aria-label={heading} className="p-1">
      <div className="px-2 py-1.5 text-xs font-medium text-text-tertiary">
        {heading}
      </div>
      {children}
    </div>
  );
}
export function CommandItem(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      role="option"
      className={cn(
        "flex min-h-9 cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-selected [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-secondary",
        props.className,
      )}
    />
  );
}
export function CommandSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-hairline" />;
}
export function CommandEmpty({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="py-6 text-center text-sm text-text-secondary">
      {children}
    </p>
  );
}
