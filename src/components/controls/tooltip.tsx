import {
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Tooltip as KitTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "../../lib/utils";

/**
 * A non-interactive hint, shown on hover or keyboard focus without taking focus. A thin adapter
 * over the design kit's tooltip (`src/components/ui/tooltip.tsx`) and therefore over Base UI:
 * hover intent, the hoverable popup, Escape, positioning and `aria-describedby` are all Base UI's.
 *
 * Three things stay brigadier's. The panel keeps the `glass-surface` class and the app's own
 * elevated-surface treatment instead of the kit's inverted `bg-foreground text-background` chip
 * (`Sidebar.test.tsx` asserts the class). `onlyWhenTruncated` still gates opening on the anchor's
 * own overflow, which is a product rule the kit has no equivalent for. And there is no arrow:
 * the kit's is a `bg-foreground` square, which vanishes into upstream's `bg-foreground` popup but
 * reads as a white diamond hanging off this glass panel, so `showArrow={false}` — a documented
 * deviation in `src/components/ui/UPSTREAM.md`.
 *
 * The uninverted panel costs one more override, and it is why shortcut chips went invisible after
 * the port. The kit's `Kbd` (`src/components/ui/kbd.tsx`; its documented API at
 * assistant-ui.com/design/components/kbd is `className` and nothing else — there is no `variant`
 * or `size` to select for this context) styles itself
 * `[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background`
 * whenever it sits in a tooltip. That is right on the kit's inverted `bg-foreground text-background`
 * panel, where `--background` is the *readable* colour. On `bg-elevated` (`#2b2b2b`) it inverts the
 * wrong way: the chip fills to `#181818/20` ≈ `#282828`, within a hair of the panel behind it, and
 * letters itself `#181818`. So brigadier's own `bg-selected` (`rgba(255,255,255,.14)`, ≈ `#494949`
 * over the panel) and `text-text-secondary` (`#a1a1a1`) are re-asserted below with `!`; the kit's
 * rule is a descendant-attribute selector and outranks a plain `[&_kbd]` variant on specificity.
 * The kit file itself stays untouched.
 */
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
  const [allowed, setAllowed] = useState(!onlyWhenTruncated);
  const anchor = useRef<HTMLSpanElement>(null);
  const id = useId();
  /**
   * Measured on the way in rather than vetoed in `onOpenChange`: refusing an open Base UI has
   * already decided on leaves its hover state believing the tooltip is up, and the next hover
   * never re-opens it. Withholding the popup instead leaves Base UI's own state untouched.
   */
  const measure = () => {
    if (!onlyWhenTruncated) return;
    const text = anchor.current?.querySelector<HTMLElement>(onlyWhenTruncated);
    setAllowed(!!text && text.scrollWidth > text.clientWidth);
  };
  /**
   * Keyboard focus opens the hint, as it did before. Base UI will not re-open a tooltip from
   * focus once Escape has dismissed it while the pointer is still over the trigger, and the hint
   * has to come back when the row is tabbed to.
   */
  const reveal = () => {
    measure();
    setOpen(true);
  };
  return (
    <TooltipProvider delay={0} closeDelay={100}>
      <KitTooltip
        open={open && allowed}
        onOpenChange={(next, details) => {
          // The hint this replaced dismissed itself from a document listener and never swallowed
          // the key, so Escape on a menu row closed the row's hint *and* the menu. Base UI stops
          // propagation unless the handler asks otherwise.
          if (!next) details.allowPropagation();
          setOpen(next);
        }}
      >
        <span
          ref={anchor}
          className={cn("inline-flex", className)}
          onPointerEnter={measure}
          onFocus={reveal}
          onBlur={() => setOpen(false)}
        >
          <TooltipTrigger
            // Base UI does not describe the trigger by the popup, and `role="tooltip"` is not on
            // the popup either; both are needed for the hint to be announced at all.
            aria-describedby={
              open && allowed
                ? [children.props["aria-describedby"], id]
                    .filter(Boolean)
                    .join(" ")
                : children.props["aria-describedby"]
            }
            render={children}
          />
        </span>
        <TooltipContent
          id={id}
          role="tooltip"
          showArrow={false}
          side={placement === "right" ? "right" : "top"}
          sideOffset={8}
          className={cn(
            "glass-surface max-w-[calc(100vw-16px)] gap-2 rounded-md border border-hairline bg-elevated px-2.5 py-1.5 text-[12px] leading-4 font-normal text-text shadow-overlay",
            "[&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:rounded-md [&_kbd]:bg-selected! [&_kbd]:px-1.5 [&_kbd]:text-[11px] [&_kbd]:text-text-secondary!",
          )}
        >
          {content}
        </TooltipContent>
      </KitTooltip>
    </TooltipProvider>
  );
}
