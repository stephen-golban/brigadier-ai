import { FolderIcon } from "./NavigationIcons";
import { Popover } from "./controls/overlay";
import { Spinner } from "./controls/status";
import { Details, DetailsSummary } from "./controls/details";
import { Button } from "./controls/button";
import { readActivity, type AgentActivity } from "../sessionApi";
import { RewindHistory } from "./RewindHistory";
import { useEffect, useState } from "react";
import {
  GitBranchIcon,
  GitDiffIcon,
  SlidersHorizontalIcon,
  UsersThreeIcon,
  ArrowSquareOutIcon,
  GearSixIcon,
} from "@phosphor-icons/react";
import type { SessionRuntime } from "../feedStore";
import type { PeerData } from "../peerApi";
import { useSessionChanges } from "../desktopApi";
import { working } from "../attention";
export function SessionCard({
  session,
  sessions,
  peers,
  onSelect,
  onChanges,
  onSettings,
}: {
  session: SessionRuntime;
  sessions: Record<string, SessionRuntime>;
  peers: PeerData;
  onSelect: (id: string) => void;
  onChanges: () => void;
  onSettings: () => void;
}) {
  const [savedHistory, setSavedHistory] = useState(false);
  const [native, setNative] = useState<AgentActivity | null>(null);
  useEffect(() => {
    setNative(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await readActivity(session.sessionId);
        if (live) setNative(next);
      } catch {
      } finally {
        if (live) timer = setTimeout(read, 3000);
      }
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [session.sessionId]);
  const [open, setOpen] = useState(false);
  const changes = useSessionChanges(session.sessionId);
  const ids = new Set([session.sessionId]);
  let previous = 0;
  while (previous !== ids.size) {
    previous = ids.size;
    for (const [id, parent] of Object.entries(peers.origins))
      if (ids.has(parent)) ids.add(id);
  }
  ids.delete(session.sessionId);
  const agents = [...ids].map((id) => sessions[id]).filter(Boolean);
  const added = changes.files.reduce((n, f) => n + f.added, 0),
    deleted = changes.files.reduce((n, f) => n + f.deleted, 0);
  return (
    <>
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Button
          isIconOnly
          className="icon-button environment-trigger size-8 p-0 self-end m-2 text-text-secondary"
          aria-label="Environment and agents"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <SlidersHorizontalIcon size={19} />
        </Button>
        <Popover.Content placement="bottom start">
          <Popover.Dialog
            className="session-card flex w-[304px] max-h-[65dvh] flex-col gap-3 overflow-auto p-3 text-[13px] text-text-secondary [&_svg]:size-4"
            aria-label="Session environment"
          >
            <h3>Environment</h3>
            <Button onClick={onChanges}>
              <GitDiffIcon />
              <span>Changes</span>
              <span className="change-count">
                <i className="added text-ok not-italic">
                  +{added.toLocaleString()}
                </i>{" "}
                <i className="removed text-error not-italic">
                  −{deleted.toLocaleString()}
                </i>
              </span>
            </Button>
            <div title={session.cwd ?? undefined}>
              <FolderIcon />
              <span>
                {session.worktreePath ? "Worktree" : "Project folder"}
              </span>
            </div>
            <div title={session.branch ?? undefined}>
              <GitBranchIcon />
              <span>{session.branch ?? "No Git branch"}</span>
            </div>
            <Button onClick={onSettings}>
              <GearSixIcon />
              <span>Session settings</span>
            </Button>
            <Button onClick={() => setSavedHistory(true)}>
              <ArrowSquareOutIcon />
              <span>Saved history</span>
            </Button>
            <section>
              <h3>Agents</h3>
              {native?.agents.map((agent) => (
                <Details key={agent.id}>
                  <DetailsSummary>
                    {agent.description || agent.id}
                    <small>{agent.status}</small>
                  </DetailsSummary>
                  <p>{agent.action || "No action reported"}</p>
                  {agent.model && <small>{agent.model}</small>}
                </Details>
              ))}
              {agents.length
                ? agents.map((agent) => (
                    <Button
                      key={agent.sessionId}
                      onClick={() => onSelect(agent.sessionId)}
                    >
                      <UsersThreeIcon />
                      <span>
                        {peers.titles[agent.sessionId] ??
                          `Session ${agent.sessionId.slice(-6)}`}
                      </span>
                      {working(agent) ? (
                        <Spinner size="sm" aria-label="Working" />
                      ) : (
                        <small>
                          {agent.status === "failed"
                            ? "Interrupted"
                            : agent.status === "exited"
                              ? "Done"
                              : "Idle"}
                        </small>
                      )}
                    </Button>
                  ))
                : !native?.agents.length && <p>No workhorses yet</p>}
            </section>
            <section>
              <h3>Sources</h3>
              <div title={session.cwd ?? undefined}>
                <FolderIcon />
                <span>{session.cwd?.split("/").pop() ?? "Project files"}</span>
              </div>
              {peers.origins[session.sessionId] && (
                <Button
                  onClick={() => onSelect(peers.origins[session.sessionId]!)}
                >
                  <ArrowSquareOutIcon />
                  <span>Source session</span>
                </Button>
              )}
            </section>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      {savedHistory && (
        <RewindHistory
          sessionId={session.sessionId}
          onClose={() => setSavedHistory(false)}
        />
      )}
    </>
  );
}
