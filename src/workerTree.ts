import type { SessionRuntime } from './feedStore';
import type { PeerData } from './peerApi';

export interface WorkerRow { id: string; parent: string; depth: number; session?: SessionRuntime; done: boolean; awaitingIntegration: boolean; state: string; disposition: string }
/** Ownership only: messages to independent peers never add them to the tree. */
export function workerTree(root: string, peers: PeerData, sessions: Record<string, SessionRuntime>): WorkerRow[] {
  const rows: WorkerRow[] = [];
  const seen = new Set([root]);
  const visit = (parent: string, depth: number) => {
    for (const [id, owner] of Object.entries(peers.subagents ?? {})) {
      if (owner !== parent || seen.has(id)) continue;
      seen.add(id);
      const session = sessions[id];
      const assignment = peers.assignments?.[id];
      const finishedTurn = !!session && !session.busy && !!session.lastTurnId && session.lastStop === 'end-turn';
      const state = assignment?.state ?? (session?.status === 'failed' ? 'failed' : finishedTurn ? 'completed' : peers.closed.includes(id) || session?.status === 'exited' ? 'stopped' : session?.busy ? 'working' : session?.status === 'starting' ? 'starting' : 'waiting');
      const done = ['completed','failed','stopped','superseded'].includes(state);
      const disposition = assignment?.disposition ?? (finishedTurn ? 'awaiting-review' : state === 'stopped' || state === 'failed' ? state : 'pending');
      rows.push({id,parent,depth,session,done,state,disposition,awaitingIntegration:state === 'completed' && ['pending','awaiting-review','accepted'].includes(disposition)});
      visit(id, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}

/** Resolve nested activity and requests to the single user conversation. */
export function conversationOwner(id: string, peers: Pick<PeerData, 'subagents'>): string {
  const seen = new Set<string>();
  let current = id;
  while (peers.subagents?.[current]) {
    if (seen.has(current)) return id;
    seen.add(current);
    current = peers.subagents[current]!;
  }
  return current;
}

export function conversationSessions(sessions: Record<string, SessionRuntime>, peers: Pick<PeerData, 'subagents' | 'loaded'>) {
  if (peers.loaded === false) return {};
  return Object.fromEntries(Object.entries(sessions).filter(([id]) => !peers.subagents?.[id]));
}

/** One presentation for the same worker in Context, roster and detail views. */
export function workerPresentation(row: WorkerRow, needsResponse = false) {
  const working = ['working', 'starting', 'redirecting'].includes(row.state);
  const state = needsResponse ? 'waiting' : working ? 'working' : row.state === 'completed' ? 'done' : ['failed', 'recovery-required'].includes(row.state) ? 'failed' : row.done ? 'idle' : 'waiting';
  const label = needsResponse ? 'Waiting on orchestrator' : row.state === 'completed' ? row.disposition.replace(/-/g, ' ') : row.state.replace(/-/g, ' ');
  return { state, label } as const;
}
