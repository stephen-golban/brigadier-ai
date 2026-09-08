import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";
import { Button } from "./button";
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
  return isOpen ? (
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
  ) : null;
}
function Container({
  children,
}: {
  children: ReactNode;
  size?: string;
  scroll?: string;
}) {
  return <>{children}</>;
}
function Dialog({
  children,
  className,
  onKeyDown,
  onClick,
  ...props
}: ComponentProps<"dialog">) {
  const state = useContext(State);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    (
      dialog.querySelector<HTMLElement>(
        '[data-autofocus="true"], [autofocus]',
      ) ??
      dialog.querySelector<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), [tabindex='0']",
      ) ??
      dialog
    ).focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <dialog
      aria-labelledby={props["aria-label"] ? undefined : state.titleId}
      {...props}
      ref={ref}
      tabIndex={-1}
      className={`fixed m-auto max-h-[85dvh] w-[min(640px,calc(100vw-32px))] overflow-auto rounded-md border border-hairline bg-elevated p-5 text-text backdrop:bg-backdrop ${className ?? ""}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!state.keyboardDisabled) state.close();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!state.keyboardDisabled) state.close();
        }
        if (event.key === "Tab") {
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
        }
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.target !== event.currentTarget || !state.dismissable) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          state.close();
      }}
    >
      {children}
    </dialog>,
    document.body,
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
function CloseTrigger(props: ComponentProps<typeof Button>) {
  const { close } = useContext(State);
  return (
    <Button aria-label="Close" {...props} size="icon" onClick={close}>
      <XIcon className="size-4" />
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
