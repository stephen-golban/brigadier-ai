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
 * Three things stay brigadier's. The panel is Codex's pill — `--tooltip` (unified onto
 * `--popover`, two units from Codex's measured `rgb(45,45,45)`), a `--radius-tooltip` corner,
 * a 1px `--tooltip-border` edge, 13px `--tooltip-foreground`, 6px block × 8px inline padding,
 * measured in `docs/research/codex-sidebar.md` §4.9 — instead of the kit's inverted `bg-foreground
 * text-background` chip. That treatment is the unlayered `.tooltip-pill` block in
 * `src/index.css`; `glass-surface` stays on the element because `Sidebar.test.tsx:165` asserts
 * it. `onlyWhenTruncated` still gates opening on the anchor's own overflow, which is a product
 * rule the kit has no equivalent for. And there is no arrow: the kit's is a `bg-foreground`
 * square, which vanishes into upstream's `bg-foreground` popup but reads as a white diamond
 * hanging off this panel, so `showArrow={false}` — a documented deviation in
 * `src/components/ui/UPSTREAM.md`.
 *
 * The uninverted panel is why shortcut chips went invisible after the port. The kit's `Kbd`
 * (`src/components/ui/kbd.tsx`; its documented API at assistant-ui.com/design/components/kbd is
 * `className` and nothing else — there is no `variant` or `size` to select for this context)
 * styles itself
 * `[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background`
 * whenever it sits in a tooltip. That is right on the kit's inverted panel, where `--background`
 * is the *readable* colour, and inverts the wrong way on any other. Codex's own keycap —
 * `currentColor` at 10%, a `--radius-keycap` corner, 12px text in the tooltip's own ink — replaces it from
 * `src/index.css`'s `[data-slot="tooltip-content"] kbd` rule, which is unlayered and therefore
 * beats the kit's `@layer utilities` variant whatever their specificity. Both kit files stay
 * verbatim copies, and no call site has to opt in.
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
          className="tooltip-pill glass-surface max-w-[calc(100vw-16px)] font-normal shadow-overlay"
        >
          {content}
        </TooltipContent>
      </KitTooltip>
    </TooltipProvider>
  );
}
