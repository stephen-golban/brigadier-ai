import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./controls/dialog";
import { Button } from "./controls/button";
import { errorMessage } from "../workspaceApi";
export interface PendingAction {
  title: string;
  description: ReactNode;
  label: string;
  run: () => Promise<void>;
  destructive?: boolean;
}
export function ActionDialog({
  action,
  onClose,
}: {
  action: PendingAction;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{action.title}</DialogTitle>
          <DialogDescription asChild>
            <div>{action.description}</div>
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={action.destructive ? "danger" : "primary"}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void action
                .run()
                .then(onClose)
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Please wait…" : action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
