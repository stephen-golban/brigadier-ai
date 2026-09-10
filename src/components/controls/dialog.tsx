import { Modal } from "./modal";
import { Description } from "./overlay";
import {
  createContext,
  useContext,
  type ReactNode,
  type ComponentProps,
} from "react";
const DialogState = createContext<{
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}>({ open: false });
export function Dialog({
  open = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DialogState.Provider value={{ open, onOpenChange }}>
      {children}
    </DialogState.Provider>
  );
}
export function DialogContent({
  children,
  className,
  onEscapeKeyDown,
  onInteractOutside,
  showCloseButton = true,
  ...props
}: Omit<ComponentProps<"div">, "role"> & {
  role?: "dialog" | "alertdialog";
  onEscapeKeyDown?: (event: { preventDefault: () => void }) => void;
  onInteractOutside?: (event: { preventDefault: () => void }) => void;
  showCloseButton?: boolean;
}) {
  const state = useContext(DialogState);
  return (
    <Modal.Backdrop
      isOpen={state.open}
      onOpenChange={(open) => {
        if (!open) {
          let prevented = false;
          onEscapeKeyDown?.({
            preventDefault: () => {
              prevented = true;
            },
          });
          if (prevented) return;
        }
        state.onOpenChange?.(open);
      }}
      isDismissable={!onInteractOutside}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog {...props} className={className}>
          {showCloseButton && <Modal.CloseTrigger aria-label="Close" />}
          {children}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
export const DialogHeader = Modal.Header;
export const DialogTitle = Modal.Heading;
export const DialogFooter = Modal.Footer;
export function DialogDescription({
  asChild: _asChild,
  children,
  ...props
}: Omit<ComponentProps<"div">, "role"> & {
  role?: "dialog" | "alertdialog";
  asChild?: boolean;
}) {
  return <Description {...props}>{children}</Description>;
}
