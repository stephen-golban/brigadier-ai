import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { DialogContent } from "@/components/ui/dialog";
import { X } from "../../icons";
import { Button } from "@/components/ui/button";
import { iconButton } from "@/lib/surfaces";
import { cn } from "../../lib/utils";

/**
 * Modal dialogs, as a thin adapter over the design kit's `Dialog`
 * (`src/components/ui/dialog.tsx`) and therefore over Base UI's. The focus trap, the Tab wrap,
 * the scroll lock, outside-press dismissal, Escape and focus restoration are all Base UI's; the
 * hand-rolled `<dialog showModal()>` implementation and its own Tab-cycling loop are gone.
 *
 * The export names are the ones eleven call sites already use (`Modal.Backdrop`,
 * `Modal.Container`, `Modal.Dialog`, `Modal.Header`, `Modal.Heading`, `Modal.Body`,
 * `Modal.Footer`, `Modal.CloseTrigger`), and so are the two prop rules they depend on:
 * `isDismissable` gates the outside press and `isKeyboardDismissDisabled` gates Escape, each on
 * its own, so a busy confirmation can refuse Escape while still refusing outside clicks.
 */
let modals = 0;

const State = createContext({
  close: () => {},
  dismissable: true,
  keyboardDisabled: false,
  titleId: "",
});

function Backdrop({
  isOpen,
  onOpenChange,
  isDismissable = true,
  isKeyboardDismissDisabled = false,
  children,
}: {
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  isDismissable?: boolean;
  isKeyboardDismissDisabled?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <DialogPrimitive.Root
      open={!!isOpen}
      disablePointerDismissal={!isDismissable}
      onOpenChange={(open, details) => {
        if (open) return;
        if (details.reason === "escape-key" && isKeyboardDismissDisabled)
          return;
        onOpenChange?.(false);
      }}
    >
      <State.Provider
        value={{
          close: () => onOpenChange?.(false),
          dismissable: isDismissable,
          keyboardDisabled: isKeyboardDismissDisabled,
          titleId,
        }}
      >
        {children}
      </State.Provider>
    </DialogPrimitive.Root>
  );
}

/** Kept for the call sites that still pass `size`/`scroll`; the kit sizes the popup. */
function Container({
  children,
}: {
  children: ReactNode;
  size?: string;
  scroll?: string;
}) {
  return <>{children}</>;
}

/**
 * The order the hand-written dialog used: an explicit autofocus first, then the first enabled
 * control, and Base UI would otherwise focus the popup itself. `initialFocus` alone lands a frame
 * late, so the same choice is made in a layout effect from inside the popup, where the DOM is
 * already attached.
 */
const preferred = (marker: string) => {
  const popup = document.querySelector<HTMLElement>(
    `[data-overlay="${marker}"]`,
  );
  return (
    popup?.querySelector<HTMLElement>('[data-autofocus="true"], [autofocus]') ??
    popup?.querySelector<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
    ) ??
    null
  );
};

function Autofocus({ marker }: { marker: string }) {
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    preferred(marker)?.focus();
    // Base UI restores focus itself, but a frame later; the dialog this replaced put it back
    // before the closing render was over and the call sites assert that.
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [marker]);
  return null;
}

function Dialog({
  children,
  className,
  onKeyDown,
  ...props
}: ComponentProps<"div">) {
  const state = useContext(State);
  // `DialogContent` is a plain function that does not forward a ref (unlike the kit's
  // `PopoverContent`, which does), so the popup is found by a marker attribute when Base UI asks
  // where to put the initial focus.
  const marker = useRef(`m${(modals += 1)}`).current;
  return (
    <DialogContent
      data-overlay={marker}
      aria-labelledby={props["aria-label"] ? undefined : state.titleId}
      {...props}
      showCloseButton={false}
      initialFocus={(): HTMLElement | boolean => preferred(marker) ?? true}
      // Base UI traps focus with sentinel spans on either side of the popup, and the redirect off
      // a sentinel is not synchronous: a Shift+Tab from the first control intermittently leaves
      // focus on the guard. The wrap the hand-written dialog did is kept, so the order is
      // deterministic.
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Tab") return;
        const nodes = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
          ),
        ).filter((node) => !node.closest("[hidden]"));
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (!first) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === event.currentTarget)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      className={cn(
        "m-auto block max-h-[85dvh] w-[min(640px,calc(100vw-32px))] max-w-[calc(100vw-32px)] overflow-auto rounded-md border border-hairline bg-elevated p-5 text-text ring-0 sm:max-w-[min(640px,calc(100vw-32px))]",
        className,
      )}
    >
      <Autofocus marker={marker} />
      {children}
    </DialogContent>
  );
}

function Header(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={`mb-4 flex flex-col gap-2 ${props.className ?? ""}`}
    />
  );
}
function Heading(props: ComponentProps<"h2">) {
  const { titleId } = useContext(State);
  return (
    <h2
      id={titleId}
      {...props}
      className={`text-base font-semibold ${props.className ?? ""}`}
    />
  );
}
function Body(props: ComponentProps<"div">) {
  return <div {...props} />;
}
function Footer(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={`mt-4 flex justify-end gap-2 ${props.className ?? ""}`}
    />
  );
}
function CloseTrigger({ className, ...props }: ComponentProps<typeof Button>) {
  const { close } = useContext(State);
  return (
    <Button
      aria-label="Close"
      variant="ghost"
      {...props}
      size="icon"
      className={cn(iconButton, className)}
      onClick={close}
    >
      <X className="size-4" />
    </Button>
  );
}
export const Modal = {
  Backdrop,
  Container,
  Dialog,
  Header,
  Heading,
  Body,
  Footer,
  CloseTrigger,
};
