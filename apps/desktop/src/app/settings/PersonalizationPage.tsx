import { Brain } from "@openai/apps-sdk-ui/components/Icon";
import { useEffect, useState } from "react";

import { ErrorLine, errorText } from "@/app/dialogs/fields";
import {
  SettingsButton,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SwitchSetting,
} from "@/app/settings/parts";
import { Spinner } from "@/components/glyphs/spinner";
import { useNow } from "@/hooks/use-now";
import type { Node, Origin } from "@/ipc/generated";
import { formatAgo } from "@/lib/format";
import { forgetMemory, listMemories } from "@/state/brain";
import { useApp } from "@/state/store";

/** The Personalization page's rows, for the page and for Settings search. */
export const PERSONALIZATION_ROWS = {
  enrichBrain: {
    label: "Use spare quota to deepen the Brain",
    description:
      "Before a usage window resets with quota left, a cheap model studies your projects further.",
  },
  memories: {
    label: "Memories",
    description: "What Brigadier remembers about you: your preferences, used by every Chat and session.",
  },
} as const;

export function PersonalizationPage() {
  return (
    <SettingsPage title="Personalization">
      <SettingsSection title="Brain">
        <SettingsCard>
          <SwitchSetting setting="enrichBrain" row={PERSONALIZATION_ROWS.enrichBrain} />
        </SettingsCard>
      </SettingsSection>
      <Memories />
    </SettingsPage>
  );
}

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

/** The Personal Brain's memories, newest first, each one forgotten at once on Forget. */
function Memories() {
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
    <SettingsSection
      title={PERSONALIZATION_ROWS.memories.label}
      description={PERSONALIZATION_ROWS.memories.description}
    >
      <ErrorLine error={error} />
      {memories === null && !error && (
        <p className="text-muted-foreground flex items-center gap-2 px-4 py-3 text-label">
          <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" />
          Loading memories…
        </p>
      )}
      {memories?.length === 0 && (
        <SettingsCard>
          <div className="text-muted-foreground flex items-center gap-3 px-4 py-3 text-label">
            <Brain aria-hidden className="size-icon-md shrink-0" />
            Nothing yet. Tell a Chat what you prefer (“remember that I use pnpm”) and it shows up
            here.
          </div>
        </SettingsCard>
      )}
      {memories && memories.length > 0 && (
        <SettingsCard>
          {memories.map((memory) => (
            <SettingsRow
              key={memory.id}
              label={<span className="wrap-break-word">{memory.title}</span>}
              description={
                <>
                  {memory.body && <span className="line-clamp-2">{memory.body}</span>}
                  <span>
                    {formatAgo(memory.updatedAtMs, now)} · <Source memory={memory} />
                  </span>
                </>
              }
            >
              <SettingsButton
                destructive
                aria-label={`Forget “${memory.title}”`}
                disabled={forgetting === memory.id}
                onClick={() => forget(memory.id)}
              >
                Forget
              </SettingsButton>
            </SettingsRow>
          ))}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
