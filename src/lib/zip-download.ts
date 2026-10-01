export type ZipDownloadState = {
  status: "idle" | "preparing" | "receiving" | "done" | "failed" | "cancelled";
  bytes: number;
  fileCount: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
};

const initialState: ZipDownloadState = { status: "idle", bytes: 0, fileCount: 0, startedAt: 0, updatedAt: 0 };
type Dependencies = {
  fetch: typeof fetch;
  save: (blob: Blob, filename: string) => void;
  now: () => number;
};

export function isZipDownloadActive(state: ZipDownloadState) {
  return state.status === "preparing" || state.status === "receiving";
}

export class ZipDownload {
  private state = initialState;
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  constructor(private deps: Dependencies = {
    fetch: (...args) => fetch(...args), now: () => Date.now(),
    save: (blob, filename) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  }) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  getServerSnapshot = () => initialState;
  private publish(patch: Partial<ZipDownloadState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  cancel = () => {
    if (!isZipDownloadActive(this.state)) return;
    this.controller?.abort();
    void this.reader?.cancel().catch(() => {});
    this.publish({ status: "cancelled", finishedAt: this.deps.now() });
  };

  dismiss = () => { if (!isZipDownloadActive(this.state)) this.publish(initialState); };

  start = async (fileIds: string[], folderIds: string[]) => {
    if (isZipDownloadActive(this.state)) return;
    const controller = new AbortController();
    this.controller = controller;
    this.reader = undefined;
    const now = this.deps.now();
    this.publish({ ...initialState, status: "preparing", startedAt: now, updatedAt: now });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.deps.fetch("/api/download", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds, folderIds }), signal: controller.signal,
      });
      if (this.controller !== controller) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `ZIP download failed (${response.status})`);
      }
      if (!response.body) throw new Error("The server did not return a ZIP stream.");
      const count = Number(response.headers.get("X-Archive-File-Count"));
      this.publish({ status: "receiving", fileCount: Number.isSafeInteger(count) && count > 0 ? count : 0 });
      reader = response.body.getReader();
      this.reader = reader;
      const chunks: BlobPart[] = [];
      let bytes = 0;
      let lastPublished = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (this.controller !== controller || controller.signal.aborted) return;
        if (done) break;
        // Keep the ZIP intact while exposing streaming progress instead of waiting on blob().
        chunks.push(value as Uint8Array<ArrayBuffer>);
        bytes += value.byteLength;
        const receivedAt = this.deps.now();
        if (bytes === value.byteLength || receivedAt - lastPublished >= 100) {
          this.publish({ bytes, updatedAt: receivedAt });
          lastPublished = receivedAt;
        }
      }
      if (controller.signal.aborted) return;
      if (!bytes) throw new Error("The server returned an empty ZIP.");
      let filename = "vault-download.zip";
      try { filename = decodeURIComponent(response.headers.get("X-Archive-Filename") || filename); } catch {}
      this.deps.save(new Blob(chunks, { type: "application/zip" }), filename);
      this.publish({ status: "done", bytes, updatedAt: this.deps.now(), finishedAt: this.deps.now() });
    } catch (error) {
      if (this.controller !== controller) return;
      this.publish(controller.signal.aborted
        ? { status: "cancelled", finishedAt: this.deps.now() }
        : { status: "failed", finishedAt: this.deps.now(), error: error instanceof Error ? error.message : "ZIP download failed" });
    } finally {
      if (controller.signal.aborted) await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (this.controller === controller) { this.controller = undefined; this.reader = undefined; }
    }
  };
}

export const zipDownload = new ZipDownload();
