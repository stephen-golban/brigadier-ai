import { useEffect, useState } from "react";
import { peerApi, type PeerAttachment, type PeerMessage } from "../../peerApi";

function Attachment({ attachment }: { attachment: PeerAttachment }) {
  const [data, setData] = useState<string>();
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!requested) return;
    let live = true;
    void peerApi.attachment(attachment.projectId, attachment.id).then(value => {
      if (live) setData(`data:${value.metadata.mediaType};base64,${value.base64}`);
    }, failure => { if (live) { setError(failure instanceof Error ? failure.message : String(failure)); setRequested(false); } });
    return () => { live = false; };
  }, [requested, attachment.projectId, attachment.id]);
  return <div className="peer-attachment">
    <span>{attachment.name} · {attachment.size.toLocaleString()} bytes</span>
    {data ? <>
      {/^(image\/(png|jpeg|gif|webp))$/.test(attachment.mediaType) && <img src={data} alt={attachment.name} className="max-h-64 max-w-full rounded" />}
      <a href={data} download={attachment.name}>Download {attachment.name}</a>
    </> : <button type="button" disabled={requested} onClick={() => { setError(""); setRequested(true); }}>{requested ? "Loading attachment…" : `View attachment: ${attachment.name}`}</button>}
    {error && <p role="alert">Attachment unavailable: {error}</p>}
  </div>;
}

/** Bytes are loaded only on demand; polling the peer snapshot does not refetch them. */
export function PeerAttachmentPreviews({ message }: { message: PeerMessage }) {
  if (!message.attachments?.length) return null;
  return <div className="peer-attachments">{message.attachments.map(attachment =>
    <Attachment key={`${attachment.projectId}:${attachment.id}`} attachment={attachment} />)}</div>;
}
