import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
export interface Confirmation {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: Confirmation) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    cancel.current?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="workbench-dialog"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={id}>{title}</h2>
      <div>{body}</div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <footer>
        <button ref={cancel} className="act" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="primary-action"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            Promise.resolve()
              .then(onConfirm)
              .catch((e) => {
                setError(e?.message ?? String(e));
                setBusy(false);
              });
          }}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
