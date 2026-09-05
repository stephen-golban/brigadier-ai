import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  rewindHistory,
  rewindHistoryItems,
  type RewindHistory as History,
  type ArchivedItem,
} from "../sessionApi";
import { errorMessage } from "../workspaceApi";
import { CopyButton } from "./Markdown";
export function RewindHistory({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    let live = true;
    void rewindHistory(sessionId).then(
      (h) => {
        if (live) setHistory(h);
      },
      (e) => {
        if (live) setError(errorMessage(e));
      },
    );
    return () => {
      live = false;
      previous?.focus();
    };
  }, [sessionId]);
  return createPortal(
    <dialog
      ref={dialog}
      className="workbench-dialog rewind-history-dialog"
      aria-label="Saved history"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2>Saved history</h2>
      {error && <p role="alert">{error}</p>}
      {history?.records.length === 0 && (
        <p>No edited history in this session.</p>
      )}
      {history?.records.map((r) => (
        <section key={r.id}>
          <button
            className="act"
            aria-expanded={selected === r.id}
            onClick={() => setSelected(selected === r.id ? null : r.id)}
          >
            {new Date(r.createdAt).toLocaleString()} ·{" "}
            {r.state === "pending"
              ? "Needs reconciliation"
              : r.state === "applied"
                ? "Rewound"
                : "Refused"}
          </button>
          {selected === r.id && (
            <>
              <small>Recovery ID: {r.id}</small>
              {r.state === "pending" && (
                <p>
                  The native outcome is unconfirmed. Sending and resuming are
                  paused to protect this history.
                </p>
              )}
              <Archive key={r.id} sessionId={sessionId} rewindId={r.id} />
            </>
          )}
        </section>
      ))}
      <footer>
        <button className="act" onClick={onClose}>
          Close
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
function Archive({
  sessionId,
  rewindId,
}: {
  sessionId: string;
  rewindId: string;
}) {
  const [rows, setRows] = useState<ArchivedItem[]>([]);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setBusy(true);
    try {
      const page = await rewindHistoryItems(
        sessionId,
        rewindId,
        rows[rows.length - 1]?.cursor ?? 0,
      );
      setRows((old) => [...old, ...page]);
      setMore(page.length === 20);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let live = true;
    void rewindHistoryItems(sessionId, rewindId, 0).then(
      (page) => {
        if (live) {
          setRows(page);
          setMore(page.length === 20);
        }
      },
      (e) => {
        if (live) setError(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, rewindId]);
  return (
    <div className="archived-messages">
      {error && <p role="alert">{error}</p>}
      {rows.map((r) => (
        <article key={r.cursor}>
          <small>{r.item.kind.type}</small>
          <pre>{r.item.body}</pre>
          <CopyButton text={r.item.body} />
        </article>
      ))}
      {more && (
        <button className="act" disabled={busy} onClick={() => void load()}>
          Load more
        </button>
      )}
    </div>
  );
}
