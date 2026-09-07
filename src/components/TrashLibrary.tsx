import { useState } from "react";
import { ArchiveRestore, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { ActionDialog, type PendingAction } from "./ActionDialog";
import {
  navigationApi,
  type NavigationData,
  type TrashEntry,
} from "../navigationApi";
import { errorMessage } from "../workspaceApi";
export function TrashLibrary({
  data,
  onClose,
}: {
  data: NavigationData;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null),
    [action, setAction] = useState<PendingAction | null>(null);
  const restore = async (entry: TrashEntry) => {
    setBusy(entry.id);
    setError("");
    try {
      await navigationApi.restore(entry);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Trash</DialogTitle>
            <DialogDescription>
              Restore removed items or delete their stored history permanently.
              Repository files and worktrees stay on disk.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Search Trash…"
            aria-label="Search Trash"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="min-h-0 space-y-2 overflow-auto">
            {data.trash
              .filter((t) =>
                t.title.toLowerCase().includes(query.toLowerCase()),
              )
              .sort((a, b) => b.trashedAt - a.trashedAt)
              .map((entry) => (
                <div
                  key={`${entry.kind}:${entry.id}`}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {entry.title}
                    </p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {entry.kind} ·{" "}
                      {new Date(entry.trashedAt).toLocaleDateString()}
                      {entry.kind === "project"
                        ? ` · ${entry.sessionIds.length} sessions`
                        : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void restore(entry)}
                  >
                    <ArchiveRestore />
                    Restore
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={!!busy}
                    aria-label={`Delete permanently ${entry.title}`}
                    onClick={() =>
                      setAction({
                        title: "Delete permanently?",
                        description: `“${entry.title}” and its stored history cannot be restored after this action. Repository files and worktrees stay on disk.`,
                        label: "Delete permanently",
                        destructive: true,
                        run: async () => {
                          await navigationApi.purge(entry);
                        },
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            {!data.trash.length && (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Trash is empty.
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
      {action && (
        <ActionDialog action={action} onClose={() => setAction(null)} />
      )}
    </>
  );
}
