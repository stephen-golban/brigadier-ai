import { Archive, Chat, Terminal, Trash, Unarchive } from "@openai/apps-sdk-ui/components/Icon";
import { useMemo, useState } from "react";

import { DeleteDialog } from "@/app/dialogs/DeleteDialog";
import { errorText } from "@/app/dialogs/fields";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/ipc/generated";
import { formatDateTime } from "@/lib/format";
import { openConversation, restore } from "@/state/actions";
import { useApp } from "@/state/store";

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

/**
 * Archived sessions and chats: hidden from the sidebar, cleaned up, and restorable. Their
 * transcripts and artifacts are kept.
 */
export function ArchivedView() {
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
    <div className="h-full overflow-y-auto">
      <div className="max-w-thread mx-auto flex flex-col gap-6 px-4 py-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl">Archived</h1>
          <p className="text-muted-foreground text-sm">
            Archived sessions and chats keep their transcript and artifacts; their workers,
            worktrees and processes are gone. Unmerged branches are kept. Restore one to continue
            it.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {groups.length === 0 && (
          <div className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-sm">
            <Archive className="size-icon-lg" />
            Nothing archived.
          </div>
        )}
        {groups.map((group) => (
          <section key={group.key} aria-label={group.label} className="flex flex-col gap-1">
            <h2 className="text-muted-foreground px-2 text-xs font-medium">{group.label}</h2>
            <ul className="flex flex-col">
              {group.conversations.map((conversation) => {
                const Icon = conversation.kind === "session" ? Terminal : Chat;
                return (
                  <li
                    key={conversation.id}
                    data-slot="archived-row"
                    className="hover:bg-accent/50 rounded-control flex items-center gap-2 px-2 py-1.5"
                  >
                    <Icon className="text-muted-foreground size-icon-md shrink-0" />
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-start text-sm hover:underline"
                      onClick={() => openConversation(conversation.id)}
                    >
                      {conversation.title}
                    </button>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatDateTime(conversation.updatedAtMs)}
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy === conversation.id}
                      onClick={() => onRestore(conversation.id)}
                    >
                      <Unarchive />
                      Restore
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-destructive"
                      onClick={() => setDeleting(conversation)}
                    >
                      <Trash />
                      Delete…
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <DeleteDialog conversation={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </div>
  );
}
