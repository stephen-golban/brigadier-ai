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
import { cn } from "@/lib/utils";
import { ghostButton, iconSwap, iconSwapIn, iconSwapOut } from "@/lib/surfaces";

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
  const buttonClassName = cn(ghostButton, "size-7");

  return (
    <div
      data-slot="message-actions"
      className={cn("flex items-center gap-1", className)}

      {...props}
    >
      <button
        type="button"
        aria-label={copyLabel ?? (copied ? "Copied response" : "Copy response")}
        title={copyLabel ?? (copied ? "Copied response" : "Copy response")}
        onClick={onCopy}
        className={cn(
          buttonClassName,
          "grid place-items-center",
          copied && "text-ok",
        )}
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
      </button>
      {onReactionChange && (
        <>
          <button
            type="button"
            aria-label="Mark response helpful"
            aria-pressed={reaction === "up"}
            onClick={() => onReactionChange(reaction === "up" ? null : "up")}
            className={cn(
              buttonClassName,
              reaction === "up" &&
                "bg-text/[0.06] text-text/90 dark:bg-text/[0.09]",
            )}
          >
            <ThumbUp className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Mark response unhelpful"
            aria-pressed={reaction === "down"}
            onClick={() =>
              onReactionChange(reaction === "down" ? null : "down")
            }
            className={cn(
              buttonClassName,
              reaction === "down" &&
                "bg-text/[0.06] text-text/90 dark:bg-text/[0.09]",
            )}
          >
            <ThumbDown className="size-3.5" />
          </button>
        </>
      )}
      {onRegenerate && (
        <button
          type="button"
          aria-label="Regenerate response"
          onClick={onRegenerate}
          className={buttonClassName}
        >
          <ArrowRotateCw
            className={cn(
              "size-3.5",
              regenerating && "animate-spin motion-reduce:animate-none",
            )}
          />
        </button>
      )}
      {onMore && (
        <button
          type="button"
          aria-label="More response actions"
          onClick={onMore}
          className={buttonClassName}
        >
          <DotsHorizontal className="size-3.5" />
        </button>
      )}
    </div>
  );
}
