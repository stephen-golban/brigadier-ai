import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** A non-interactive hint, shown on hover or keyboard focus without taking focus. */
export function Tooltip({
  content,
  children,
  className,
  onlyWhenTruncated,
  placement = "top",
}: {
  content: ReactNode;
  className?: string;
  /** Selector for the text whose overflow enables this hint. */
  onlyWhenTruncated?: string;
  placement?: "top" | "right";
  children: ReactElement<ComponentProps<"button">>;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const cancel = () => clearTimeout(timer.current);
  const show = () => {
    cancel();
    const text = onlyWhenTruncated
      ? anchor.current?.querySelector<HTMLElement>(onlyWhenTruncated)
      : null;
    setOpen(
      !onlyWhenTruncated || (!!text && text.scrollWidth > text.clientWidth),
    );
  };
  const hide = () => {
    cancel();
    setOpen(false);
  };
  const leave = () => {
    cancel();
    timer.current = setTimeout(() => setOpen(false), 100);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !panel.current || !anchor.current) return;
    const position = () => {
      const trigger = anchor.current!.getBoundingClientRect();
      const hint = panel.current!.getBoundingClientRect();
      const left =
        placement === "right"
          ? trigger.right + 8
          : trigger.left + (trigger.width - hint.width) / 2;
      const top =
        placement === "right"
          ? trigger.top
          : trigger.top >= hint.height + 12
            ? trigger.top - hint.height - 8
            : trigger.bottom + 8;
      panel.current!.style.left = `${Math.max(8, Math.min(left, window.innerWidth - hint.width - 8))}px`;
      panel.current!.style.top = `${Math.max(8, Math.min(top, window.innerHeight - hint.height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", hide, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open, placement]);
  return (
    <>
      <span
        ref={anchor}
        className={`inline-flex ${className ?? ""}`}
        onPointerEnter={show}
        onPointerLeave={leave}
        onFocus={show}
        onBlur={hide}
        onPointerDown={hide}
        onClick={hide}
      >
        {cloneElement(children, {
          "aria-describedby": open
            ? [children.props["aria-describedby"], id].filter(Boolean).join(" ")
            : children.props["aria-describedby"],
        })}
      </span>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="tooltip"
            className="glass-surface fixed z-50 max-w-[calc(100vw-16px)] flex items-center gap-2 rounded-md border border-hairline bg-elevated px-2.5 py-1.5 text-[12px] leading-4 font-normal text-text shadow-overlay [&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:rounded-md [&_kbd]:px-1.5 [&_kbd]:text-[11px]"
            onPointerEnter={show}
            onPointerLeave={leave}
          >
            {content}
          </div>,
          anchor.current?.closest("dialog") ?? document.body,
        )}
    </>
  );
}
