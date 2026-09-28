import { Trash } from "@openai/apps-sdk-ui/components/Icon";
import { useEffect, useState } from "react";

import { ErrorLine, errorText } from "@/app/dialogs/fields";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/glyphs/spinner";
import { useNow } from "@/hooks/use-now";
import type { Node, Origin } from "@/ipc/generated";
import { formatAgo } from "@/lib/format";
import { forgetMemory, listMemories } from "@/state/brain";
import { useApp } from "@/state/store";

const ORIGINS: Record<Origin, string> = {
  index: "the code index",
  skeleton: "a skeleton pass",
  enrichment: "an enrichment job",
  report: "a worker's report",
  orchestrator: "a session",
  user: "you",
};

/** Where a memory was learned: the conversation's title while it exists, else its origin. */
function Source({ memory }: { memory: Node }) {
  const { sessionId, origin } = memory.provenance;
  const conversation = useApp((s) => (sessionId ? s.conversations[sessionId] : undefined));
  if (conversation) {
    return (
      <>
        from the {conversation.kind === "chat" ? "chat" : "session"} “{conversation.title}”
      </>
    );
  }
  return <>from {ORIGINS[origin]}</>;
}

/**
 * The Personal Brain's memories: what Chats and sessions remembered about the user, newest
 * first, each removable. Removing one takes effect at once (not on Save).
 */
export function MemoriesSection() {
  const [memories, setMemories] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const now = useNow(60_000);

  useEffect(() => {
    let current = true;
    listMemories().then(
      (list) => current && setMemories(list),
      (cause: unknown) => current && setError(errorText(cause)),
    );
    return () => {
      current = false;
    };
  }, []);

  const forget = (id: string) => {
    setForgetting(id);
    setError(null);
    forgetMemory(id)
      .then(() => setMemories((list) => list?.filter((memory) => memory.id !== id) ?? null))
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setForgetting(null));
  };

  return (
    <section aria-labelledby="settings-memories" className="grid gap-1.5">
      <h3 id="settings-memories" className="text-muted-foreground text-xs">
        Memories
      </h3>
      <p className="text-muted-foreground text-xs">
        What Brigadier remembers about you: your preferences, used by every Chat and session.
      </p>
      {memories === null && !error && (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Spinner className="size-icon-sm animate-spin" />
          Loading memories…
        </p>
      )}
      {memories?.length === 0 && (
        <p className="text-muted-foreground bg-muted/50 rounded-control px-3 py-2 text-xs">
          Nothing yet. Tell a Chat what you prefer (“remember that I use pnpm”) and it shows up
          here.
        </p>
      )}
      {memories && memories.length > 0 && (
        <ul className="divide-border rounded-control max-h-60 divide-y overflow-y-auto border">
          {memories.map((memory) => (
            <li key={memory.id} className="flex items-start gap-2 px-3 py-2">
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-sm wrap-break-word">{memory.title}</span>
                {memory.body && (
                  <span className="text-muted-foreground line-clamp-2 text-xs">{memory.body}</span>
                )}
                <span className="text-muted-foreground text-xs">
                  {formatAgo(memory.updatedAtMs, now)} · <Source memory={memory} />
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Forget “${memory.title}”`}
                title="Forget"
                disabled={forgetting === memory.id}
                onClick={() => forget(memory.id)}
              >
                <Trash />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} />
    </section>
  );
}
