import type { SessionRuntime } from './feedStore';
import type { PeerData } from './peerApi';

export interface WorkerRow { id: string; parent: string; depth: number; session?: SessionRuntime; done: boolean; awaitingIntegration: boolean }
/** Ownership only: messages to independent peers never add them to the tree. */
export function workerTree(root: string, peers: PeerData, sessions: Record<string, SessionRuntime>): WorkerRow[] {
  const rows: WorkerRow[] = [];
  const seen = new Set([root]);
  const visit = (parent: string, depth: number) => {
    for (const [id, owner] of Object.entries(peers.origins)) {
      if (owner !== parent || seen.has(id)) continue;
      seen.add(id);
      const session = sessions[id];
      rows.push({id, parent, depth, session, done: peers.closed.includes(id) || session?.status === 'exited',
        awaitingIntegration: !!session && !session.busy && session.status === 'running' && !!session.lastTurnId && session.lastStop === 'end-turn'});
      visit(id, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}
