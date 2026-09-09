import { useState } from "react";
import { peerApi, type PeerAttachment } from "../../peerApi";
import { errorMessage } from "../../workspaceApi";
export function AttachmentPreview({ attachment }: { attachment: PeerAttachment }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isBinary = attachment.mediaType === "application/octet-stream";
  const isImage = attachment.mediaType.startsWith("image/");
  const load = async () => {
    if (content !== null || loading) return;
    setLoading(true); setError(null);
    try {
      const result = await peerApi.attachment(attachment.projectId, attachment.id);
      if (isImage) setContent(`data:${result.metadata.mediaType};base64,${result.base64}`);
      else if(isBinary) setContent(`data:application/octet-stream;base64,${result.base64}`);
      else setContent(new TextDecoder().decode(Uint8Array.from(atob(result.base64), char => char.charCodeAt(0))));
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  };
  return <details className="composer-attachment-preview" onToggle={event => { if (event.currentTarget.open) void load(); }}><summary title="Preview attachment">{attachment.name} <small>{Math.ceil(attachment.size / 1024)} KB</small></summary><div>{loading ? <p role="status">Loading preview…</p> : error ? <p role="alert">{error}</p> : content !== null ? isImage ? <img src={content} alt={attachment.name} /> : isBinary ? <a href={content} download={attachment.name}>Download original file</a> : <pre>{content}</pre> : null}</div></details>;
}
