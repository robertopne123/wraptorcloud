"use client";

import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import type { FileRecord, Folder } from "@/lib/db/types";
import { previewKind, type PreviewData, type ArchiveItem } from "@/lib/preview-types";
import { uploadQueue } from "@/lib/uploads/queue";
import { prepareUploadFolders } from "@/lib/uploads/folders";
import { useUploads } from "./upload-provider";
import { formatBytes } from "./format";

function AudioPreview({ data }: { data: Extract<PreviewData, { kind: "audio" }> }) {
  const container = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!container.current || !audio.current || !data.peaks.length) return;
    const waveform = WaveSurfer.create({
      container: container.current, media: audio.current, url: data.url,
      peaks: [data.peaks], duration: data.duration,
      height: 130, waveColor: "#a1a1aa", progressColor: "#3b82f6",
      cursorColor: "#2563eb", barWidth: 2, barGap: 1, dragToSeek: true,
    });
    waveform.on("error", () => setError("This audio format cannot be played by your browser. You can download it instead."));
    return () => waveform.destroy();
  }, [data]);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-12">
      <div ref={container} aria-label="Audio waveform. Click or drag to seek." />
      <audio ref={audio} src={data.url} controls preload="metadata" className="w-full"
        onError={() => setError("This audio format cannot be played by your browser. You can download it instead.")} />
      <p className="text-sm text-zinc-500">Click or drag the waveform to seek, or use the player controls.</p>
      {data.waveformError && <p role="status" className="text-sm text-amber-600">{data.waveformError}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function SpreadsheetPreview({ data }: { data: Extract<PreviewData, { kind: "spreadsheet" }> }) {
  const [index, setIndex] = useState(0);
  const sheet = data.sheets[index];
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2" aria-label="Worksheets">
        {data.sheets.map((sheet, position) => <button key={position} type="button" aria-pressed={position === index}
          className={`rounded border px-3 py-1 text-sm ${position === index ? "bg-blue-600 text-white" : "border-zinc-300 dark:border-zinc-700"}`}
          onClick={() => setIndex(position)}>{sheet.name}</button>)}
      </div>
      {sheet?.truncated && <p className="text-xs text-zinc-500">Showing the first 500 rows and 50 columns.</p>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-sm">
          <tbody>{sheet?.rows.map((row, index) => <tr key={index}>
            <th scope="row" className="sticky left-0 border border-zinc-300 bg-zinc-100 px-3 py-1 dark:border-zinc-700 dark:bg-zinc-900">{index + 1}</th>
            {row.map((cell, column) => <td key={column} className="max-w-96 whitespace-pre-wrap border border-zinc-300 px-3 py-1 dark:border-zinc-700">{cell}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function ArchivePreview({ entries, file, endpoint, folderTree, destinationId, onExtracted, allowExtract }: {
  entries: ArchiveItem[]; file: FileRecord; endpoint: string; folderTree: Folder[];
  destinationId: string | null; onExtracted: () => void; allowExtract: boolean;
}) {
  const { ready } = useUploads();
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState(destinationId ?? "");
  const [folderName, setFolderName] = useState(file.display_name.replace(/\.(tar\.gz|zip|tar|tgz|gz)$/i, ""));
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function extract(intoFolder: boolean) {
    if (busy) return;
    setBusy(true); setError(null);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const prefix = intoFolder ? folderName.trim() : "";
      if (intoFolder && (!prefix || /[\\/]/.test(prefix) || prefix === "." || prefix === "..")) throw new Error("Enter a folder name without slashes.");
      const files = entries.filter((entry) => !entry.directory);
      const selected: { file: File; path: string }[] = [];
      for (const [index, entry] of files.entries()) {
        setProgress(`Preparing ${index + 1} of ${files.length}: ${entry.path}`);
        const response = await fetch(`${endpoint}?entry=${encodeURIComponent(entry.path)}`, { signal: abort.signal });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Could not read archive entry");
        }
        const blob = await response.blob();
        selected.push({ file: new File([blob], entry.path.split("/").pop()!, { type: blob.type }), path: prefix ? `${prefix}/${entry.path}` : entry.path });
      }
      const directories = entries.filter((entry) => entry.directory).map((entry) => prefix ? `${prefix}/${entry.path}` : entry.path);
      if (prefix) directories.unshift(prefix);
      const parentId = intoFolder ? folderId || null : null;
      const destination = { folderId: parentId, folderName: folderTree.find((folder) => folder.id === parentId)?.name ?? "All files" };
      setProgress("Creating folders and saving extracted files to the upload queue…");
      const destinations = await prepareUploadFolders({ files: selected, directories }, destination,
        (path, init) => fetch(path, { ...init, signal: abort.signal }));
      abort.signal.throwIfAborted();
      await uploadQueue.enqueue(selected.map(({ file }) => file), destination.folderId, destination.folderName, destinations);
      onExtracted();
      if (uploadQueue.getSnapshot().error) throw new Error(uploadQueue.getSnapshot().error);
      setProgress("Extracted files are in the upload queue. You can close this preview; uploads continue.");
    } catch (error) {
      if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "Extraction failed. Please try again.");
    } finally { setBusy(false); }
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-3">
        <p className="shrink-0 text-sm">{entries.filter((entry) => !entry.directory).length} files · {formatBytes(entries.reduce((sum, entry) => sum + entry.size, 0))}</p>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search archive contents" placeholder="Search contents"
          className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm"><thead><tr><th className="p-2">Path</th><th className="p-2">Size</th></tr></thead>
          <tbody>{entries.filter((entry) => entry.path.toLowerCase().includes(query.toLowerCase())).map((entry) => <tr key={entry.path} className="border-t border-zinc-200 dark:border-zinc-800">
            <td className="break-all p-2">{entry.directory ? "📁 " : ""}{entry.path}{entry.directory ? "/" : ""}</td>
            <td className="whitespace-nowrap p-2">{entry.directory ? "Folder" : formatBytes(entry.size)}</td>
          </tr>)}</tbody>
        </table>
        {!entries.length && <p className="p-4 text-sm text-zinc-500">This archive is empty.</p>}
      </div>
      {allowExtract && <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-200 p-3 dark:border-zinc-800">
        <label className="text-xs">Parent folder
          <select value={folderId} onChange={(event) => setFolderId(event.target.value)} disabled={busy} className="ml-2 max-w-52 rounded border bg-white px-2 py-1.5 text-sm dark:bg-zinc-900">
            <option value="">All files</option>{folderTree.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
        </label>
        <input aria-label="Extraction folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} disabled={busy}
          className="min-w-0 rounded border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700" />
        <button type="button" onClick={() => void extract(true)} disabled={busy || !ready} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">Extract into folder</button>
        <button type="button" onClick={() => void extract(false)} disabled={busy || !ready} className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700">Extract into All files</button>
        <p className="w-full text-xs text-zinc-500">Internal folders are preserved. Existing files use the upload queue&apos;s duplicate-file choices.</p>
      </div>}
      {progress && <p role="status" className="text-sm text-zinc-500">{progress}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function FilePreview({ file, onClose, folderTree = [], destinationId = null, onExtracted = () => {},
  endpoint = `/api/files/${file.id}/preview`, downloadEndpoint = `/api/files/${file.id}/view-url?disposition=attachment`,
  allowDownload = true, allowExtract = true,
}: {
  file: FileRecord; onClose: () => void; folderTree?: Folder[]; destinationId?: string | null; onExtracted?: () => void;
  endpoint?: string; downloadEndpoint?: string; allowDownload?: boolean; allowExtract?: boolean;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const abort = new AbortController();
    fetch(endpoint, { signal: abort.signal }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not preview this file");
      setData(result);
    }).catch((error) => { if (!abort.signal.aborted) setError(error.message); });
    return () => { abort.abort(); element?.close(); };
  }, [endpoint]);
  async function download() {
    try {
      const response = await fetch(downloadEndpoint);
      if (!response.ok) throw new Error("Could not download this file");
      const { url } = await response.json();
      const link = document.createElement("a"); link.href = url; link.download = file.display_name; link.click();
    } catch (error) { setError(error instanceof Error ? error.message : "Download failed"); }
  }
  return (
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="file-preview-title"
      className="fixed inset-0 m-auto h-[90dvh] w-[min(96vw,1100px)] max-w-none overflow-hidden rounded-xl border border-zinc-300 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 id="file-preview-title" className="min-w-0 flex-1 truncate text-sm font-semibold">{file.display_name}</h2>
          {allowDownload && <button type="button" onClick={() => void download()} className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Download</button>}
          <button type="button" onClick={onClose} aria-label="Close preview" className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Close</button>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4">
          {!data && !error && <p role="status" className="text-sm text-zinc-500">{previewKind(file.display_name, file.mime_type) === "audio" ? "Generating waveform…" : "Loading preview…"}</p>}
          {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
          {data?.kind === "pdf" && <iframe title={file.display_name} src={data.url} className="h-full min-h-96 w-full rounded border-0 bg-white" />}
          {data?.kind === "document" && <>
            {data.truncated && <p className="mb-3 text-xs text-zinc-500">Preview shortened. Download for the full document.</p>}
            <iframe title={file.display_name} sandbox="" className="h-full min-h-96 w-full rounded border-0 bg-white"
              srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{font:16px/1.6 system-ui,sans-serif;max-width:850px;margin:24px auto;padding:24px;color:#18181b}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px}pre{white-space:pre-wrap}</style></head><body>${data.html}</body></html>`} />
          </>}
          {data?.kind === "text" && <>
            {data.truncated && <p className="mb-3 text-xs text-zinc-500">Preview shortened. Download for the full document.</p>}
            <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6">{data.text || "This document is empty."}</pre>
          </>}
          {data?.kind === "spreadsheet" && <SpreadsheetPreview data={data} />}
          {data?.kind === "audio" && <AudioPreview data={data} />}
          {data?.kind === "archive" && <ArchivePreview entries={data.entries} file={file} endpoint={endpoint} folderTree={folderTree} destinationId={destinationId} onExtracted={onExtracted} allowExtract={allowExtract} />}
          {data?.kind === "unsupported" && <p className="text-sm text-zinc-500">A preview is not available for this format. {allowDownload ? "Download the file to open it in its own application." : "Contact the owner for download access."}</p>}
        </main>
      </div>
    </dialog>
  );
}
