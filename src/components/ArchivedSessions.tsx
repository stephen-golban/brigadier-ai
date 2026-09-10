import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, DotsHorizontal, Filter, Folder, Search, Trash } from "../icons";
import { Input } from "./controls/input";
import { Button } from "./controls/button";
import { Dropdown } from "./controls/overlay";
import { DropdownContent } from "./controls/menu";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import type { SessionRuntime } from "../feedStore";
import type { ProjectView } from "../wire";
import {
  deleteArchivedSession,
  syncArchive,
  useSessionArchive,
} from "../sessionArchive";
import { setSessionArchived } from "../sessionNavigation";
import { errorMessage } from "../workspaceApi";
import { notify } from "../desktopApi";
import { ArchiveSettings } from "./ArchiveSettings";

type Kind = "all" | "worktree" | "local";
const kinds: Record<Kind, string> = {
  all: "All chats",
  worktree: "With a worktree",
  local: "Without a worktree",
};
export function ArchivedSessions({
  sessions,
  titles,
  projects,
  projectNames,
  origins,
  highlightId,
}: {
  sessions: Record<string, SessionRuntime>;
  titles: Record<string, string>;
  projects: ProjectView[];
  projectNames: Record<string, string>;
  origins: Record<string, string>;
  highlightId?: string;
}) {
  const { entries, settings } = useSessionArchive();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [project, setProject] = useState("all");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const highlighted = useRef<HTMLDivElement>(null);
  const title = (id: string) => titles[id] ?? `Session ${id.slice(-6)}`;
  const projectName = (id: string | null) =>
    id
      ? (projectNames[id] ??
        projects.find((item) => item.id === id)?.name ??
        "Unavailable project")
      : "No project";
  const archived = Object.values(sessions).filter(
    (session) => entries[session.sessionId] && !origins[session.sessionId],
  );
  const filtered = archived
    .filter(
      (session) =>
        title(session.sessionId)
          .toLowerCase()
          .includes(query.trim().toLowerCase()) &&
        (kind === "all" ||
          (kind === "worktree"
            ? !!session.worktreePath
            : !session.worktreePath)) &&
        (project === "all" || (session.projectId ?? "none") === project),
    )
    .sort(
      (a, b) =>
        entries[b.sessionId].archivedAt - entries[a.sessionId].archivedAt,
    );
  const groups = new Map<string | null, SessionRuntime[]>();
  for (const session of filtered)
    groups.set(session.projectId, [
      ...(groups.get(session.projectId) ?? []),
      session,
    ]);
  const projectIds = [...new Set(archived.map((session) => session.projectId))];
  useEffect(() => {
    if (highlightId) {
      setQuery("");
      setKind("all");
      setProject("all");
    }
  }, [highlightId]);
  useEffect(() => {
    highlighted.current?.scrollIntoView?.({
      block: "center",
      behavior: "smooth",
    });
  }, [highlightId, query, kind, project]);
  const run = async (
    ids: string[],
    action: (id: string) => Promise<unknown>,
  ) => {
    setBusy((old) => new Set([...old, ...ids]));
    try {
      for (const id of ids) await action(id);
    } catch (error) {
      // The backend persists each successful deletion, even if a later one fails.
      await syncArchive().catch(() => {});
      notify(errorMessage(error), true);
    } finally {
      setBusy((old) => new Set([...old].filter((id) => !ids.includes(id))));
    }
  };
  const confirmDelete = (items: SessionRuntime[], scope: string) => {
    const ids = items.map((session) => session.sessionId);
    setConfirmation({
      title: `Delete ${ids.length} archived ${ids.length === 1 ? "chat" : "chats"}?`,
      body: `${scope} Permanently delete these chats, everything inside them, and their exclusively owned worktrees, including uncommitted changes? This cannot be undone.`,
      confirmLabel: "Delete all",
      onCancel: () => setConfirmation(null),
      onConfirm: async () => {
        await run(ids, deleteArchivedSession);
        setConfirmation(null);
      },
    });
  };
  return (
    <section className="archive-page" aria-label="Archived chats">
      <header className="settings-page-heading">
        <h1>Archived chats</h1>
        <Button
          className="archive-delete-all"
          disabled={!filtered.length || busy.size > 0}
          onClick={() =>
            confirmDelete(
              filtered,
              `This includes ${filtered.length} chats matching the current search and filters${project !== "all" ? ` in ${projectName(project === "none" ? null : project)}` : " across all projects"}.`,
            )
          }
        >
          <Trash />
          Delete all
        </Button>
      </header>
      <details className="archive-retention">
        <summary>
          <span>Archive retention</span>
          <span className="archive-retention-status">
            {settings.autoDelete
              ? `Auto-delete after ${settings.retentionDays} ${settings.retentionDays === 1 ? "day" : "days"}`
              : "Automatic deletion off"}
          </span>
          <ChevronDown width={16} height={16} aria-hidden="true" />
        </summary>
        <div className="settings-section">
          <ArchiveSettings />
        </div>
      </details>
      <div className="archive-filters">
        <label className="settings-search archive-search">
          <Search width={17} height={17} />
          <Input
            aria-label="Search archived chats"
            placeholder="Search archived chats"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Dropdown>
          <Button className="archive-filter" aria-label="Filter chats">
            <Filter />
            {kinds[kind]}
            <ChevronDown />
          </Button>
          <DropdownContent>
            {(Object.keys(kinds) as Kind[]).map((value) => (
              <Dropdown.Item key={value} onAction={() => setKind(value)}>
                {kinds[value]}
              </Dropdown.Item>
            ))}
          </DropdownContent>
        </Dropdown>
        <Dropdown>
          <Button className="archive-filter" aria-label="Filter projects">
            <Folder />
            <span>
              {project === "all"
                ? "All projects"
                : projectName(project === "none" ? null : project)}
            </span>
            <ChevronDown />
          </Button>
          <DropdownContent>
            <Dropdown.Item onAction={() => setProject("all")}>
              All projects
            </Dropdown.Item>
            {projectIds.map((id) => (
              <Dropdown.Item
                key={id ?? "none"}
                onAction={() => setProject(id ?? "none")}
              >
                {projectName(id)}
              </Dropdown.Item>
            ))}
          </DropdownContent>
        </Dropdown>
      </div>
      {!filtered.length && (
        <div className="archive-empty">
          <Archive width={28} height={28} />
          <h2>{archived.length ? "No matching chats" : "No archived chats"}</h2>
          <p>
            {archived.length
              ? "Try another search or change your filters."
              : "Chats you archive will appear here."}
          </p>
        </div>
      )}
      <div className="archive-groups">
        {[...groups].map(([projectId, items]) => (
          <section
            className="archive-group"
            key={projectId ?? "none"}
            aria-label={projectName(projectId)}
          >
            <header className="archive-group-heading">
              <Folder width={17} height={17} />
              <h2>{projectName(projectId)}</h2>
              <span>
                {items.length} {items.length === 1 ? "chat" : "chats"}
              </span>
              <Dropdown>
                <Button
                  size="icon-xs"
                  aria-label={`Actions for ${projectName(projectId)}`}
                >
                  <DotsHorizontal />
                </Button>
                <DropdownContent>
                  <Dropdown.Item
                    onAction={() =>
                      void run(
                        items.map((item) => item.sessionId),
                        (id) => setSessionArchived(id, false),
                      )
                    }
                    isDisabled={busy.size > 0}
                  >
                    Unarchive all in project
                  </Dropdown.Item>
                  <Dropdown.Item
                    onAction={() =>
                      confirmDelete(
                        items,
                        `This includes the ${items.length} matching chats in ${projectName(projectId)}.`,
                      )
                    }
                    isDisabled={busy.size > 0}
                  >
                    Delete all in project
                  </Dropdown.Item>
                </DropdownContent>
              </Dropdown>
            </header>
            <div className="archive-rows">
              {items.map((session) => {
                const id = session.sessionId,
                  entry = entries[id];
                return (
                  <div
                    key={id}
                    ref={id === highlightId ? highlighted : undefined}
                    className={`archive-row${id === highlightId ? " archive-row-highlight" : ""}`}
                    aria-busy={busy.has(id)}
                  >
                    <div className="archive-row-copy">
                      <div className="archive-row-title" title={title(id)}>
                        {title(id)}
                      </div>
                      <time
                        dateTime={new Date(entry.archivedAt).toISOString()}
                        title={
                          settings.autoDelete
                            ? `Automatically deletes ${new Date(entry.archivedAt + settings.retentionDays * 86400000).toLocaleString()}`
                            : "Kept until deleted"
                        }
                      >
                        {new Date(entry.archivedAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </time>
                      {entry.needsReview && (
                        <p className="archive-row-error">
                          Cleanup failed: {entry.needsReview}
                        </p>
                      )}
                    </div>
                    <Button
                      size="icon-xs"
                      className="archive-row-delete"
                      aria-label={`Delete ${title(id)}`}
                      title="Permanently delete chat"
                      disabled={busy.has(id)}
                      onClick={() => void run([id], deleteArchivedSession)}
                    >
                      <Trash />
                    </Button>
                    <Button
                      className="archive-unarchive"
                      aria-label={`Unarchive ${title(id)}`}
                      disabled={busy.has(id)}
                      onClick={() =>
                        void run([id], (id) => setSessionArchived(id, false))
                      }
                    >
                      Unarchive
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {confirmation && <ConfirmDialog {...confirmation} />}
    </section>
  );
}
