import { useRef, useState } from "react";
import { sessionApi, type RewindPreview } from "../sessionApi";
import { bridge } from "../bridge";
import { errorMessage, type ChatItem } from "../workspaceApi";
import { ConfirmDialog } from "./ConfirmDialog";

export interface MessageEditProps {
  editing?: ChatItem | null;
  onCancelEdit?: () => void;
  onRewound?: () => void;
}

/** Dock keys the composer by session/message. This hook owns rewind/send and its optional confirmation. */
export function useMessageEdit({
  editing,
  onCancelEdit,
  onRewound,
}: MessageEditProps) {
  const [text, setText] = useState(editing?.body ?? "");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [rewound, setRewound] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [confirmation, setConfirmation] = useState<RewindPreview | null>(null);

  const perform = async (preview: RewindPreview | null) => {
    let didRewind = rewound;
    try {
      if (!didRewind) {
        const result = await sessionApi.rewind(preview!.ticket, preview!.filesAvailable ? "conversation-and-files" : "conversation", text);
        if (!result.rewound) throw new Error("Provider did not confirm rewind");
        didRewind = true;
        setRewound(true);
        onRewound?.();
        if (result.sent) { onCancelEdit?.(); return; }
      }
      await bridge().sendTurn(editing!.session_id, text);
      onCancelEdit?.();
    } catch (e) {
      setError(errorMessage(e));
      const code =
        typeof e === "object" && e !== null && "code" in e ? e.code : "";
      if (!didRewind && (code === "rewind_unconfirmed" || code === "store"))
        setUncertain(true);
    } finally {
      setConfirmation(null);
      pending.current = false;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (
      !editing ||
      pending.current ||
      uncertain ||
      confirmation ||
      !text.trim()
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    if (rewound) return perform(null);
    try {
      // Check the affected span when Send is pressed, not when editing begins.
      const preview = await sessionApi.preview(editing.session_id, editing.id);
      if (!preview.conversation)
        throw new Error(preview.reason ?? "Rewind is unavailable");
      if (preview.hasFileChanges || !preview.filesAvailable) {
        setConfirmation(preview);
        pending.current = false;
        setBusy(false);
      } else await perform(preview);
    } catch (e) {
      setError(errorMessage(e));
      pending.current = false;
      setBusy(false);
    }
  };
  return {
    text,
    setText,
    busy,
    error,
    submit,
    disabled: busy || uncertain || confirmation !== null,
    rewound,
    confirmation: confirmation ? (
      <ConfirmDialog
        title={confirmation.filesAvailable ? "Restore files and resend?" : "Rewind conversation only?"}
        body={
          <>
            <p>This message and all replies after it will be replaced.</p>
            {confirmation.filesAvailable ? <>
              <p>Restore {confirmation.files.length} file{confirmation.files.length === 1 ? "" : "s"} changed by these messages:</p>
              <ul>{confirmation.files.map(path => <li key={path}><code>{path}</code></li>)}</ul>
              <p>Coverage: source files, including untracked files. Ignored files, secrets, dependencies, and build output are excluded.</p>
            </> : <>
              <p>{confirmation.filesReason ?? "Workspace checkpoints are unavailable for this span."}</p>
              <p>File changes will remain on disk.</p>
            </>}
          </>
        }
        confirmLabel="Rewind & send"
        onCancel={() => setConfirmation(null)}
        onConfirm={async () => {
          pending.current = true;
          setBusy(true);
          await perform(confirmation);
        }}
      />
    ) : null,
  };
}
