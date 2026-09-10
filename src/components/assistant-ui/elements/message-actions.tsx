// Installed from assistant-ui Elements (MIT); Brigadier theme and integration extensions.
"use client";

import type { ComponentProps } from "react";
import {
  ArrowRotateCw,
  Check,
  Copy,
  DotsHorizontal,
  ThumbDown,
  ThumbUp,
} from "../../../icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { iconSwap, iconSwapIn, iconSwapOut } from "@/lib/surfaces";

export type Reaction = "up" | "down" | null;

export interface MessageActionsProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  copied: boolean;
  copyLabel?: string;
  reaction?: Reaction;
  regenerating?: boolean;
  onCopy: () => void;
  onReactionChange?: (reaction: Reaction) => void;
  onRegenerate?: () => void;
  onMore?: () => void;
}

/**
 * The kit's `ghost` variant at `icon-sm` is the same 28px box the retired `ghostButton`
 * recipe drew; the pill radius and the resting ink are all that stay local.
 */
const action = "rounded-full text-text/45";

/** The kit's `aria-pressed` fill lives in `controls/button`, which these rows do not use. */
const pressed = "bg-text/[0.09] text-text/90";

export function MessageActions({
  copied,
  copyLabel,
  reaction,
  regenerating,
  onCopy,
  onReactionChange,
  onRegenerate,
  onMore,
  className,
  ...props
}: MessageActionsProps) {
  return (
    <div
      data-slot="message-actions"
      className={cn("flex items-center gap-1", className)}

      {...props}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copyLabel ?? (copied ? "Copied response" : "Copy response")}
        title={copyLabel ?? (copied ? "Copied response" : "Copy response")}
        onClick={onCopy}
        className={cn(action, "grid place-items-center", copied && "text-ok")}
      >
        <Copy
          className={cn(
            iconSwap,
            "size-3.5",
            copied ? iconSwapOut : iconSwapIn,
          )}
        />
        <Check
          className={cn(
            iconSwap,
            "size-3.5",
            copied ? iconSwapIn : iconSwapOut,
          )}
        />
      </Button>
      {onReactionChange && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Mark response helpful"
            aria-pressed={reaction === "up"}
            onClick={() => onReactionChange(reaction === "up" ? null : "up")}
            className={cn(action, reaction === "up" && pressed)}
          >
            <ThumbUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Mark response unhelpful"
            aria-pressed={reaction === "down"}
            onClick={() =>
              onReactionChange(reaction === "down" ? null : "down")
            }
            className={cn(action, reaction === "down" && pressed)}
          >
            <ThumbDown className="size-3.5" />
          </Button>
        </>
      )}
      {onRegenerate && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Regenerate response"
          onClick={onRegenerate}
          className={action}
        >
          <ArrowRotateCw
            className={cn(
              "size-3.5",
              regenerating && "animate-spin motion-reduce:animate-none",
            )}
          />
        </Button>
      )}
      {onMore && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="More response actions"
          onClick={onMore}
          className={action}
        >
          <DotsHorizontal className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
