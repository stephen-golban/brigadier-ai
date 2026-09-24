import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  type FoldedTranscript,
  TranscriptFolder,
} from "@/components/transcript/transcript";
import { TranscriptRow } from "@/components/transcript/TranscriptRow";
import { Button } from "@/components/ui/button";
import type { RawEntry } from "@/ipc/generated";
import { tokenPx } from "@/lib/tokens";
import { loadEarlierWorkerEntries, openWorkerTranscript } from "@/state/actions";
import { useBoard } from "@/state/board";

const NO_ENTRIES: RawEntry[] = [];

/**
 * Folds a growing transcript incrementally: live entries are applied on top of what was
 * folded; a reload or an older page (a different first entry) folds from scratch.
 */
class IncrementalFold {
  private folder = new TranscriptFolder();
  private first: RawEntry | undefined;

  fold(entries: readonly RawEntry[]): FoldedTranscript {
    if (entries[0] !== this.first) {
      this.folder = new TranscriptFolder();
      this.first = entries[0];
    }
    return this.folder.push(entries);
  }
}

/**
 * A worker's live transcript, shared with the Inspector's raw sessions. It loads when the
 * card opens and renders only the rows in view.
 */
export function WorkerTranscript({
  conversationId,
  taskId,
}: {
  conversationId: string;
  taskId: string;
}) {
  const transcript = useBoard((s) => s.board?.transcripts[taskId]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void openWorkerTranscript(conversationId, taskId).catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [conversationId, taskId]);

  const [folding] = useState(() => new IncrementalFold());
  const entries = transcript?.entries ?? NO_ENTRIES;
  const { items } = useMemo(() => folding.fold(entries), [folding, entries]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // The app does not use React Compiler, so the virtualizer's unmemoizable API is fine here.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => tokenPx("--spacing-row"),
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 8,
  });

  // Follow new output while the view is scrolled to the bottom.
  useLayoutEffect(() => {
    if (pinned.current && items.length > 0) {
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    }
  }, [items, virtualizer]);

  return (
    <div data-slot="worker-transcript" className="flex flex-col gap-1.5">
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {transcript?.hasMore && (
        <Button
          size="xs"
          variant="ghost"
          className="self-center"
          disabled={transcript.loading}
          onClick={() => void loadEarlierWorkerEntries(conversationId, taskId)}
        >
          Load earlier events
        </Button>
      )}
      <div
        ref={scrollRef}
        data-selectable
        className="bg-code-surface rounded-control max-h-96 overflow-y-auto text-xs"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < tokenPx("--spacing-row");
        }}
      >
        {items.length === 0 ? (
          <p className="text-muted-foreground p-2.5">
            {!transcript || transcript.loading ? "Loading…" : "No events yet."}
          </p>
        ) : (
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = items[row.index];
              if (!item) return null;
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0 flex flex-col px-2.5 py-1"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <TranscriptRow item={item} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
