import { useState } from "react";
import { Input } from "./controls/input";
import { Button } from "./controls/button";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import { ChatCircleIcon, TrashIcon } from "@phosphor-icons/react";
import type { SessionRuntime } from "../feedStore";
import {
  deleteArchivedSession,
  type ArchiveEntry,
  type ArchiveSettings,
} from "../sessionArchive";
import { errorMessage } from "../workspaceApi";
export function ProjectHistory({
  projectName,
  sessions,
  titles,
  entries,
  settings,
  onSelect,
}: {
  projectName: string;
  sessions: SessionRuntime[];
  titles: Record<string, string>;
  entries: Record<string, ArchiveEntry>;
  settings: ArchiveSettings;
  onSelect: (id: string) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState("");
  const remove = (s: SessionRuntime, worktree: boolean) =>
    setConfirmation({
      native: true,
      title: "Delete archived session?",
      body: worktree
        ? "Permanently delete this conversation and its worktree, discarding any uncommitted files? Git branches will remain. This cannot be undone."
        : "Permanently delete this conversation? Its files and worktree will stay on disk. This cannot be undone.",
      confirmLabel: "Delete",
      onCancel: () => setConfirmation(null),
      onConfirm: async () => {
        await deleteArchivedSession(s.sessionId, worktree, worktree);
        setConfirmation(null);
      },
    });
  return (
    <section
      className="project-history h-full overflow-auto p-3"
      aria-label="Archived sessions"
    >
      <header className="mb-3">
        <h2 className="text-sm text-text">History</h2>
        <p className="text-xs text-text-tertiary">
          {projectName} · Archived sessions
        </p>
      </header>
      <Input
        aria-label="Search session history"
        placeholder="Filter history…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-col gap-2">
        {sessions
          .filter((s) =>
            (titles[s.sessionId] ?? s.sessionId)
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .sort(
            (a, b) =>
              entries[b.sessionId].archivedAt - entries[a.sessionId].archivedAt,
          )
          .map((s) => {
            const entry = entries[s.sessionId];
            const days = Math.max(
              0,
              Math.ceil(
                (entry.archivedAt +
                  settings.retentionDays * 86400000 -
                  Date.now()) /
                  86400000,
              ),
            );
            return (
              <div
                key={s.sessionId}
                className="rounded-lg border border-hairline p-2"
              >
                <Button
                  className="h-auto w-full justify-start gap-2 p-1 text-left"
                  onClick={() => {
                    void Promise.resolve(onSelect(s.sessionId)).catch((e) =>
                      setError(errorMessage(e)),
                    );
                  }}
                >
                  <ChatCircleIcon className="shrink-0" />
                  <span className="min-w-0 truncate text-xs">
                    {titles[s.sessionId] ?? `Session ${s.sessionId.slice(-6)}`}
                  </span>
                </Button>
                <p className="mt-1 text-[10px] text-text-tertiary">
                  Archived {new Date(entry.archivedAt).toLocaleDateString()} ·{" "}
                  {entry.needsReview
                    ? "Needs review"
                    : settings.autoDelete
                      ? days
                        ? `Deletes in ${days} ${days === 1 ? "day" : "days"}`
                        : "Cleanup pending"
                      : "Kept until deleted"}
                </p>
                {entry.needsReview && (
                  <p className="mt-1 text-xs text-text-secondary">
                    {entry.needsReview}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                  <Button
                    className="h-6 px-1 text-[10px] text-text-secondary"
                    onClick={() => remove(s, false)}
                  >
                    <TrashIcon size={11} />
                    Delete, keep files
                  </Button>
                  {s.worktreePath && (
                    <Button
                      className="h-6 px-1 text-[10px] text-text-secondary"
                      onClick={() => remove(s, true)}
                    >
                      Delete with worktree
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
      </div>
      {confirmation && <ConfirmDialog {...confirmation} />}
    </section>
  );
}
