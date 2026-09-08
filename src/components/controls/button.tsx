import { forwardRef, type ComponentProps } from "react";
import { cn } from "../../lib/utils";

type Props = ComponentProps<"button"> & {
  isDisabled?: boolean;
  isIconOnly?: boolean;
  iconStyle?: "standard" | "bare";
  onPress?: () => void;
  variant?:
    | "default"
    | "primary"
    | "secondary"
    | "tertiary"
    | "outline"
    | "ghost"
    | "link"
    | "destructive"
    | "danger";
  size?: "default" | "sm" | "md" | "lg" | "icon" | "icon-sm" | "icon-xs";
};
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
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
  return (
    <button
      {...props}
      data-icon-button={
        isIconOnly || size.startsWith("icon") ? iconStyle : undefined
      }
      data-variant={variant}
      data-autofocus={props.autoFocus || undefined}
      ref={ref}
      type={type}
      disabled={disabled || isDisabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onPress?.();
      }}
      className={cn(
        "button inline-flex h-8 shrink-0 items-center justify-center gap-2 [&_svg]:size-4 [&_svg]:text-text-secondary rounded-md px-3 text-[13px] hover:bg-hover disabled:cursor-default disabled:text-text-disabled",
        (isIconOnly || size.startsWith("icon")) && "size-8 p-0",
        (variant === "secondary" || variant === "outline") && "bg-selected",
        (variant === "danger" || variant === "destructive") && "text-warn",
        className,
      )}
    />
  );
});
