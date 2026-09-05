import { useEffect, useState } from "react";
import { FileIcon, ArrowUUpLeftIcon } from "@phosphor-icons/react";
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
    <div className="edited-files-card">
      <header>
        <span className="edited-files-icon">
          <FileIcon size={21} />
        </span>
        <div>
          Edited {files.length} {files.length === 1 ? "file" : "files"}
          <small>
            <span className="added">
              +{files.reduce((n, f) => n + f.added, 0)}
            </span>{" "}
            <span className="removed">
              −{files.reduce((n, f) => n + f.deleted, 0)}
            </span>
          </small>
        </div>
        <span className="grow" />
        <button
          className="undo-files"
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
          Undo <ArrowUUpLeftIcon />
        </button>
        <button className="act" onClick={review}>
          Review
        </button>
      </header>
      {files.map((file) => (
        <button
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
              <i className="added">+{file.added}</i>{" "}
              <i className="removed">−{file.deleted}</i>
            </span>
          )}
        </button>
      ))}
      {preview && (
        <ApplyDialog preview={preview} undo onClose={() => setPreview(null)} />
      )}
    </div>
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
            <p className="inline-error">
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
        <button
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
        </button>
      </header>
      {files.map((f) => (
        <button key={f.path} onClick={() => onOpen(f.path)}>
          <FileIcon />
          <span>{f.path}</span>
          <i className="added">+{f.added}</i>
          <i className="removed">−{f.deleted}</i>
        </button>
      ))}
      {!files.length && <p>No recorded file changes yet.</p>}
      {pending.map((op) => (
        <div className="inline-error" key={op.id}>
          {op.error ?? "An apply was interrupted."}
          <button onClick={() => setPreview(op)}>Review and retry</button>
        </div>
      ))}
      {preview && (
        <ApplyDialog preview={preview} onClose={() => setPreview(null)} />
      )}
    </section>
  );
}
