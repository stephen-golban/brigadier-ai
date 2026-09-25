import type { FC } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ContextUsage } from "@/ipc/generated";

/** Ring geometry in its 16-unit view box: a 2-unit stroke inside it. */
const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** "45k": tokens in thousands, as ChatGPT writes them. */
function thousands(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * How full the model's context is, as ChatGPT shows it by the model picker: a thin ring whose
 * arc is the share used (no number, no colour change), and on hover "Context window:",
 * "17% used (83% left)", "45k / 258k tokens used". With no known window only the tokens show.
 */
export const ContextRing: FC<{ usage: ContextUsage }> = ({ usage }) => {
  const { usedTokens, windowTokens } = usage;
  const share =
    windowTokens && windowTokens > 0 ? Math.min(1, Math.max(0, usedTokens / windowTokens)) : null;
  const percent = share === null ? null : Math.round(share * 100);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={
            percent === null
              ? `Context usage: ${thousands(usedTokens)} tokens`
              : `Context usage: ${percent}%`
          }
          className="flex size-control-sm shrink-0 items-center justify-center"
        >
          <svg viewBox="0 0 16 16" aria-hidden className="size-icon-md -rotate-90">
            <circle cx="8" cy="8" r={RADIUS} fill="none" className="stroke-muted stroke-2" />
            {share !== null && share > 0 && (
              <circle
                cx="8"
                cy="8"
                r={RADIUS}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${share * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                className="stroke-muted-foreground stroke-2"
              />
            )}
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex-col gap-0.5 px-3 py-2 text-center text-sm">
        <span className="text-muted-foreground">Context window:</span>
        {percent !== null && windowTokens ? (
          <>
            <span>
              {percent}% used ({100 - percent}% left)
            </span>
            <span>
              {thousands(usedTokens)} / {thousands(windowTokens)} tokens used
            </span>
          </>
        ) : (
          <span>{thousands(usedTokens)} tokens used</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
};
