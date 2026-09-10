import { Folder, X } from "../icons";
import { Button } from "./controls/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./controls/dialog";
import { Input } from "./controls/input";

export function EditProjectDialog({
  name,
  busy,
  error,
  onNameChange,
  onSave,
  onClose,
  onRemove,
}: {
  name: string;
  busy: boolean;
  error: string;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onClose: () => void;
  onRemove: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="edit-project-dialog"
        style={{
          width: "min(460px, calc(100vw - 32px))",
          borderRadius: 20,
          padding: 18,
        }}
        showCloseButton={false}
        aria-label="Edit project"
        onEscapeKeyDown={busy ? (event) => event.preventDefault() : undefined}
      >
        <Button
          isIconOnly
          className="absolute top-[18px] right-[18px]"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </Button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !busy) onSave();
          }}
        >
          <DialogHeader className="mb-3 pr-8">
            <DialogTitle className="text-[18px]">Edit project</DialogTitle>
          </DialogHeader>
          <div className="flex h-9 overflow-hidden rounded-md border border-hairline focus-within:border-text-tertiary">
            <span className="flex w-9 shrink-0 items-center justify-center border-r border-hairline">
              <Folder className="size-4" />
            </span>
            <Input
              autoFocus
              aria-label="Project name"
              maxLength={200}
              value={name}
              disabled={busy}
              onChange={(event) => onNameChange(event.target.value)}
              className="h-full flex-1 rounded-none bg-transparent px-2 outline-none focus-visible:outline-none"
            />
          </div>
          {error && (
            <p role="alert" className="mt-2 text-[13px] text-error">
              {error}
            </p>
          )}
          <div className="mt-[18px] flex flex-wrap items-center justify-end gap-2">
            <Button
              className="mr-auto bg-error/10 px-3 text-error hover:bg-error/20"
              disabled={busy}
              onClick={onRemove}
              aria-label="Remove local project"
            >
              Remove local project
            </Button>
            <Button
              disabled={busy}
              onClick={onClose}
              className="text-text-secondary"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim()}
              className="bg-text px-4 text-canvas hover:bg-text-secondary"
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
