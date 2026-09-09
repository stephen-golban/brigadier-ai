import { referenceTokens } from "./editorSource";
import { useCallback, useEffect, useRef, useState } from "react";
import { composerApi, emptyComposer, serializeComposerWrite, type ComposerDraft, type ComposerState } from "../../composerApi";
import { peerApi, type PeerAttachment } from "../../peerApi";
import { errorMessage, desktop } from "../../workspaceApi";

/** Optimistic typing stays local while every accepted draft is saved through the desktop service. */
export function useDurableComposer(sessionId: string | null, projectId: string | null) {
  const [state, setState] = useState<ComposerState | null>(null);
  const [draft, setDraft] = useState<ComposerDraft>({ text: "", attachmentIds: [] });
  const [attachments, setAttachments] = useState<PeerAttachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const metadata = useRef(new Map<string, PeerAttachment>());
  const generation = useRef(0);
  const draftVersion = useRef(0);
  const accept = useCallback((next: ComposerState) => {
    if (next.sessionId !== sessionId) return;
    setState(previous => previous && (previous.revision ?? 0) > (next.revision ?? 0) ? previous : next);
  }, [sessionId]);
  const acceptRef = useRef(accept); acceptRef.current = accept;
  useEffect(() => {
    const active = ++generation.current;
    setState(null); setLoaded(false); setError(null); setDraft({ text: "", attachmentIds: [] }); setAttachments([]);
    draftVersion.current = 0;
    if (!sessionId) return;
    let unsubscribe: (() => void) | undefined;
    void composerApi.subscribe(next => { if (generation.current === active) acceptRef.current(next); }).then(dispose => { if (generation.current === active) unsubscribe = dispose; else dispose(); }).catch(failure => { if (generation.current === active) setError(errorMessage(failure)); });
    void composerApi.state(sessionId).then(async next => {
      if (generation.current !== active) return;
      acceptRef.current(next);
      let restored = next.draft;
      // An unsaved local write-ahead copy can recover a draft if the window closed before IPC acknowledgement.
      try {
        const pending = JSON.parse(localStorage.getItem(`composer-pending:${sessionId}`) ?? "null") as ComposerDraft | null;
        const attempt = JSON.parse(localStorage.getItem(`composer-request:${sessionId}`) ?? "null") as { id: string } | null;
        if (attempt && next.queue.some(item => item.id === attempt.id)) localStorage.removeItem(`composer-pending:${sessionId}`);
        if (!(attempt && next.queue.some(item => item.id === attempt.id)) && pending && typeof pending.text === "string" && Array.isArray(pending.attachmentIds)) {
          restored = pending;
          if (desktop) void serializeComposerWrite(sessionId, () => composerApi.saveDraft(sessionId, pending.text, pending.attachmentIds)).then(saved => { if (generation.current === active) acceptRef.current(saved); if (localStorage.getItem(`composer-pending:${sessionId}`) === JSON.stringify(pending)) localStorage.removeItem(`composer-pending:${sessionId}`); }).catch(failure => { if (generation.current === active) setError(errorMessage(failure)); });
        }
      } catch { /* Unavailable optional write-ahead cache does not replace durable storage. */ }
      draftRef.current = restored; setDraft(restored);
      const files = await Promise.all(restored.attachmentIds.map(async id => {
        const cached = metadata.current.get(id); if (cached) return cached;
        if (!projectId) throw new Error("Attachment project is unavailable.");
        try { const result = await peerApi.attachment(projectId, id); metadata.current.set(id, result.metadata); return result.metadata; }
        catch (failure) { if (generation.current === active) setError(`Attachment unavailable: ${errorMessage(failure)}`); return { id, projectId, name: "Unavailable attachment", mediaType: "application/octet-stream", size: 0, createdAt: 0 }; }
      }));
      if (generation.current === active) { setAttachments(files); setLoaded(true); }
    }).catch(failure => { if (generation.current === active) setError(errorMessage(failure)); });
    return () => { generation.current++; unsubscribe?.(); };
  }, [sessionId, projectId]);
  const set = useCallback((next: ComposerDraft, files?: PeerAttachment[]) => {
    if (!sessionId) return;
    draftRef.current = next; setDraft(next); const version = ++draftVersion.current; const active = generation.current;
    if (files) { setAttachments(files); files.forEach(file => metadata.current.set(file.id, file)); }
    try { localStorage.setItem(`composer-pending:${sessionId}`, JSON.stringify(next)); } catch { /* backend save remains authoritative */ }
    if (!desktop) return;
    void serializeComposerWrite(sessionId, () => composerApi.saveDraft(sessionId, next.text, next.attachmentIds)).then(saved => {
      if (generation.current !== active) return;
      acceptRef.current(saved);
      if (draftVersion.current === version) { try { localStorage.removeItem(`composer-pending:${sessionId}`); } catch { /* optional cache */ } }
    }).catch(failure => { if (generation.current === active) setError(`Draft not saved: ${errorMessage(failure)}`); });
  }, [sessionId]);
  const setText = useCallback((text: string) => set({ ...draftRef.current, text }), [set]);
  const setFiles = useCallback((files: PeerAttachment[]) => {
    const ids = files.map(file => file.id);
    let text = draftRef.current.text;
    for (const token of referenceTokens(text).reverse()) {
      if (token.type === "attachment" && draftRef.current.attachmentIds.includes(token.id) && !ids.includes(token.id)) text = text.slice(0, token.start) + text.slice(token.end);
    }
    set({ text, attachmentIds: ids }, files);
  }, [set]);
  const clearAccepted = useCallback((sent: ComposerDraft) => {
    if (draftRef.current.text !== sent.text || JSON.stringify(draftRef.current.attachmentIds) !== JSON.stringify(sent.attachmentIds)) return;
    set({ text: "", attachmentIds: [] }, []);
  }, [set]);
  return { state: state?.sessionId === sessionId ? state : (sessionId ? emptyComposer(sessionId) : null), draft: state?.sessionId === sessionId ? draft : { text: "", attachmentIds: [] }, attachments: state?.sessionId === sessionId ? attachments : [], loaded: loaded && state?.sessionId === sessionId, error, setError, setText, setFiles, clearAccepted, accept };
}
