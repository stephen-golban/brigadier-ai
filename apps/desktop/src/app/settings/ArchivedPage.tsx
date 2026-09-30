import { Archive, Chats, Folder, Trash } from "@openai/apps-sdk-ui/components/Icon";
import { useMemo, useState } from "react";

import { DeleteDialog } from "@/app/dialogs/DeleteDialog";
import { ErrorLine, errorText } from "@/app/dialogs/fields";
import {
  SettingsButton,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/app/settings/parts";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/ipc/generated";
import { formatDateTime } from "@/lib/format";
import { openConversation, restore } from "@/state/actions";
import { useApp } from "@/state/store";

/** The Archived page's rows, for Settings search. */
export const ARCHIVED_ROWS = {
  archived: {
    label: "Archived sessions and chats",
    description: "Hidden from the sidebar and cleaned up; restore one to continue it.",
  },
} as const;

type Group = { key: string; label: string; conversations: Conversation[] };

function useArchivedGroups(): Group[] {
  const conversations = useApp((s) => s.conversations);
  const projects = useApp((s) => s.projects);
  return useMemo(() => {
    const archived = Object.values(conversations)
      .filter((conversation) => conversation.lifecycle === "archived")
      .toSorted((a, b) => b.updatedAtMs - a.updatedAtMs);
    const groups = new Map<string, Group>();
    for (const conversation of archived) {
      const projectId = conversation.kind === "session" ? conversation.projectId : null;
      const key = projectId ?? "chats";
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          label: projectId ? (projects[projectId]?.name ?? "Project") : "Chats",
          conversations: [],
        };
        groups.set(key, group);
      }
      group.conversations.push(conversation);
    }
    // Projects first (in order of their newest archived session), chats last.
    return [...groups.values()].toSorted(
      (a, b) => Number(a.key === "chats") - Number(b.key === "chats"),
    );
  }, [conversations, projects]);
}

function countLabel(group: Group): string {
  const count = group.conversations.length;
  const noun = group.key === "chats" ? "chat" : "session";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Archived sessions and chats: hidden from the sidebar, cleaned up, and restorable. Their
 * transcripts and artifacts are kept.
 */
export function ArchivedPage() {
  const groups = useArchivedGroups();
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const onRestore = (id: string) => {
    setError(null);
    setBusy(id);
    restore(id)
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(null));
  };

  return (
    <SettingsPage
      title="Archived chats"
      description="Archived sessions and chats keep their transcript and artifacts; their workers, worktrees and processes are gone. Unmerged branches are kept."
    >
      <ErrorLine error={error} />
      {groups.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-sm">
          <Archive aria-hidden className="size-icon-lg" />
          Nothing archived.
        </div>
      )}
      {groups.map((group) => (
        <SettingsSection
          key={group.key}
          title={group.label}
          icon={
            group.key === "chats" ? (
              <Chats aria-hidden className="text-muted-foreground size-icon-md shrink-0" />
            ) : (
              <Folder aria-hidden className="text-muted-foreground size-icon-md shrink-0" />
            )
          }
          actions={<span className="text-muted-foreground text-label">{countLabel(group)}</span>}
        >
          <SettingsCard>
            {group.conversations.map((conversation) => (
              <SettingsRow
                key={conversation.id}
                label={
                  <button
                    type="button"
                    className="max-w-full truncate text-start hover:underline"
                    onClick={() => openConversation(conversation.id)}
                  >
                    {conversation.title}
                  </button>
                }
                description={formatDateTime(conversation.updatedAtMs)}
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete “${conversation.title}”…`}
                  title="Delete…"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleting(conversation)}
                >
                  <Trash />
                </Button>
                <SettingsButton
                  disabled={busy === conversation.id}
                  onClick={() => onRestore(conversation.id)}
                >
                  Unarchive
                </SettingsButton>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      ))}
      <DeleteDialog conversation={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </SettingsPage>
  );
}
