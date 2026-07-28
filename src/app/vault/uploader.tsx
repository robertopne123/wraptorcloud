"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { FileRecord } from "@/lib/db/types";

type UploadStatus = "uploading" | "done" | "failed";

type UploadItem = {
  id: string;
  file: File;
  progress: number;
  status: UploadStatus;
  error?: string;
};

function uploadWithProgress(uploadUrl: string, file: File, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload to storage failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload to storage failed"));
    xhr.send(file);
  });
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-700">
      <div
        className={`h-full rounded-full transition-all duration-300 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Uploader({
  folderId,
  onUploaded,
}: {
  folderId: string | null;
  onUploaded: (file: FileRecord) => void;
}) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateUpload = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const uploadFile = useCallback(
    async (item: UploadItem) => {
      updateUpload(item.id, { status: "uploading", progress: 0, error: undefined });
      try {
        const presignRes = await fetch("/api/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: item.file.name,
            contentType: item.file.type,
            sizeBytes: item.file.size,
          }),
        });
        if (!presignRes.ok) {
          const body = await presignRes.json().catch(() => ({}));
          throw new Error(body.error ?? "Could not get an upload URL");
        }
        const { uploadUrl, s3Key } = await presignRes.json();
        await uploadWithProgress(uploadUrl, item.file, (progress) => {
          updateUpload(item.id, { progress });
        });
        const createRes = await fetch("/api/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            s3Key,
            displayName: item.file.name,
            contentType: item.file.type,
            sizeBytes: item.file.size,
            folderId,
          }),
        });
        if (!createRes.ok) {
          const body = await createRes.json().catch(() => ({}));
          throw new Error(body.error ?? "Could not save the file record");
        }
        const { file: created } = await createRes.json();
        onUploaded(created);
        updateUpload(item.id, { status: "done", progress: 100 });
      } catch (error) {
        updateUpload(item.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed",
        });
      }
    },
    [folderId, onUploaded, updateUpload],
  );

  const addFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const items: UploadItem[] = Array.from(fileList).map((file) => ({
        id: crypto.randomUUID(),
        file,
        progress: 0,
        status: "uploading",
      }));
      setDismissed(false);
      setMinimised(false);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      setUploads((prev) => [...items, ...prev]);
      items.forEach((item) => void uploadFile(item));
    },
    [uploadFile],
  );

  // Auto-dismiss 5s after all uploads settle
  useEffect(() => {
    if (uploads.length === 0) return;
    const allSettled = uploads.every((u) => u.status === "done" || u.status === "failed");
    if (allSettled) {
      dismissTimer.current = setTimeout(() => setDismissed(true), 5000);
    }
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, [uploads]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      addFiles(event.dataTransfer.files);
    },
    [addFiles],
  );

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      addFiles(event.target.files);
      event.target.value = "";
    },
    [addFiles],
  );

  const total = uploads.length;
  const doneCount = uploads.filter((u) => u.status === "done").length;
  const failedCount = uploads.filter((u) => u.status === "failed").length;
  const allSettled = total > 0 && doneCount + failedCount === total;
  const hasErrors = failedCount > 0;

  return (
    <>
      {/* Drop zone — stays in the page header */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`flex items-center justify-between gap-3 rounded-xl border-2 border-dashed px-4 py-3 transition ${
          isDragging
            ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-900"
            : "border-zinc-300 dark:border-zinc-700"
        }`}
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Drag and drop files here
        </p>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Choose files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />
      </div>

      {/* Upload progress modal — bottom right, sits to the left of migration modal */}
      {total > 0 && !dismissed && (
        <div className="fixed bottom-4 right-[336px] z-50 w-80 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              {!allSettled && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />}
              {allSettled && !hasErrors && <span className="inline-block h-2 w-2 rounded-full bg-green-400" />}
              {allSettled && hasErrors && <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />}
              <span className="text-sm font-medium text-zinc-100">
                {allSettled
                  ? hasErrors ? "Upload finished with errors" : "Upload complete"
                  : `Uploading ${total - doneCount - failedCount} of ${total} file${total > 1 ? "s" : ""}…`}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMinimised((v) => !v)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                aria-label={minimised ? "Expand" : "Minimise"}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
                  {minimised
                    ? <path d="M3 8h10M8 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    : <path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                aria-label="Dismiss"
              >
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                  <path d="M3 3l10 10M13 3 3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          {!minimised && (
            <div className="border-t border-zinc-800 px-4 pb-4 pt-3 space-y-3">
              {/* Overall progress */}
              <div className="space-y-1.5">
                <ProgressBar
                  pct={total > 0 ? Math.round(((doneCount + failedCount) / total) * 100) : 0}
                  color={allSettled ? (hasErrors ? "bg-amber-500" : "bg-green-500") : "bg-blue-500"}
                />
                <p className="text-xs text-zinc-400">
                  {doneCount.toLocaleString()} / {total.toLocaleString()} uploaded
                  {failedCount > 0 && ` · ${failedCount} failed`}
                </p>
              </div>

              {/* Per-file rows */}
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {uploads.map((item) => (
                  <div key={item.id} className="space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-xs text-zinc-300">{item.file.name}</p>
                      <span className="shrink-0 tabular-nums text-xs text-zinc-500">
                        {item.status === "failed"
                          ? <span className="text-red-400">Failed</span>
                          : item.status === "done"
                          ? <span className="text-green-400">Done</span>
                          : `${item.progress}%`}
                      </span>
                    </div>
                    <ProgressBar
                      pct={item.status === "failed" ? 100 : item.progress}
                      color={item.status === "failed" ? "bg-red-500" : item.status === "done" ? "bg-green-600" : "bg-blue-600"}
                    />
                    {item.status === "failed" && (
                      <div className="flex items-center justify-between pt-0.5">
                        <span className="truncate text-xs text-red-400">{item.error}</span>
                        <button
                          type="button"
                          onClick={() => void uploadFile(item)}
                          className="ml-2 shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
