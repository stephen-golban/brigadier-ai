import { useState, type ReactNode } from "react";
import { Modal } from "./controls/modal";
import { Button } from "./controls/button";
export interface Confirmation {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  secondaryLabel?: string;
  onSecondary?: () => void;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}
export function ConfirmDialog({
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
              variant="secondary"
              isDisabled={busy}
              onPress={onCancel}
            >
              Cancel
            </Button>
            {secondaryLabel && (
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={onSecondary}
              >
                {secondaryLabel}
              </Button>
            )}
            <Button
              isDisabled={busy}
              onPress={() => {
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
