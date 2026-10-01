"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { isZipDownloadActive, zipDownload } from "@/lib/zip-download";
import { uploadQueue } from "@/lib/uploads/queue";
import { useUploads } from "./upload-provider";
import { formatBytes } from "./format";
import type { ConflictAction, UploadJob } from "@/lib/uploads/types";

function ConflictPrompt({ job }: { job: UploadJob }) {
  const [repeat, setRepeat] = useState(false);
  const [choosing, setChoosing] = useState(false);
  async function choose(action: ConflictAction) {
    setChoosing(true);
    try { await uploadQueue.resolveConflict(job.id, action, repeat); }
    finally { setChoosing(false); }
  }
  return (
    <section aria-label="Duplicate file" className="space-y-3 rounded-lg border border-amber-700 bg-amber-950/30 p-3">
      <p className="text-sm font-medium">File already exists</p>
      <p className="break-words text-xs text-zinc-300"><strong>{job.name}</strong> already exists in {job.folderName}.</p>
      <div className="space-y-2">
        <button type="button" disabled={choosing} onClick={() => void choose("version")} className="w-full rounded bg-blue-600 px-3 py-2 text-left text-xs hover:bg-blue-500 disabled:opacity-50">
          New version <span className="block text-blue-100">Keep the previous file in version history</span>
        </button>
        <button type="button" disabled={choosing} onClick={() => void choose("replace")} className="w-full rounded border border-zinc-600 px-3 py-2 text-left text-xs hover:bg-zinc-800 disabled:opacity-50">
          Replace <span className="block text-zinc-400">Replace the current file without archiving it</span>
        </button>
        <button type="button" disabled={choosing} onClick={() => void choose("skip")} className="w-full rounded border border-zinc-600 px-3 py-2 text-left text-xs hover:bg-zinc-800 disabled:opacity-50">Skip this file</button>
      </div>
      <label className="flex items-start gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={repeat} disabled={choosing} onChange={(event) => setRepeat(event.target.checked)} className="mt-0.5 accent-blue-500" />
        Apply this action to all remaining duplicates in this batch
      </label>
    </section>
  );
}

export function useZipDownload() {
  return useSyncExternalStore(zipDownload.subscribe, zipDownload.getSnapshot, zipDownload.getServerSnapshot);
}

export function TransferPanel() {
  const { jobs, saving, error } = useUploads();
  const zip = useZipDownload();
  const zipActive = isZipDownloadActive(zip);
  const [minimised, setMinimised] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!zipActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [zipActive]);
  const done = jobs.filter((job) => job.status === "done").length;
  const uploading = jobs.filter((job) => job.status === "uploading").length;
  const queued = jobs.filter((job) => job.status === "queued").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  const skipped = jobs.filter((job) => job.status === "skipped").length;
  const conflict = jobs.find((job) => job.status === "conflict");
  const expanded = !minimised || !!conflict;
  const zipSettled = zip.status !== "idle" && !zipActive;
  const canClose = !saving && !zipActive && jobs.every((job) => job.status === "done" || job.status === "skipped");
  async function clearTransfers() {
    await uploadQueue.clearCompleted();
    zipDownload.dismiss();
    uploadQueue.clearError();
  }
  const visibleJobs = [
    ...jobs.filter((job) => job.status === "uploading"), ...jobs.filter((job) => job.status === "failed"),
    ...jobs.filter((job) => job.status === "conflict"), ...jobs.filter((job) => job.status === "queued"),
    ...jobs.filter((job) => job.status === "done" || job.status === "skipped").reverse(),
  ].slice(0, 50);
  const hasUploads = jobs.length > 0 || saving > 0 || !!error;
  if (!hasUploads && zip.status === "idle") return null;
  const seconds = Math.max(0, Math.floor(((zip.finishedAt ?? now) - zip.startedAt) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return (
    <aside aria-label="Uploads and ZIP downloads" className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-2xl">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div>
          <p className="text-sm font-medium">Transfers</p>
          <p role="status" className="text-xs text-zinc-400">
            {conflict ? "Upload needs your choice" : uploading || queued || saving ? `${uploading} uploading · ${queued} queued${saving ? ` · ${saving} saving` : ""}` : failed ? `${failed} uploads need attention` : hasUploads ? "Uploads complete" : "ZIP download"}
            {zipActive && hasUploads ? " · ZIP in progress" : ""}
          </p>
        </div>
        <button type="button" disabled={!!conflict} onClick={() => setMinimised(!minimised)} aria-expanded={expanded}
          aria-label={minimised ? "Expand transfers" : "Minimise transfers"}
          className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800">{minimised ? "+" : "−"}</button>
      </div>
      {expanded && (
        <div className="max-h-[70vh] space-y-4 overflow-y-auto border-t border-zinc-800 p-4">
          {conflict && <ConflictPrompt key={conflict.id} job={conflict} />}
          {zip.status !== "idle" && (
            <section aria-label="ZIP download" className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium" role="status">
                  {zip.status === "preparing" ? "Preparing ZIP…" : zip.status === "receiving" ? "Building and receiving ZIP…"
                    : zip.status === "done" ? "ZIP ready — download started" : zip.status === "cancelled" ? "ZIP cancelled" : "ZIP failed"}
                </p>
                <button type="button" onClick={zipActive ? zipDownload.cancel : zipDownload.dismiss}
                  className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800">{zipActive ? "Cancel" : "Dismiss"}</button>
              </div>
              {(zipActive || zip.status === "done") && (
                <div role="progressbar" aria-label="ZIP download progress" aria-valuetext={`${formatBytes(zip.bytes)} received`} className="h-1.5 overflow-hidden rounded-full bg-zinc-700">
                  <div className={`h-full rounded-full ${zipActive ? "w-1/3 animate-[slide_1.5s_ease-in-out_infinite] bg-blue-500 motion-reduce:animate-none" : "w-full bg-green-500"}`} />
                </div>
              )}
              <div className="flex justify-between text-xs text-zinc-400">
                <span>{formatBytes(zip.bytes)} received{zip.fileCount ? ` · ${zip.fileCount} files` : ""}</span><span>{elapsed} elapsed</span>
              </div>
              {zipActive && now - zip.updatedAt > 10_000 && <p className="text-xs text-amber-300">Waiting for more data from the server…</p>}
              {zip.error && <p role="alert" className="text-xs text-red-300">{zip.error}</p>}
            </section>
          )}
          {hasUploads && (
            <section aria-label="Upload queue" className="space-y-3">
              <p className="text-sm font-medium">Uploads <span className="font-normal text-zinc-400">{done} / {jobs.length}{skipped ? ` · ${skipped} skipped` : ""}</span></p>
              {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
              {saving > 0 && <p className="text-xs text-amber-300">Keep this page open until files finish saving locally.</p>}
              <div className="max-h-64 space-y-3 overflow-y-auto">
                {visibleJobs.map((job) => (
                  <div key={job.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-xs"><span className="min-w-0 truncate" title={job.name}>{job.name}</span>
                      <span className="shrink-0 text-zinc-400">{job.status === "done" ? "Done" : job.status === "skipped" ? "Skipped" : job.status === "conflict" ? "Needs choice" : job.status === "failed" ? "Failed" : job.status === "queued" ? "Queued" : job.progress >= 99 ? "Finishing…" : `${job.progress}%`}</span>
                    </div>
                    <p className="truncate text-xs text-zinc-500">To: {job.folderName}</p>
                    <div role="progressbar" aria-label={`Uploading ${job.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress} className="h-1.5 overflow-hidden rounded-full bg-zinc-700">
                      <div className={`h-full rounded-full transition-[width] ${job.status === "failed" ? "bg-red-500" : job.status === "done" ? "bg-green-500" : "bg-blue-500"}`} style={{ width: `${job.progress}%` }} />
                    </div>
                    {job.status === "failed" && <div className="flex items-start justify-between gap-2"><p className="text-xs text-red-300">{job.error}</p>
                      <button type="button" onClick={() => void uploadQueue.retry(job.id)} className="shrink-0 rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800">Retry</button></div>}
                  </div>
                ))}
              </div>
              {jobs.length > visibleJobs.length && <p className="text-xs text-zinc-500">Showing {visibleJobs.length} of {jobs.length} files. Active uploads appear first.</p>}
            </section>
          )}
          {(done > 0 || skipped > 0 || zipSettled || error) && <button type="button" onClick={() => void clearTransfers()}
            className="w-full rounded border border-zinc-600 px-3 py-2 text-xs font-medium hover:bg-zinc-800">{canClose ? "Clear transfers" : "Clear completed"}</button>}
        </div>
      )}
    </aside>
  );
}
