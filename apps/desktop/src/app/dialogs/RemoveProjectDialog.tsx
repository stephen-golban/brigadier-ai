import { useState } from "react";

import { ErrorLine, errorText, RadioChoice } from "@/app/dialogs/fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Project } from "@/ipc/generated";
import { removeProject } from "@/state/actions";
import { useApp } from "@/state/store";

type BranchChoice = "keep" | "delete";

/**
 * Removes a project from Brigadier, saying plainly what goes (its conversations, its Brain and
 * code index) and what never does (the repository), and asking what to do with the branches
 * its sessions left, as deleting a session does.
 */
export function RemoveProjectDialog({
  project,
  onOpenChange,
}: {
  /** The project to remove; the dialog is open while it is set. */
  project: Project | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {project && <RemoveForm key={project.id} project={project} onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function RemoveForm({
  project,
  onOpenChange,
}: {
  project: Project;
  onOpenChange: (open: boolean) => void;
}) {
  const conversations = useApp(
    (s) =>
      Object.values(s.conversations).filter((conversation) => conversation.projectId === project.id)
        .length,
  );
  const [branches, setBranches] = useState<BranchChoice>("keep");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const repo = project.repos[0]?.path;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeProject(project.id, conversations > 0 && branches === "delete");
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Remove project?</DialogTitle>
        <DialogDescription>
          “{project.name}” leaves Brigadier.{" "}
          {repo ? (
            <>
              Its repository at <span className="text-foreground break-all">{repo}</span> is not
              touched: its files, its commits and your own branches stay exactly as they are.
            </>
          ) : (
            "Its files are not touched."
          )}
        </DialogDescription>
      </DialogHeader>
      <ul className="text-muted-foreground grid list-disc gap-1 ps-5 text-sm">
        {conversations > 0 && (
          <li>
            Its {conversations === 1 ? "session is" : `${conversations} sessions are`} deleted with
            {conversations === 1 ? " its transcript" : " their transcripts"}. Workers still running
            are stopped, and their worktrees and temporary files are removed.
          </li>
        )}
        <li>What Brigadier knows about it, its Brain and code index, is deleted.</li>
        <li>This can't be undone. Adding the folder again starts it afresh.</li>
      </ul>
      {conversations > 0 && (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-xs">Unmerged branches</p>
          <RadioChoice<BranchChoice>
            label="Unmerged branches"
            value={branches}
            onChange={setBranches}
            options={[
              {
                value: "keep",
                label: "Keep unmerged branches",
                hint: "Session and task branches Brigadier made stay in the repository.",
              },
              {
                value: "delete",
                label: "Delete unmerged branches",
                hint: "Only the ones Brigadier made; work that never landed is lost. Your own branches are never touched.",
              },
            ]}
          />
        </div>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>
          Remove
        </Button>
      </DialogFooter>
    </div>
  );
}
