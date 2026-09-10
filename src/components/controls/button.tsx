import { forwardRef, type ComponentProps } from "react";

import { Button as KitButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Thin adapter over the assistant-ui design kit's Button (`src/components/ui/button.tsx`).
 * It exists only so the 45 files that already import from here compile unchanged; a later
 * order codemods those call sites onto `@/components/ui/button` and deletes this file.
 *
 * What the adapter still owns, and why:
 *  - the `button` class: ~20 hand-written rules across `src/index.css`,
 *    `src/components/settings.css`, `src/components/composer/*.css` key off `.button`.
 *  - `data-icon-button` / `data-variant`: more of the same, e.g. the 16px workbench-tab
 *    close button in `src/index.css`.
 *  - the icon ink model (`text-text-secondary`, brightening on hover), the `aria-pressed`
 *    fill and the 24px standard icon box, all of which came from the
 *    `.button[data-icon-button="standard"]` CSS block that this change deleted.
 * Everything else — text geometry, hover fill, focus ring, transition, disabled treatment —
 * is now the kit's.
 */

/**
 * ghost is the default. `tertiary` was dead and is gone; so are the `default` / `destructive`
 * aliases, whose last consumer (`src/components/ActionDialog.tsx:57`) now passes `primary` /
 * `danger`. The kit's own names live on `@/components/ui/button`.
 */
type Variant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "link"
  | "danger";

/** `default`, `md` and `icon-sm` were dead and are gone. */
type Size = "sm" | "lg" | "icon" | "icon-xs";

export type ButtonProps = ComponentProps<"button"> & {
  isDisabled?: boolean;
  isIconOnly?: boolean;
  iconStyle?: "standard" | "bare";
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
};

const VARIANTS = {
  primary: "default",
  secondary: "secondary",
  outline: "outline",
  ghost: "ghost",
  link: "link",
  danger: "destructive",
} as const;

/**
 * brigadier's standard icon button is a 24px box with 4px padding, a 10px corner and a 16px
 * glyph — the metrics `.button[data-icon-button="standard"]` held in `src/index.css` before the
 * port, with the corner raised 8px → 10px by the owner's 2026-09-10 +2px radius decision. The kit's `icon` size is a 32px box (`size-8`), so every `size="icon"` call site grew by
 * a third. These classes put it back. They are appended after the kit's variant string and a
 * call site's own `className` is appended after them, so a deliberately larger button still wins.
 * Exported because `assistant-ui/elements/tooltip-icon-button.tsx` reaches for the kit's Button
 * directly and must not drift from this.
 */
export const STANDARD_ICON_BUTTON =
  "size-6 min-w-6 p-1 rounded-[10px] [&_svg:not([class*='size-'])]:size-4";

/**
 * The kit's `icon-xs` box pins its corner with `rounded-[min(var(--radius-md),10px)]`
 * (`src/components/ui/button.tsx:30`) — a clamp that caps at 10px. `--radius-md` is 12px since
 * the owner's 2026-09-10 +2px raise, so the clamp bites and `icon-xs` would be the one control
 * left behind at the old radius. Overriding it here rather than in the copied kit file keeps
 * `src/components/ui/` a verbatim upstream copy (`src/components/ui/UPSTREAM.md`). `cn`'s
 * tailwind-merge resolves the two `rounded-` classes in favour of this one, which is appended
 * after the kit's variant string.
 */
export const XS_ICON_BUTTON_RADIUS = "rounded-[12px]";

/** `isIconOnly` on a text size resolves to the kit's square box of the same weight. */
const ICON_SIZES = {
  sm: "icon",
  lg: "icon-lg",
  icon: "icon",
  "icon-xs": "icon-xs",
} as const;

const SIZES = {
  sm: "sm",
  lg: "lg",
  icon: "icon",
  "icon-xs": "icon-xs",
} as const;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    isDisabled,
    disabled,
    isIconOnly,
    iconStyle = "standard",
    onPress,
    onClick,
    variant = "ghost",
    size = "sm",
    className,
    type = "button",
    ...props
  },
  ref,
) {
  const iconOnly = isIconOnly || size.startsWith("icon");
  const kitSize = iconOnly ? ICON_SIZES[size] : SIZES[size];
  // `icon` is what both `size="icon"` and `isIconOnly` at the default `sm` resolve to; `icon-xs`
  // and `icon-lg` keep the kit's own boxes (24px already, and a deliberate 36px).
  const standardIconBox = kitSize === "icon";
  // The kit's destructive variant carries its own ink; overriding it would merge `text-destructive`
  // away and leave a danger button indistinguishable from a ghost one.
  const inheritsInk = VARIANTS[variant] !== "destructive";
  return (
    <KitButton
      {...props}
      data-icon-button={iconOnly ? iconStyle : undefined}
      data-variant={variant}
      data-autofocus={props.autoFocus || undefined}
      ref={ref}
      type={type}
      variant={VARIANTS[variant]}
      size={kitSize}
      disabled={disabled || isDisabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onPress?.();
      }}
      className={cn(
        "button [&_svg]:text-text-secondary",
        standardIconBox && STANDARD_ICON_BUTTON,
        kitSize === "icon-xs" && XS_ICON_BUTTON_RADIUS,
        iconOnly &&
          "aria-pressed:bg-selected aria-pressed:text-text [&_svg]:text-current",
        iconOnly && inheritsInk && "text-text-secondary hover:text-text",
        className,
      )}
    />
  );
});
