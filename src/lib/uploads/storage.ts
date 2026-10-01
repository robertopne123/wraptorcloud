import type { UploadJob } from "./types";

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("wraptor-uploads", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("jobs", { keyPath: "id" });
      request.result.createObjectStore("sources");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close older Vault tabs to enable saved uploads."));
  });
}

async function write(stores: string[], action: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Could not save the upload."));
    action(tx);
  });
}

async function read<T>(store: string, key?: string): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const objectStore = db.transaction(store).objectStore(store);
    const request = key === undefined ? objectStore.getAll() : objectStore.get(key);
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

export const uploadStorage = {
  list: () => read<UploadJob[]>("jobs"),
  source: (id: string) => read<Blob | undefined>("sources", id),
  add: (job: UploadJob, source: Blob) => write(["jobs", "sources"], (tx) => {
    tx.objectStore("jobs").put(job);
    tx.objectStore("sources").put(source, job.id);
  }),
  save: (job: UploadJob) => write(["jobs"], (tx) => { tx.objectStore("jobs").put(job); }),
  finish: (job: UploadJob) => write(["jobs", "sources"], (tx) => {
    tx.objectStore("jobs").put(job);
    tx.objectStore("sources").delete(job.id);
  }),
  remove: (id: string) => write(["jobs", "sources"], (tx) => {
    tx.objectStore("jobs").delete(id);
    tx.objectStore("sources").delete(id);
  }),
};
