import { desktop } from "../workspaceApi";
import { confirm as nativeConfirm } from "@tauri-apps/plugin-dialog";
import { useState, useEffect, useRef, type ReactNode } from "react";
import { Modal } from "./controls/modal";
import { Button } from "@/components/ui/button";
export interface Confirmation {
  native?: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  secondaryLabel?: string;
  onSecondary?: () => void;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}
export function ConfirmDialog({
  native = false,
  title,
  body,
  confirmLabel = "Confirm",
  secondaryLabel,
  onSecondary,
  onConfirm,
  onCancel,
}: Confirmation) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [useNative, setUseNative] = useState(
    native && desktop && typeof body === "string" && !secondaryLabel,
  );
  const requested = useRef(false);
  useEffect(() => {
    if (!useNative || requested.current) return;
    requested.current = true;
    void nativeConfirm(body as string, {
      title,
      kind: "warning",
      okLabel: confirmLabel,
      cancelLabel: "Cancel",
    })
      .then(async (accepted) => {
        if (accepted) {
          try {
            await onConfirm();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setUseNative(false);
          }
        } else onCancel();
      })
      .catch(() => setUseNative(false));
  }, [useNative, body, title, confirmLabel, onConfirm, onCancel]);
  if (useNative) return null;
  return (
    <Modal.Backdrop
      isOpen
      isDismissable={false}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label={title}>
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            {body}
            {error && (
              <p role="alert" className="text-error">
                {error}
              </p>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button
              autoFocus
              data-autofocus="true"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </Button>
            {secondaryLabel && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={onSecondary}
              >
                {secondaryLabel}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void Promise.resolve()
                  .then(onConfirm)
                  .catch((e) => setError(e?.message ?? String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Working…" : confirmLabel}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
