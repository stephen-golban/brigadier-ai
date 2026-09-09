import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { peerApi, type PeerAttachment } from "../../peerApi";
import { errorMessage } from "../../workspaceApi";
import { attachmentImports, type AttachmentImport } from "./attachmentImports";

export interface PendingAttachment extends AttachmentImport { status: "saving" | "importing" | "failed"; progress: number }
export function useAttachmentImports({ scope, projectId, attachments, onAttachments, disabled, onError }: {
  scope: string; projectId: string | null; attachments: PeerAttachment[];
  onAttachments?: (attachments: PeerAttachment[]) => void; disabled?: boolean; onError: (error: string) => void;
}) {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [hydrating, setHydrating] = useState(!!onAttachments);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const current = useRef({ scope, projectId, attachments, onAttachments, disabled, onError });
  current.current = { scope, projectId, attachments, onAttachments, disabled, onError };
  const records = useRef<PendingAttachment[]>([]);
  const mounted = useRef(true);
  const restoredScope = useRef(scope);
  const update = useCallback((next: PendingAttachment[]) => { records.current = next; if (mounted.current) setPending(next); }, []);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    if (restoredScope.current !== scope) { update([]); restoredScope.current = scope; }
    setHydrating(!!onAttachments); setRecoveryError(null);
    if (onAttachments) void attachmentImports.load(scope).then(saved => {
      if (live) update([...saved.filter(item => !records.current.some(record => record.id === item.id)).map(item => ({ ...item, status: "failed" as const, progress: 0, error: item.error ?? "Import interrupted. Retry to finish attaching this file." })), ...records.current]);
    }).catch(failure => { if (live) setRecoveryError(errorMessage(failure)); }).finally(() => { if (live) setHydrating(false); });
    return () => { live = false; mounted.current = false; };
  }, [scope, !!onAttachments, update, recoveryVersion]);
  const patch = (id: string, change: Partial<PendingAttachment>) => update(records.current.map(item => item.id === id ? { ...item, ...change } : item));
  const run = async (item: PendingAttachment) => {
    const destination = item.scope;
    const destinationProject = current.current.projectId;
    if (!destinationProject || !current.current.onAttachments) return;
    const retained = () => mounted.current && current.current.scope === destination && records.current.some(record => record.id === item.id);
    try {
      patch(item.id, { status: "saving", progress: 0, error: undefined });
      await attachmentImports.save(item);
      if (!retained()) return;
      if (item.file && item.file.size > 5 * 1024 * 1024) throw new Error(`${item.name} exceeds the 5 MiB attachment limit.`);
      patch(item.id, { status: "importing", progress: 10 });
      let metadata: PeerAttachment;
      if (item.metadata) metadata = item.metadata;
      else if (item.path) metadata = await invoke<PeerAttachment>("import_conversation_attachment_path", { projectId: destinationProject, path: item.path });
      else {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onprogress = event => { if (retained() && event.lengthComputable) patch(item.id, { progress: 10 + Math.round(event.loaded / event.total * 70) }); };
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = () => reject(new Error(`Could not read ${item.name}`));
          reader.readAsDataURL(item.file!);
        });
        if (!retained()) return;
        patch(item.id, { progress: 85 });
        metadata = await peerApi.importAttachment(destinationProject, item.name, base64);
      }
      if (!retained()) return;
      item = { ...item, metadata };
      patch(item.id, { metadata });
      await attachmentImports.save(item);
      if (!retained()) return;
      const next = [...current.current.attachments.filter(file => file.id !== metadata.id), metadata];
      current.current.attachments = next;
      current.current.onAttachments?.(next);
      await attachmentImports.remove(item.id);
      if (retained()) update(records.current.filter(record => record.id !== item.id));
    } catch (failure) {
      if (!retained()) return;
      const error = errorMessage(failure);
      patch(item.id, { status: "failed", error });
      // If quota/storage itself failed, the bytes remain in memory and the visible error is retained.
      void attachmentImports.save({ ...item, error }).catch(() => {});
    }
  };
  const stage = (sources: Array<{ file?: File; path?: string; name: string; size: number }>) => {
    if (current.current.disabled || !sources.length) return false;
    if (!current.current.projectId || !current.current.onAttachments) { current.current.onError("Select a project before attaching a file."); return false; }
    if (current.current.attachments.length + records.current.length + sources.length > 20) { current.current.onError("A message can include up to 20 attachments."); return false; }
    const items: PendingAttachment[] = sources.map(source => ({ ...source, id: crypto.randomUUID(), scope: current.current.scope, status: "saving", progress: 0 }));
    update([...records.current, ...items]);
    for (const item of items) void run(item);
    return true;
  };
  return {
    pending, recoveryError, retryRecovery: () => setRecoveryVersion(value => value + 1), blocked: hydrating || recoveryError !== null || pending.length > 0,
    addFiles: (files: File[]) => stage(files.map(file => ({ file, name: file.name, size: file.size }))),
    addPaths: (paths: string[]) => stage(paths.map(path => ({ path, name: path.split(/[\\/]/).pop() || path, size: 0 }))),
    retry: (id: string) => { const item = records.current.find(item => item.id === id); if (item?.status === "failed") void run(item); },
    remove: (id: string) => { update(records.current.filter(item => item.id !== id)); void attachmentImports.remove(id).catch(failure => current.current.onError(errorMessage(failure))); },
  };
}
