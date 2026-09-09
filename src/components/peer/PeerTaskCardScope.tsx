import { createContext, useContext, useMemo, type ReactNode } from "react";
import { peerToolCards, type LinkedTask } from "../../peerPresentation";
import { flattenTrace, traceFailed, type ThreadRow } from "../../threadProjection";
import type { PeerData, PeerMessage } from "../../peerApi";

const TaskCards = createContext<{
  byRow: Map<string, LinkedTask[]>;
  receipts: Map<string, PeerMessage[]>;
  taskIds: Set<string>;
  messageIds: Set<string>;
} | null>(null);
const emptyCards: LinkedTask[] = [];

/** Repeated creation receipts update one linked card at its first work row. */
export function projectPeerTaskCards(rows: readonly ThreadRow[], titles: Record<string, string> = {}) {
  const byRow = new Map<string, LinkedTask[]>();
  const bySession = new Map<string, LinkedTask>();
  for (const row of rows) {
    if (row.type !== "work") continue;
    const cards: LinkedTask[] = [];
    for (const node of flattenTrace(row.nodes)) {
      if (node.item.kind.type !== "tool-call") continue;
      for (const card of peerToolCards(node.item.kind.name, node.item.body, node.result?.body,
        traceFailed(node), { titles }, node.item.id)) {
        const previous = card.id ? bySession.get(card.id) : undefined;
        if (previous) Object.assign(previous, card, { key: previous.key });
        else {
          cards.push(card);
          if (card.id) bySession.set(card.id, card);
        }
      }
    }
    if (cards.length) byRow.set(row.id, cards);
  }
  return byRow;
}

export function PeerTaskCardScope({ rows, sessionTitles, sessionId, peers, children }: {
  rows: readonly ThreadRow[]; sessionTitles?: Record<string, string>; sessionId?: string; peers?: PeerData; children: ReactNode;
}) {
  const cards = useMemo(() => {
    const byRow = projectPeerTaskCards(rows, sessionTitles);
    const receipts = new Map<string, PeerMessage[]>();
    const taskIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const [rowId, tasks] of byRow) {
      for (const task of tasks) {
        if (task.id) taskIds.add(task.id);
        // Match the actual creation receipt, never message text or just a destination.
        const message = [...(peers?.messages ?? []), ...(peers?.inputs ?? [])].find(m =>
          m.id === task.messageId && m.from === sessionId && m.to === task.id && m.initial);
        if (message && !messageIds.has(message.id)) {
          receipts.set(rowId, [...(receipts.get(rowId) ?? []), message]);
          messageIds.add(message.id);
        }
      }
    }
    return { byRow, receipts, taskIds, messageIds };
  }, [rows, sessionTitles, sessionId, peers]);
  return <TaskCards.Provider value={cards}>{children}</TaskCards.Provider>;
}

export function usePeerTaskCards(rowId: string) {
  const cards = useContext(TaskCards);
  return cards ? cards.byRow.get(rowId) ?? emptyCards : undefined;
}

export function usePeerReceiptScope() { return useContext(TaskCards); }
