"use client";

import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useSearchParams } from "next/navigation";
import type { FileRecord } from "@/lib/db/types";

type UploadStatus = "uploading" | "done" | "failed";

type UploadItem = {
  id: string;
  file: File;
  progress: number;
  status: UploadStatus;
  error?: string;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function uploadWithProgress(uploadUrl: string, file: File, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload to storage failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error("Upload to storage failed"));

    xhr.send(file);
  });
}

export function UploadDashboard({ initialFiles }: { initialFiles: FileRecord[] }) {
  const searchParams = useSearchParams();
  const folderId = searchParams.get("folderId");

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [files, setFiles] = useState<FileRecord[]>(initialFiles);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

        setFiles((prev) => [created, ...prev]);
        updateUpload(item.id, { status: "done", progress: 100 });
      } catch (error) {
        updateUpload(item.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed",
        });
      }
    },
    [folderId, updateUpload],
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

      setUploads((prev) => [...items, ...prev]);
      items.forEach((item) => {
        void uploadFile(item);
      });
    },
    [uploadFile],
  );

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

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 bg-zinc-50 px-4 py-10 dark:bg-black">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Wraptor Vault</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Upload footage {folderId ? `to folder ${folderId}` : "to the root library"}.
        </p>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition ${
          isDragging
            ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-900"
            : "border-zinc-300 dark:border-zinc-700"
        }`}
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Drag and drop video or image files here
        </p>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Choose files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,image/*"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />
      </div>

      {uploads.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Uploads</h2>
          {uploads.map((item) => (
            <div key={item.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="truncate text-zinc-800 dark:text-zinc-200">{item.file.name}</span>
                <span className="ml-2 shrink-0 text-zinc-500 dark:text-zinc-400">
                  {item.status === "failed" ? "Failed" : item.status === "done" ? "Done" : `${item.progress}%`}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className={`h-full rounded-full transition-all ${
                    item.status === "failed" ? "bg-red-500" : "bg-zinc-900 dark:bg-zinc-100"
                  }`}
                  style={{ width: `${item.status === "failed" ? 100 : item.progress}%` }}
                />
              </div>
              {item.status === "failed" && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-red-500">{item.error}</span>
                  <button
                    type="button"
                    onClick={() => uploadFile(item)}
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Files</h2>
        {files.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No files yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {files.map((file) => (
              <li key={file.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="truncate text-zinc-800 dark:text-zinc-200">{file.display_name}</span>
                <span className="ml-2 shrink-0 text-zinc-500 dark:text-zinc-400">
                  {file.media_type} · {formatBytes(Number(file.size_bytes))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
