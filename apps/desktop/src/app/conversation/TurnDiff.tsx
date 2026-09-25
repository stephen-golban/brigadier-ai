import { ArrowRotateCcw, ArrowRotateCw } from "@openai/apps-sdk-ui/components/Icon";
import { type FC, useState } from "react";

import { isFinal } from "@/app/conversation/blocks";
import { useRequestDiff } from "@/app/conversation/ComposerCapsule";
import { paper } from "@/components/assistant-ui/elements/surfaces";
import { Button } from "@/components/ui/button";
import { request } from "@/ipc/client";
import { cn } from "@/lib/utils";
import { useBoard } from "@/state/board";
import { selectedConversation, useApp } from "@/state/store";
import { toast } from "@/state/toasts";

/** ChatGPT's diff glyph: a square with a plus over a minus. */
function DiffGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" fillRule="evenodd" className={className}>
      <path d="M6.5 3h7A3.5 3.5 0 0 1 17 6.5v7a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 3 13.5v-7A3.5 3.5 0 0 1 6.5 3Zm0 1.5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2ZM10 6a.75.75 0 0 1 .75.75V8H12a.75.75 0 0 1 0 1.5h-1.25v1.25a.75.75 0 0 1-1.5 0V9.5H8A.75.75 0 0 1 8 8h1.25V6.75A.75.75 0 0 1 10 6Zm-2 6.25h4a.75.75 0 0 1 0 1.5H8a.75.75 0 0 1 0-1.5Z" />
    </svg>
  );
}

const Counts: FC<{ insertions: number; deletions: number; className?: string }> = ({
  insertions,
  deletions,
  className,
}) => (
  <span className={cn("tabular-nums", className)}>
    <span className="text-success">+{insertions}</span>{" "}
    <span className="text-destructive">−{deletions}</span>
  </span>
);

/**
 * ChatGPT's card under a finished turn's answer: "Edited N files +a −d", one row per file, and
 * Undo, which turns into Reapply. It sums what the request's workers landed, so it keeps its
 * counts in both states; a request that landed nothing has no card.
 */
export const TurnDiff: FC<{ requestId: string }> = ({ requestId }) => {
  const conversationId = useApp((s) => selectedConversation(s)?.id ?? null);
  const diff = useRequestDiff(requestId);
  const reverted = useBoard((s) => s.board?.requests[requestId]?.undo?.reverted ?? false);
  // Undo waits for the request's workers: one still at work may land more.
  const working = useBoard((s) =>
    Object.values(s.board?.tasks ?? {}).some(
      (task) => task.requestId === requestId && !isFinal(task),
    ),
  );
  const [busy, setBusy] = useState(false);
  if (!diff || !conversationId) return null;

  const files = diff.files.length;
  const toggle = () => {
    setBusy(true);
    request({ method: "undoChanges", conversationId, requestId, reapply: reverted })
      .then(() => toast(reverted ? "Changes reapplied" : "Changes reverted"))
      .catch((error: unknown) =>
        toast(
          `Failed to revert changes: ${error instanceof Error ? error.message : String(error)}`,
          { tone: "error" },
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div data-slot="turn-diff" className={cn(paper, "rounded-xl overflow-hidden")}>
      <div className="flex items-center gap-3 p-2">
        <span className="bg-foreground/5 text-muted-foreground rounded-control flex size-control-lg shrink-0 items-center justify-center">
          <DiffGlyph className="size-icon-md" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-foreground text-sm">
            Edited {files} {files === 1 ? "file" : "files"}
          </span>
          <Counts insertions={diff.insertions} deletions={diff.deletions} className="text-xs" />
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || working}
          onClick={toggle}
          className="text-muted-foreground hover:text-foreground font-normal"
        >
          {reverted ? "Reapply" : "Undo"}
          {reverted ? <ArrowRotateCw className="size-icon-sm" /> : <ArrowRotateCcw className="size-icon-sm" />}
        </Button>
      </div>
      <ul>
        {diff.files.map((file) => (
          <li
            key={file.path}
            className="border-border flex h-control-md items-center gap-3 border-t px-3 text-sm"
          >
            <span className="text-foreground min-w-0 flex-1 truncate" title={file.path}>
              {file.path}
            </span>
            {file.binary ? (
              <span className="text-muted-foreground text-xs">binary</span>
            ) : (
              <Counts insertions={file.insertions} deletions={file.deletions} className="text-xs" />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
