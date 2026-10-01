import type { FileRecord } from "../db/types";
import { uploadStorage } from "./storage";
import { uploadPartSize, type ConflictAction, type UploadJob } from "./types";
import type { UploadDestination } from "./folders";

type Storage = typeof uploadStorage;
type Session = { uploadId?: string; parts?: number[]; complete: boolean };
type Dependencies = {
  storage: Storage;
  request: <T>(path: string, body: unknown) => Promise<T>;
  put: (url: string, source: Blob, progress: (bytes: number) => void) => Promise<void>;
  lock: (id: string, run: () => Promise<void>) => Promise<void>;
  online: () => boolean;
  sleep: (ms: number) => Promise<void>;
};

export class RequestError extends Error {
  constructor(message: string, public status: number, public code?: string, public file?: FileRecord) { super(message); }
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json();
  if (!response.ok) throw new RequestError(data.error ?? "Upload request failed", response.status, data.code, data.file);
  return data;
}

export function putChunk(url: string, source: Blob, progress: (bytes: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let watchdog: ReturnType<typeof setTimeout>;
    let lastBytes = 0;
    function armWatchdog() {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => xhr.abort(), 120_000);
    }
    const fail = (message: string) => { clearTimeout(watchdog); reject(new Error(message)); };
    xhr.open("PUT", url);
    xhr.upload.onprogress = (event) => {
      if (event.loaded > lastBytes) {
        lastBytes = event.loaded;
        armWatchdog();
        progress(event.loaded);
      }
    };
    xhr.onload = () => {
      clearTimeout(watchdog);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Storage upload failed (${xhr.status})`));
    };
    xhr.onerror = () => fail("Connection interrupted");
    xhr.onabort = () => fail("Upload stalled for two minutes; retrying");
    armWatchdog();
    xhr.send(source);
  });
}

const defaultDependencies: Dependencies = {
  storage: uploadStorage, request, put: putChunk,
  lock: async (id, run) => {
    if (!navigator.locks) throw new Error("Saved uploads require a browser with Web Locks support (Chrome, Edge, Firefox or Safari) on HTTPS or localhost.");
    await navigator.locks.request(`wraptor-upload-${id}`, run);
  },
  online: () => navigator.onLine,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type UploadSnapshot = { jobs: UploadJob[]; ready: boolean; saving: number; error?: string };
const emptySnapshot: UploadSnapshot = { jobs: [], ready: false, saving: 0 };

export class UploadQueue {
  private snapshot: UploadSnapshot = emptySnapshot;
  private listeners = new Set<() => void>();
  private completionListeners = new Set<(file: FileRecord) => void>();
  private active = new Set<string>();
  private lastFolderId: string | null | undefined;
  private batchActions = new Map<string, ConflictAction>();
  private starting?: Promise<void>;
  private adding = Promise.resolve();
  constructor(private deps: Dependencies = defaultDependencies) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeCompleted = (listener: (file: FileRecord) => void) => {
    this.completionListeners.add(listener);
    return () => { this.completionListeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => emptySnapshot;

  private publish(patch: Partial<UploadSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private update(job: UploadJob) {
    const previous = this.snapshot.jobs.find((current) => current.id === job.id);
    this.publish({ jobs: this.snapshot.jobs.map((current) => current.id === job.id ? { ...job } : current) });
    if (job.status === "done" && previous?.status !== "done" && job.result) {
      this.completionListeners.forEach((listener) => listener(job.result!));
    }
  }

  start = () => this.starting ??= (async () => {
    try {
      const saved = await this.deps.storage.list();
      for (const job of saved) {
        if (job.batchId && job.defaultConflictAction) this.batchActions.set(job.batchId, job.defaultConflictAction);
      }
      this.publish({ jobs: saved.map((job) => job.status === "uploading" ? { ...job, status: "queued" as const } : job), ready: true });
      this.pump();
    } catch {
      this.publish({ error: "Browser storage is unavailable. Enable site storage to save and resume uploads." });
    }
  })();

  enqueue = (files: File[], folderId: string | null, folderName: string, destinations?: UploadDestination[]) => {
    const batchId = crypto.randomUUID();
    this.publish({ saving: this.snapshot.saving + files.length, error: undefined });
    // Serialize disk writes, without blocking the transfer workers.
    this.adding = this.adding.then(async () => {
      await this.start();
      for (const [index, file] of files.entries()) {
        try {
          if (!this.snapshot.ready) throw new Error("Browser storage is unavailable");
          const job: UploadJob = {
            id: crypto.randomUUID(), batchId, name: file.name, size: file.size,
            contentType: file.type || "application/octet-stream",
            folderId: destinations?.[index]?.folderId ?? folderId,
            folderName: destinations?.[index]?.folderName ?? folderName,
            createdAt: Date.now(), status: "queued", progress: 0, partSize: uploadPartSize(file.size),
            defaultConflictAction: this.batchActions.get(batchId),
          };
          await this.deps.storage.add(job, file);
          this.publish({ jobs: [...this.snapshot.jobs, job] });
          this.pump();
        } catch (error) {
          const quota = (error as { name?: string }).name === "QuotaExceededError";
          this.publish({ error: `${file.name}: ${quota ? "Not enough browser storage to save this file. Free disk space or upload a smaller batch." : error instanceof Error ? error.message : "Could not save this file"}` });
        } finally {
          this.publish({ saving: this.snapshot.saving - 1 });
        }
      }
    });
    return this.adding;
  };

  retry = async (id: string) => {
    const job = this.snapshot.jobs.find((job) => job.id === id);
    if (!job || job.status !== "failed" || this.active.has(id)) return;
    const next: UploadJob = { ...job, status: "queued", error: undefined };
    try { await this.deps.storage.save(next); this.update(next); this.pump(); }
    catch { this.publish({ error: "Could not save the retry. Check browser storage." }); }
  };

  clearCompleted = async () => {
    try {
      for (const job of this.snapshot.jobs.filter((job) => job.status === "done" || job.status === "skipped")) {
        await this.deps.storage.remove(job.id);
        this.publish({ jobs: this.snapshot.jobs.filter((current) => current.id !== job.id) });
      }
    } catch { this.publish({ error: "Could not clear upload history." }); }
  };

  clearError = () => this.publish({ error: undefined });

  resolveConflict = async (id: string, action: ConflictAction, applyToBatch: boolean) => {
    const job = this.snapshot.jobs.find((current) => current.id === id);
    if (!job || job.status !== "conflict" || this.active.has(id)) return;
    try {
      if (applyToBatch && job.batchId) {
        this.batchActions.set(job.batchId, action);
        for (const current of this.snapshot.jobs.filter((current) => current.batchId === job.batchId
          && !this.active.has(current.id) && ["queued", "conflict", "failed"].includes(current.status))) {
          const updated = { ...current, defaultConflictAction: action };
          await this.deps.storage.save(updated);
          // Active workers merge the batch preference on their next checkpoint.
          if (!this.active.has(updated.id) && this.snapshot.jobs.find((item) => item.id === updated.id)?.status === current.status) this.update(updated);
        }
      }
      for (const current of this.snapshot.jobs.filter((current) => current.id === id
        || (applyToBatch && job.batchId && current.batchId === job.batchId && current.status === "conflict"))) {
        const updated: UploadJob = { ...current, conflictAction: action, status: action === "skip" ? "skipped" : "queued",
          defaultConflictAction: this.batchActions.get(current.batchId ?? ""), error: undefined };
        if (action === "skip") await this.deps.storage.finish(updated);
        else await this.deps.storage.save(updated);
        this.update(updated);
      }
      this.pump();
    } catch { this.publish({ error: "Could not save the duplicate-file choice. Check browser storage." }); }
  };

  private save(job: UploadJob) {
    job.defaultConflictAction = this.batchActions.get(job.batchId ?? "") ?? job.defaultConflictAction;
    return this.deps.storage.save(job);
  }

  pump = () => {
    if (!this.snapshot.ready || !this.deps.online()) return;
    for (const job of this.snapshot.jobs) {
      const choice = this.batchActions.get(job.batchId ?? "") ?? job.defaultConflictAction;
      if (job.status === "conflict" && choice && !this.active.has(job.id)) this.update({ ...job, status: "queued", conflictAction: choice });
    }
    while (this.active.size < 3) {
      // Identically named files in a batch must check the folder in order.
      const occupied = new Set(this.snapshot.jobs.filter((job) => this.active.has(job.id) || job.status === "conflict")
        .map((job) => `${job.folderId ?? "root"}:${job.name.toLowerCase()}`));
      const waiting = this.snapshot.jobs.filter((job) => {
        if (job.status !== "queued" || this.active.has(job.id)) return false;
        const key = `${job.folderId ?? "root"}:${job.name.toLowerCase()}`;
        if (occupied.has(key)) return false;
        occupied.add(key);
        return true;
      });
      if (!waiting.length) break;
      // Rotate destinations so a new folder does not wait behind a huge batch.
      const destinations = [...new Set(waiting.map((job) => job.folderId))];
      const previous = this.lastFolderId === undefined ? -1 : destinations.indexOf(this.lastFolderId);
      const destination = destinations[(previous + 1) % destinations.length];
      const job = waiting.find((job) => job.folderId === destination)!;
      this.lastFolderId = destination;
      this.active.add(job.id);
      void this.deps.lock(job.id, async () => {
        // A different tab may have completed this job while we waited for its lock.
        const saved = (await this.deps.storage.list()).find((current) => current.id === job.id);
        if (!saved) { this.publish({ jobs: this.snapshot.jobs.filter((current) => current.id !== job.id) }); return; }
        if (saved.status === "done" || saved.status === "skipped") { this.update(saved); return; }
        await this.run({ ...saved });
      }).catch((error) => {
        this.update({ ...job, status: "failed", error: error instanceof Error ? error.message : "Upload failed" });
      }).finally(() => { this.active.delete(job.id); this.pump(); });
    }
  };

  private async retryRequest<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await run(); }
      catch (error) {
        if (attempt >= 3 || !this.deps.online() || (error instanceof RequestError && error.status < 500 && error.status !== 429)) throw error;
        await this.deps.sleep(1000 * 2 ** attempt);
      }
    }
  }

  private async run(job: UploadJob) {
    job.status = "uploading"; job.error = undefined;
    this.update(job);
    try {
      await this.save(job);
      const source = await this.deps.storage.source(job.id);
      if (!source) throw new Error("Saved source file is missing. Choose the file again.");
      const conflict = await this.retryRequest(() => this.deps.request<{ file: FileRecord | null; completed?: FileRecord | null }>(
        "/api/uploads/conflict", { id: job.id, name: job.name, folderId: job.folderId }));
      if (conflict.completed) {
        job.result = conflict.completed; job.status = "done"; job.progress = 100;
        await this.deps.storage.finish(job); this.update(job); return;
      }
      if (conflict.file) {
        const automatic = this.batchActions.get(job.batchId ?? "") ?? job.defaultConflictAction;
        const unchanged = job.conflict?.id === conflict.file.id && job.conflict.s3_key === conflict.file.s3_key;
        job.conflict = conflict.file;
        job.conflictAction = automatic ?? (unchanged ? job.conflictAction : undefined);
        if (!job.conflictAction) {
          job.status = "conflict"; await this.save(job); this.update(job); return;
        }
        if (job.conflictAction === "skip") {
          job.status = "skipped"; await this.deps.storage.finish(job); this.update(job); return;
        }
      } else {
        job.conflict = undefined; job.conflictAction = undefined;
      }
      const details = () => ({ id: job.id, size: job.size, contentType: job.contentType, uploadId: job.uploadId });
      let session: Session;
      try {
        session = await this.retryRequest(() => this.deps.request<Session>("/api/uploads", { ...details(), action: "start" }));
      } catch (error) {
        if (!(error instanceof RequestError) || error.code !== "NoSuchUpload") throw error;
        job.uploadId = undefined;
        await this.save(job);
        session = await this.retryRequest(() => this.deps.request<Session>("/api/uploads", { ...details(), action: "start" }));
      }
      if (!session.complete) {
        if (!session.uploadId) throw new Error("Storage did not return an upload session");
        job.uploadId = session.uploadId;
        await this.save(job);
        const finished = new Set(session.parts ?? []);
        const count = Math.ceil(job.size / job.partSize);
        let uploaded = [...finished].reduce((bytes, part) => bytes + Math.min(job.partSize, job.size - (part - 1) * job.partSize), 0);
        job.progress = Math.floor(uploaded / job.size * 100);
        this.update(job);
        for (let part = 1; part <= count; part++) {
          if (finished.has(part)) continue;
          const chunk = source.slice((part - 1) * job.partSize, Math.min(part * job.partSize, job.size));
          await this.retryRequest(async () => {
            const { url } = await this.deps.request<{ url: string }>("/api/uploads", { ...details(), action: "part", partNumber: part });
            await this.deps.put(url, chunk, (bytes) => {
              const progress = Math.min(99, Math.floor((uploaded + bytes) / job.size * 100));
              if (progress !== job.progress) { job.progress = progress; this.update(job); }
            });
          });
          uploaded += chunk.size;
          job.progress = Math.min(99, Math.floor(uploaded / job.size * 100));
          await this.save(job);
          this.update(job);
        }
        await this.retryRequest(() => this.deps.request("/api/uploads", { ...details(), action: "complete" }));
      }
      const { file } = await this.retryRequest(() => this.deps.request<{ file: FileRecord }>("/api/files", {
        s3Key: `footage/${job.id}`, displayName: job.name, contentType: job.contentType,
        sizeBytes: job.size, folderId: job.folderId,
        conflictAction: job.conflictAction, targetFileId: job.conflict?.id, expectedS3Key: job.conflict?.s3_key,
      }));
      job.result = file; job.status = "done"; job.progress = 100;
      // Free the locally saved file only after the database acknowledges it.
      await this.deps.storage.finish(job);
      this.update(job);
    } catch (error) {
      if (error instanceof RequestError && error.code === "FileConflict" && error.file) {
        job.conflict = error.file; job.conflictAction = undefined; job.status = "conflict";
        await this.save(job); this.update(job); return;
      }
      job.status = this.deps.online() ? "failed" : "queued";
      job.error = error instanceof Error ? error.message : "Upload failed";
      try { await this.save(job); }
      catch { job.status = "failed"; job.error = "Could not save upload progress. Check browser storage, then retry."; }
      this.update(job);
    }
  }
}

export const uploadQueue = new UploadQueue();
