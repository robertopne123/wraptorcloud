"use client";

import { useEffect, useRef, useState } from "react";
import type { FileRecord } from "@/lib/db/types";
import { uploadQueue } from "@/lib/uploads/queue";
import { useUploads } from "./upload-provider";
import { prepareUploadFolders, readDroppedItems, type UploadSelection } from "@/lib/uploads/folders";

export function Uploader({ folderId, folderName, onUploaded, onFoldersCreated }: {
  folderId: string | null;
  folderName: string;
  onUploaded: (file: FileRecord) => void;
  onFoldersCreated: () => void;
}) {
  const { ready } = useUploads();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => uploadQueue.subscribeCompleted((file) => {
    if (file.folder_id === folderId) onUploaded(file);
  }), [folderId, onUploaded]);

  async function addSelection(selection: Promise<UploadSelection> | UploadSelection) {
    if (!ready || preparing) return;
    const destination = { folderId, folderName };
    setPreparing(true);
    setError(null);
    // Capture the destination now; later navigation cannot change the job.
    void navigator.storage?.persist?.().catch(() => false);
    try {
      const selected = await selection;
      const destinations = await prepareUploadFolders(selected, destination);
      onFoldersCreated();
      await uploadQueue.enqueue(selected.files.map(({ file }) => file), destination.folderId, destination.folderName, destinations);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not prepare upload. Please try again.");
      onFoldersCreated();
    } finally {
      setPreparing(false);
    }
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    void addSelection({ files: Array.from(files).map((file) => ({ file, path: file.webkitRelativePath || file.name })), directories: [] });
  }

  return (
    <div
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault(); setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault(); setIsDragging(false);
        if (!ready || preparing) return;
        void addSelection(readDroppedItems(Array.from(event.dataTransfer.items), Array.from(event.dataTransfer.files)));
      }}
      className={`flex items-center justify-between gap-3 rounded-xl border-2 border-dashed px-4 py-3 transition ${
        isDragging ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-zinc-300 dark:border-zinc-700"
      }`}
    >
      <div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Drag and drop files or folders here</p>
        <p className="mt-1 text-xs text-zinc-500">All file types supported.</p>
        <p className="mt-1 text-xs text-zinc-500">Uploads continue across folders and resume after refresh.</p>
        {preparing && <p role="status" className="mt-1 text-xs text-zinc-500">Preparing upload…</p>}
        {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
      <button
        type="button" disabled={!ready || preparing} onClick={() => fileInputRef.current?.click()}
        className="shrink-0 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
      >
        Choose files
      </button>
      <button
        type="button" disabled={!ready || preparing} onClick={() => folderInputRef.current?.click()}
        className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >Choose folder</button>
      </div>
      <input ref={fileInputRef} type="file" multiple disabled={!ready}
        onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }}
        className="hidden" aria-label="Choose files to upload" />
      <input ref={folderInputRef} type="file" multiple disabled={!ready || preparing}
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }}
        className="hidden" aria-label="Choose folder to upload" />
    </div>
  );
}
