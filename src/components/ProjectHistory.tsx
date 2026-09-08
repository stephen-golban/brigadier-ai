import { Input } from "./controls/input";
import { Button } from "./controls/button";
import { navigationApi } from "../navigationApi";
import { ActionDialog, type PendingAction } from "./ActionDialog";
import { useState } from "react";
import { ChatCircleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { SessionRuntime } from "../feedStore";
import { working } from "../attention";
import { notify } from "../desktopApi";
import { errorMessage } from "../workspaceApi";
export function ProjectHistory({
  projectName,
  sessions,
  titles,
  attention,
  onSelect,
  onNew,
}: {
  projectName: string;
  sessions: SessionRuntime[];
  titles: Record<string, string>;
  attention: Record<string, boolean>;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<PendingAction | null>(null);
  return (
    <section className="project-history mx-auto w-full max-w-[780px] overflow-auto p-6 [&_header]:mb-4 [&_header]:flex [&_header]:items-center [&_header]:gap-3">
      <header>
        <ChatCircleIcon size={28} />
        <h1>{projectName}</h1>
        <Button className="act" onClick={onNew}>
          <PlusIcon />
          New session
        </Button>
      </header>
      <Input
        aria-label="Search session history"
        placeholder="Search past sessions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="history-list flex flex-col gap-1 [&>div]:flex [&>div]:items-center [&>div]:gap-2 [&_small]:block [&_small]:text-text-tertiary">
        {sessions
          .filter((s) =>
            (titles[s.sessionId] ?? s.sessionId)
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0))
          .map((s) => (
            <div key={s.sessionId}>
              <Button onClick={() => onSelect(s.sessionId)}>
                <ChatCircleIcon />
                <span>
                  {titles[s.sessionId] ?? `Session ${s.sessionId.slice(-6)}`}
                  <small>
                    {s.startedAtMs
                      ? new Date(s.startedAtMs).toLocaleString()
                      : "Saved session"}{" "}
                    ·{" "}
                    {working(s)
                      ? "Working"
                      : s.status === "failed"
                        ? "Interrupted — resume when ready"
                        : "Saved"}
                  </small>
                </span>
                {working(s) && <i className="status-spinner" />}
                {attention[s.sessionId] && (
                  <i className="attention-dot inline-block size-1.5 rounded-full bg-text-secondary" />
                )}
              </Button>
              <Button
                isIconOnly
                className="icon-button size-8 p-0"
                aria-label={`Move session to Trash ${s.sessionId}`}
                onClick={() => {
                  void navigationApi
                    .preview("session", s.sessionId)
                    .then((plan) =>
                      setDeleting({
                        title: plan.running.length
                          ? "Stop and move to Trash?"
                          : "Move to Trash?",
                        description: (
                          <>
                            <p>
                              This session and its child agents can be restored
                              from Trash. Repository files and worktrees stay on
                              disk.
                            </p>
                            {plan.running.length > 0 && (
                              <p>
                                Running sessions to stop:{" "}
                                {plan.running
                                  .map((id) => titles[id] ?? id)
                                  .join(", ")}
                              </p>
                            )}
                          </>
                        ),
                        label: "Move to Trash",
                        destructive: true,
                        run: async () => {
                          await navigationApi.move(plan);
                        },
                      }),
                    )
                    .catch((e) => notify(errorMessage(e), true));
                }}
              >
                <TrashIcon />
              </Button>
            </div>
          ))}
      </div>
      {!sessions.length && (
        <p className="history-empty">Your past sessions will appear here.</p>
      )}
      {deleting && (
        <ActionDialog action={deleting} onClose={() => setDeleting(null)} />
      )}
    </section>
  );
}
