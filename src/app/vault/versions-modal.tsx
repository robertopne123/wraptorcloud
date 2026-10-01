"use client";

import { useEffect, useState } from "react";
import type { FileRecord, FileVersion } from "@/lib/db/types";
import { Overlay } from "./modals";
import { MediaViewer } from "./viewer";
import { formatBytes, formatDate } from "./format";

export function VersionsModal({ file, onClose }: { file: FileRecord; onClose: () => void }) {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [error, setError] = useState<string>();
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/files/${file.id}/versions`).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load versions");
      if (!cancelled) setFiles([data.current, ...data.versions.map((version: FileVersion) => ({ ...data.current, ...version }))]);
    }).catch((failure: Error) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [file.id]);
  const getViewUrl = (id: string) => id === file.id ? `/api/files/${file.id}/view-url`
    : `/api/files/${file.id}/versions/${id}/view-url`;
  const mediaFiles = files.filter((version) => version.media_type !== "other");
  async function download(id: string) {
    try {
      const response = await fetch(`${getViewUrl(id)}?disposition=attachment`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Download failed");
      const anchor = document.createElement("a"); anchor.href = data.url;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Download failed"); }
  }
  return (
    <>
      <Overlay onClose={onClose}>
        <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Version history</h2>
            <button type="button" onClick={onClose} className="text-sm text-zinc-500">Close</button></div>
          <p className="mt-1 break-words text-sm text-zinc-500">{file.display_name}</p>
          {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
          {!files.length && !error && <p className="mt-4 text-sm text-zinc-500">Loading versions…</p>}
          <div className="mt-4 max-h-80 space-y-2 overflow-y-auto">
            {files.map((version, position) => (
              <div key={version.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                <div><p className="text-sm font-medium">Version {version.version_number}{position === 0 ? " · Current" : ""}</p>
                  <p className="text-xs text-zinc-500">{formatBytes(Number(version.size_bytes))} · {formatDate(version.created_at)}</p></div>
                <div className="flex gap-3 text-sm">
                  {version.media_type !== "other" && <button type="button" onClick={() => setIndex(mediaFiles.findIndex((candidate) => candidate.id === version.id))} className="text-blue-600 dark:text-blue-400">View</button>}
                  <button type="button" onClick={() => void download(version.id)} className="text-blue-600 dark:text-blue-400">Download</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Overlay>
      {index !== null && <MediaViewer files={mediaFiles} index={index} onIndexChange={setIndex} onClose={() => setIndex(null)}
        getViewUrl={getViewUrl} getDownloadUrl={(id) => `${getViewUrl(id)}?disposition=attachment`} allowDownload />}
    </>
  );
}
