import type { PeerAttachment } from "../../peerApi";
/** Retain upload bytes before importing them, including across navigation or restart. */
export interface AttachmentImport {
  id: string;
  scope: string;
  name: string;
  size: number;
  file?: Blob;
  path?: string;
  error?: string;
  metadata?: PeerAttachment;
}
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("brigadier-attachment-imports", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("imports", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("imports", mode);
    const request = run(tx.objectStore("imports"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? new Error("Attachment draft storage was interrupted."));
  });
}
export const attachmentImports = {
  load: async (scope: string): Promise<AttachmentImport[]> => (await transaction("readonly", store => store.getAll()) as AttachmentImport[]).filter(item => item.scope === scope),
  save: (item: AttachmentImport) => transaction("readwrite", store => store.put(item)),
  remove: (id: string) => transaction("readwrite", store => store.delete(id)),
};
