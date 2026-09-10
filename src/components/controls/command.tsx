import type { ReactNode } from "react";

import { Modal } from "./modal";

/**
 * Adapter over the kit's command parts (`src/components/ui/command.tsx`).
 *
 * The parts themselves are now the kit's geometry, ink and `data-slot` names. Two things stay here:
 *
 *  - `CommandDialog`. Upstream's builds on `@/components/ui/dialog`, which this repo does not have;
 *    this one is the native `<dialog>` surface from `controls/modal.tsx`, unchanged.
 *  - the `cmdk`-free selection model. `src/dependency-hygiene.test.ts:28-38` bans `cmdk` outright,
 *    and cmdk 1.1.1 depends on four individual `@radix-ui/react-*` packages, which `CLAUDE.md` §5
 *    forbids. `controls/search-dialog.tsx` therefore keeps driving the active row itself through
 *    `aria-activedescendant`, and `ui/command.tsx` styles off `aria-selected` rather than cmdk's
 *    `data-selected`.
 */
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

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
