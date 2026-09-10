import { ArtifactCard } from "./assistant-ui/elements/artifact-card";
import { Button } from "@/components/ui/button";
import { labelledButtonIcons } from "@/lib/surfaces";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { File, Undo } from "../icons";
import {
  desktopApi,
  notify,
  useSessionChanges,
  type ApplyPreview,
  type FileChange,
} from "../desktopApi";
import { errorMessage } from "../workspaceApi";
import { ConfirmDialog } from "./ConfirmDialog";
export function ChangedFilesCard({
  sessionId,
  turn,
  files,
}: {
  sessionId: string;
  turn: string;
  files: FileChange[];
}) {
  const [preview, setPreview] = useState<ApplyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  if (!files.length) return null;
  const review = () =>
    window.dispatchEvent(
      new CustomEvent("workbench-review", { detail: { sessionId, turn } }),
    );
  return (
    <ArtifactCard
      className="edited-files-card"
      heading={
        <>
          <div>
            Edited {files.length} {files.length === 1 ? "file" : "files"}
            <small>
              <span className="added text-ok not-italic">
                +{files.reduce((n, f) => n + f.added, 0)}
              </span>{" "}
              <span className="removed text-error not-italic">
                −{files.reduce((n, f) => n + f.deleted, 0)}
              </span>
            </small>
          </div>
          <span className="grow" />
          <Button
            variant="ghost"
            size="sm"
            className={cn(labelledButtonIcons, "undo-files")}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void desktopApi
                .previewUndo(sessionId, turn)
                .then(setPreview)
                .catch((e) => notify(errorMessage(e), true))
                .finally(() => setBusy(false));
            }}
          >
            Undo <Undo />
          </Button>
          <Button variant="ghost" size="sm" className="act" onClick={review}>
            Review
          </Button>
        </>
      }
    >
      {files.map((file) => (
        <Button
          variant="ghost"
          size="sm"
          className="edited-file"
          key={file.path}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("workbench-recorded-diff", {
                detail: { sessionId, path: file.path, turn },
              }),
            )
          }
        >
          <span>{file.path}</span>
          {file.binary ? (
            <small>Binary</small>
          ) : (
            <span>
              <i className="added text-ok not-italic">+{file.added}</i>{" "}
              <i className="removed text-error not-italic">−{file.deleted}</i>
            </span>
          )}
        </Button>
      ))}
      {preview && (
        <ApplyDialog preview={preview} undo onClose={() => setPreview(null)} />
      )}
    </ArtifactCard>
  );
}
function ApplyDialog({
  preview,
  onClose,
  undo = false,
}: {
  preview: ApplyPreview;
  onClose: () => void;
  undo?: boolean;
}) {
  const conflicts = preview.plan.conflicts;
  return (
    <ConfirmDialog
      title={
        undo ? "Undo this turn’s file changes?" : "Apply changes to project?"
      }
      body={
        <>
          <p>
            {undo
              ? "Conversation history stays available. Only the changes listed below will be undone."
              : "These changes will be applied to the original project folder and left uncommitted."}
          </p>
          {conflicts.length ? (
            <p className="inline-error my-2 text-[13px] text-error">
              Resolve these conflicts and refresh the preview:{" "}
              {conflicts.join(", ")}
            </p>
          ) : null}
          <ul className="apply-files">
            {preview.plan.changes.map((f) => (
              <li key={f.path}>{f.path}</li>
            ))}
          </ul>
        </>
      }
      confirmLabel={
        conflicts.length ? "Close" : undo ? "Undo changes" : "Apply to project"
      }
      onCancel={onClose}
      onConfirm={async () => {
        if (!conflicts.length) {
          await desktopApi.apply(preview.session, preview.id);
          window.dispatchEvent(new Event("workbench-files-restored"));
          notify(undo ? "File changes undone" : "Changes applied to project");
        }
        onClose();
      }}
    />
  );
}
export function SessionReview({
  sessionId,
  onOpen,
  turn = null,
}: {
  sessionId: string;
  onOpen: (path: string) => void;
  turn?: string | null;
}) {
  const changes = useSessionChanges(sessionId);
  const [preview, setPreview] = useState<ApplyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ApplyPreview[]>([]);
  useEffect(() => {
    let live = true;
    void desktopApi.applies(sessionId).then((ops) => {
      if (live)
        setPending(
          ops.filter((o) => o.phase === "failed" || o.phase === "applying"),
        );
    });
    return () => {
      live = false;
    };
  }, [sessionId, preview]);
  const files = turn
    ? (changes.turns.find((t) => t.turnId === turn)?.files ?? [])
    : changes.files;
  return (
    <section className="session-review">
      <header>
        <b>{turn ? "Turn changes" : "Session changes"}</b>
        <Button
          variant="ghost"
          size="sm"
          className="act"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void desktopApi
              .previewApply(sessionId)
              .then(setPreview)
              .catch((e) => notify(errorMessage(e), true))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Preparing…" : "Apply to project"}
        </Button>
      </header>
      {files.map((f) => (
        <Button
          key={f.path}
          variant="ghost"
          size="sm"
          className={labelledButtonIcons}
          onClick={() => onOpen(f.path)}
        >
          <File />
          <span>{f.path}</span>
          <i className="added text-ok not-italic">+{f.added}</i>
          <i className="removed text-error not-italic">−{f.deleted}</i>
        </Button>
      ))}
      {!files.length && <p>No recorded file changes yet.</p>}
      {pending.map((op) => (
        <div className="inline-error my-2 text-[13px] text-error" key={op.id}>
          {op.error ?? "An apply was interrupted."}
          <Button variant="ghost" size="sm" onClick={() => setPreview(op)}>
            Review and retry
          </Button>
        </div>
      ))}
      {preview && (
        <ApplyDialog preview={preview} onClose={() => setPreview(null)} />
      )}
    </section>
  );
}
