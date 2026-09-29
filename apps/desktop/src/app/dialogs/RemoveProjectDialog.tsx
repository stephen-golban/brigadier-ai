import { useEffect, useState } from "react";

import { CheckboxRow, ErrorLine, errorText } from "@/app/dialogs/fields";
import { Spinner } from "@/components/glyphs/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  Project,
  ProjectRemoval,
  RemovalBranch,
  RemoveProjectReport,
} from "@/ipc/generated";
import { formatBytes } from "@/lib/format";
import { previewRemoveProject, removeProject } from "@/state/actions";

/**
 * Removes a project from Brigadier. The daemon's preview says what goes: its conversations
 * (archived ones too), their worktrees, the branches Brigadier made for them (merged ones
 * checked; unmerged ones unchecked, with what deleting them loses) and its Brain. The
 * repository's files never go. Nothing can be removed while one of its conversations works.
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
      <DialogContent className="max-w-lg max-h-full overflow-y-auto">
        {project && <RemoveFlow key={project.id} project={project} onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function RemoveFlow({
  project,
  onOpenChange,
}: {
  project: Project;
  onOpenChange: (open: boolean) => void;
}) {
  const [preview, setPreview] = useState<ProjectRemoval | null>(null);
  const [report, setReport] = useState<RemoveProjectReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    previewRemoveProject(project.id).then(
      (removal) => current && setPreview(removal),
      (cause: unknown) => current && setError(errorText(cause)),
    );
    return () => {
      current = false;
    };
  }, [project.id]);

  if (report) return <Removed name={project.name} report={report} onOpenChange={onOpenChange} />;
  if (!preview) {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>Remove project?</DialogTitle>
          <DialogDescription>Looking at what “{project.name}” has…</DialogDescription>
        </DialogHeader>
        {!error && <Spinner className="size-icon-sm animate-spin" />}
        <ErrorLine error={error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </div>
    );
  }
  return <RemoveForm preview={preview} onRemoved={setReport} onOpenChange={onOpenChange} />;
}

function branchKey(branch: RemovalBranch): string {
  return `${branch.repo}\n${branch.name}`;
}

function RemoveForm({
  preview,
  onRemoved,
  onOpenChange,
}: {
  preview: ProjectRemoval;
  onRemoved: (report: RemoveProjectReport) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [picked, setPicked] = useState(
    () =>
      new Set(
        preview.branches.filter((b) => b.merged && !b.checkedOut).map((b) => branchKey(b)),
      ),
  );
  const [trashBrain, setTrashBrain] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const archived = preview.conversations.filter((c) => c.archived).length;
  const worktreeBytes = preview.worktrees.reduce((sum, w) => sum + w.bytes, 0);

  const pick = (branch: RemovalBranch, on: boolean) =>
    setPicked((set) => {
      const next = new Set(set);
      if (on) next.add(branchKey(branch));
      else next.delete(branchKey(branch));
      return next;
    });

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const choices = preview.branches
        .filter((b) => picked.has(branchKey(b)))
        .map((b) => ({ name: b.name, tip: b.tip }));
      const report = await removeProject(preview.projectId, choices, !trashBrain);
      if (report.failures.length === 0 && report.keptBranches.every((b) => b.merged)) {
        onOpenChange(false);
      } else {
        onRemoved(report);
      }
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
          “{preview.name}” leaves Brigadier.{" "}
          {preview.repo ? (
            <>
              Its repository at <span className="text-foreground break-all">{preview.repo}</span>{" "}
              is not touched: its files, its commits and your own branches stay exactly as they
              are.
            </>
          ) : (
            "Its files are not touched."
          )}
        </DialogDescription>
      </DialogHeader>

      <section aria-labelledby="remove-conversations" className="grid gap-1.5">
        <h3 id="remove-conversations" className="text-muted-foreground text-xs">
          Sessions and chats
        </h3>
        {preview.conversations.length === 0 ? (
          <p className="text-muted-foreground text-sm">None.</p>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              {preview.conversations.length === 1
                ? "It is deleted with its transcript"
                : `All ${preview.conversations.length} are deleted with their transcripts`}
              {archived > 0 && ` (${archived} archived)`}. This can't be undone.
            </p>
            <ul className="grid max-h-40 gap-1 overflow-y-auto text-sm">
              {preview.conversations.map((conversation) => (
                <li key={conversation.id} className="flex items-center gap-2">
                  <span className="truncate">{conversation.title}</span>
                  {conversation.archived && <Badge variant="secondary">Archived</Badge>}
                  {conversation.running && <Badge variant="warning">Working</Badge>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {preview.worktrees.length > 0 && (
        <section aria-labelledby="remove-worktrees" className="grid gap-1.5">
          <h3 id="remove-worktrees" className="text-muted-foreground text-xs">
            Worktrees · {formatBytes(worktreeBytes)}
          </h3>
          <p className="text-muted-foreground text-xs">
            Removed through git. Uncommitted changes are kept first, as a WIP commit on the
            worktree's branch.
          </p>
          <ul className="grid max-h-40 gap-1 overflow-y-auto text-sm">
            {preview.worktrees.map((worktree) => (
              <li key={worktree.path} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate" title={worktree.path}>
                  {worktree.path.split("/").pop()}
                </span>
                {worktree.hasChanges && <Badge variant="warning">Has changes</Badge>}
                <span className="text-muted-foreground ms-auto shrink-0 text-xs tabular-nums">
                  {formatBytes(worktree.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview.branches.length > 0 && (
        <section aria-labelledby="remove-branches" className="grid gap-2">
          <h3 id="remove-branches" className="text-muted-foreground text-xs">
            Branches Brigadier made
          </h3>
          <p className="text-muted-foreground text-xs">
            Checked ones are deleted. Merged ones hold nothing their target lacks; unchecked ones
            stay in the repository.
          </p>
          <div className="grid gap-2">
            {preview.branches.map((branch) => (
              <CheckboxRow
                key={branchKey(branch)}
                label={branch.name}
                checked={picked.has(branchKey(branch))}
                disabled={branch.checkedOut}
                onCheckedChange={(on) => pick(branch, on)}
                note={
                  branch.checkedOut
                    ? "Checked out in another worktree, so it stays."
                    : branch.merged
                      ? `Merged into ${branch.target}.`
                      : `Not merged: ${branch.ahead} ${branch.ahead === 1 ? "commit" : "commits"} ${branch.target} doesn't have. Deleting it loses them.`
                }
              />
            ))}
          </div>
        </section>
      )}

      <CheckboxRow
        label={`Move its Brain and code index to the Trash (${formatBytes(preview.brainBytes)})`}
        note="Unchecked, they stay in Brigadier's data folder, and Settings → Storage offers them later. Rebuilding them takes a while."
        checked={trashBrain}
        onCheckedChange={setTrashBrain}
      />

      {preview.blocked && <ErrorLine error={preview.blocked} />}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={busy || preview.blocked !== null}
          onClick={() => void confirm()}
        >
          {busy ? "Removing…" : "Remove"}
        </Button>
      </DialogFooter>
    </div>
  );
}

/** What stayed behind: unmerged branches (with the command that deletes each) and failures. */
function Removed({
  name,
  report,
  onOpenChange,
}: {
  name: string;
  report: RemoveProjectReport;
  onOpenChange: (open: boolean) => void;
}) {
  const kept = report.keptBranches.filter((branch) => !branch.merged);
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>“{name}” was removed</DialogTitle>
        <DialogDescription>
          {report.brainTrashedBytes > 0
            ? `Its Brain (${formatBytes(report.brainTrashedBytes)}) is in the Trash.`
            : "Its repository was not touched."}
        </DialogDescription>
      </DialogHeader>
      {kept.length > 0 && (
        <section aria-labelledby="removed-kept" className="grid gap-1.5">
          <h3 id="removed-kept" className="text-muted-foreground text-xs">
            Branches kept with unmerged work
          </h3>
          <ul className="grid gap-2 text-sm">
            {kept.map((branch) => (
              <li key={branchKey(branch)} className="grid gap-0.5">
                <span>{branch.name}</span>
                <code className="text-muted-foreground text-xs break-all select-text">
                  {branch.command}
                </code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.failures.length > 0 && (
        <section aria-labelledby="removed-failures" className="grid gap-1.5">
          <h3 id="removed-failures" className="text-muted-foreground text-xs">
            Not done
          </h3>
          <ul className="text-destructive grid gap-1 text-sm">
            {report.failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        </section>
      )}
      <DialogFooter>
        <Button type="button" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
