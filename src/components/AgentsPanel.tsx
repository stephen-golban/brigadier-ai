import { useEffect, useState } from "react";
import { RobotIcon, CaretDownIcon } from "@phosphor-icons/react";
import type { SessionRuntime } from "../feedStore";
import { readActivity, type AgentActivity } from "../sessionApi";
import type { PeerData } from "../peerApi";
export function providerIdentity(instance: string | null | undefined) {
  if (instance?.startsWith("claude-code:"))
    return { name: "Claude Code", cli: "claude" };
  if (instance?.startsWith("codex:")) return { name: "Codex", cli: "codex" };
  if (instance?.includes("mock") || instance?.startsWith("replay:"))
    return { name: "Demo", cli: "Replay" };
  return {
    name: instance?.split(":")[0] || "Provider unknown",
    cli: "CLI unknown",
  };
}
export function AgentsPanel({
  sessions,
  projectId,
  selectedId,
  peers,
  onSelect,
}: {
  sessions: Record<string, SessionRuntime>;
  projectId: string | null;
  selectedId: string | null;
  peers: PeerData;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<Record<string, AgentActivity>>({});
  const rows = Object.values(sessions).filter(
    (s) => s.projectId === projectId && !peers.closed.includes(s.sessionId),
  );
  const ids = rows
    .filter((s) => s.status === "running" || s.status === "starting")
    .map((s) => s.sessionId)
    .sort()
    .join(",");
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const next: Record<string, AgentActivity> = {};
      await Promise.all(
        ids
          .split(",")
          .filter(Boolean)
          .map(async (id) => {
            try {
              next[id] = await readActivity(id);
            } catch {
              /* Missing telemetry is shown as unknown. */
            }
          }),
      );
      if (live) {
        setActivity(next);
        timer = setTimeout(() => void read(), 2000);
      }
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, ids]);
  const working = rows.filter((s) => s.busy).length;
  return (
    <div className="agents-widget">
      <button
        className="agents-trigger"
        aria-label="Agents"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <RobotIcon size={16} />
        <span>
          {working
            ? `${working} working`
            : `${rows.length} ${rows.length === 1 ? "agent" : "agents"}`}
        </span>
        <CaretDownIcon size={12} />
      </button>
      {open && (
        <div className="agents-card" role="region" aria-label="Agent activity">
          <b>Agents</b>
          {rows.length === 0 && <p>No sessions in this project.</p>}
          {rows.map((s) => {
            const a =
              s.status === "exited" || s.status === "failed"
                ? undefined
                : activity[s.sessionId];
            const provider = providerIdentity(s.instanceId);
            const status =
              a?.status ??
              (s.status === "running"
                ? s.busy
                  ? "Working"
                  : "Idle"
                : s.status);
            return (
              <div className="agent-entry" key={s.sessionId}>
                <button
                  aria-current={s.sessionId === selectedId ? "true" : undefined}
                  onClick={() => {
                    onSelect(s.sessionId);
                    setOpen(false);
                  }}
                >
                  <strong>
                    {peers.titles[s.sessionId] ??
                      `Session ${s.sessionId.slice(-6)}`}
                  </strong>
                  <span className="agent-status">{status}</span>
                  <small>
                    {a?.provider ?? provider.name} · {a?.cli ?? provider.cli} ·{" "}
                    {a?.model || s.model || "Model not reported"}
                  </small>
                  {a?.action && (
                    <span className="agent-action">
                      {status === "Working" ? "" : "Last: "}
                      {a.action}
                    </span>
                  )}
                  {peers.origins[s.sessionId] && (
                    <small>
                      From{" "}
                      {peers.titles[peers.origins[s.sessionId]!] ??
                        peers.origins[s.sessionId]}
                    </small>
                  )}
                </button>
                {a?.agents.map((child) => (
                  <button
                    className="child-agent"
                    key={child.id}
                    onClick={() => {
                      onSelect(s.sessionId);
                      setOpen(false);
                    }}
                  >
                    <strong>{child.description || child.id}</strong>
                    <span className="agent-status">{child.status}</span>
                    <small>
                      {a.provider} · {a.cli} ·{" "}
                      {child.model || "Model not reported"}
                    </small>
                    {child.action && (
                      <span className="agent-action">{child.action}</span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
          <small className="agent-future">
            Claude sessions run here. Other CLI integrations are not connected.
          </small>
        </div>
      )}
    </div>
  );
}
