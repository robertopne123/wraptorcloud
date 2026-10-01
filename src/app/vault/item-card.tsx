"use client";

import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import type { FileRecord, Folder } from "@/lib/db/types";
import { FolderIcon, VideoIcon, ImageIcon, FileIcon } from "./icons";
import { ItemMenu } from "./item-menu";
import { formatBytes, formatDate } from "./format";

function Tile({
  selected,
  onToggleSelect,
  onOpen,
  icon,
  title,
  subtitle,
  menu,
}: {
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  icon: ReactNode;
  title: string;
  subtitle: string;
  menu: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border p-3 transition ${
        selected
          ? "border-blue-500 bg-blue-50 ring-2 ring-blue-500 dark:border-blue-400 dark:bg-blue-950/50 dark:ring-blue-400"
          : "border-zinc-200 hover:border-blue-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-blue-700 dark:hover:bg-zinc-900/50"
      }`}
    >
      <div className="flex items-start justify-between">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(event) => event.stopPropagation()}
          className="h-4 w-4 accent-blue-600 dark:accent-blue-400"
          aria-label={`Select ${title}`}
        />
        {menu}
      </div>
      <button
        type="button"
        onClick={(event) => {
          // Native keyboard activation opens; the first pointer click selects.
          if (event.detail === 0) onOpen();
          else if (event.detail === 1 && !selected) onToggleSelect();
        }}
        onDoubleClick={onOpen}
        aria-pressed={selected}
        aria-label={`${title}. Click to select, double-click to open, or press Enter to open.`}
        className="flex cursor-pointer flex-col items-center gap-2 rounded py-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {icon}
        <span className="line-clamp-2 w-full text-sm text-zinc-800 dark:text-zinc-200">
          {title}
        </span>
      </button>
      <span className="text-center text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</span>
      <div className="flex min-h-6 items-center justify-center">
        {selected ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${title}`}
            className="rounded px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300 dark:hover:bg-blue-900"
          >
            Open
          </button>
        ) : (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Double-click to open</span>
        )}
      </div>
    </div>
  );
}

function FolderContentsIcon({ folder }: { folder: Folder }) {
  const folderCount = folder.folder_count ?? 0;
  const fileCount = folder.file_count ?? 0;
  const total = folderCount + fileCount;

  if (total <= 1) {
    return <FolderIcon className="h-10 w-10 text-zinc-400 dark:text-zinc-500" />;
  }

  // Keep large folders compact while representing both kinds of contents.
  const layers = Math.min(total, 4);
  const folderLayers = fileCount === 0 ? layers : folderCount === 0 ? 0 : Math.max(1, layers - fileCount);

  return (
    <span className="relative block h-16 w-20" aria-hidden="true">
      {Array.from({ length: layers }, (_, index) => {
        const Icon = index < folderLayers ? FolderIcon : FileIcon;
        return (
          <span
            key={index}
            className="absolute flex h-11 w-11 items-center justify-center overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
            style={{ left: index * 9, top: index * 5, zIndex: index + 1 }}
          >
            <Icon className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
          </span>
        );
      })}
      <span className="absolute -right-1 bottom-0 z-10 rounded-full bg-zinc-700 px-1.5 py-0.5 text-[10px] font-semibold text-white dark:bg-zinc-200 dark:text-zinc-900">
        {total}
      </span>
    </span>
  );
}

export function FolderCard({
  folder,
  onOpenTab,
  selected,
  onToggleSelect,
  onOpen,
  onDownload,
  onShare,
  onRename,
  onMove,
  onDelete,
}: {
  folder: Folder;
  onOpenTab?: () => void;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onDownload: () => void;
  onShare: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <Tile
      selected={selected}
      onToggleSelect={onToggleSelect}
      onOpen={onOpen}
      icon={<FolderContentsIcon folder={folder} />}
      title={folder.name}
      subtitle={folder.file_count === undefined ? "Folder" : [
        `${folder.folder_count ?? 0} ${(folder.folder_count ?? 0) === 1 ? "folder" : "folders"}`,
        `${folder.file_count} ${folder.file_count === 1 ? "file" : "files"}`,
      ].join(" · ")}
      menu={
        <ItemMenu
          onOpenTab={onOpenTab}
          onDownload={onDownload}
          onShare={onShare}
          onRename={onRename}
          onMove={onMove}
          onDelete={onDelete}
        />
      }
    />
  );
}

function FileThumbnail({
  fileId,
  hasThumbnailKey,
  mediaType,
  previewVersion = 0,
  onPreviewAvailable,
}: {
  fileId: string;
  hasThumbnailKey: boolean;
  mediaType: "video" | "image" | "other";
  previewVersion?: number;
  onPreviewAvailable?: (available: boolean) => void;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const Icon = mediaType === "video" ? VideoIcon : mediaType === "image" ? ImageIcon : FileIcon;

  useEffect(() => {
    if ((!hasThumbnailKey && previewVersion === 0) || mediaType === "other") return;
    let cancelled = false;
    fetch(`/api/files/${fileId}/thumbnail-url`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { url: string | null }) => {
        if (!cancelled && data.url) {
          setThumbnailUrl(data.url);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fileId, hasThumbnailKey, mediaType, previewVersion]);

  if (thumbnailUrl) {
    return (
      <img
        src={thumbnailUrl}
        alt=""
        className="h-20 w-full rounded object-cover"
        loading="lazy"
        onLoad={() => onPreviewAvailable?.(true)}
        onError={() => {
          setThumbnailUrl(null);
          onPreviewAvailable?.(false);
        }}
      />
    );
  }

  return <Icon className="h-10 w-10 text-zinc-400 dark:text-zinc-500" />;
}

export function FileCard({
  file,
  selected,
  onToggleSelect,
  onOpen,
  onDownload,
  onShare,
  onRename,
  onMove,
  onDelete,
  onVersions,
}: {
  file: FileRecord;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onDownload: () => void;
  onShare: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onVersions: () => void;
}) {
  const [previewSource, setPreviewSource] = useState<string | null>(null);
  const previewAvailable = previewSource === file.s3_key;
  const [previewVersion, setPreviewVersion] = useState(0);
  const [refreshingPreview, setRefreshingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function refreshPreview() {
    if (refreshingPreview) return;
    setRefreshingPreview(true);
    setPreviewError(null);
    try {
      const response = await fetch(`/api/files/${file.id}/refresh-preview`, { method: "POST" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Could not refresh preview. Please try again.");
      }
      setPreviewVersion(Date.now());
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Could not refresh preview. Please try again.");
    } finally {
      setRefreshingPreview(false);
    }
  }

  return (
    <div>
    <Tile
      selected={selected}
      onToggleSelect={onToggleSelect}
      onOpen={onOpen}
      icon={
        <FileThumbnail
          fileId={file.id}
          hasThumbnailKey={file.thumbnail_key !== null}
          mediaType={file.media_type}
          key={`${file.id}-${file.s3_key}-${previewVersion}`}
          previewVersion={previewVersion}
          onPreviewAvailable={(available) => setPreviewSource(available ? file.s3_key : null)}
        />
      }
      title={file.display_name}
      subtitle={`${formatBytes(Number(file.size_bytes))} · ${formatDate(file.created_at)}`}
      menu={
        <ItemMenu
          onDownload={onDownload}
          onShare={onShare}
          onRename={onRename}
          onMove={onMove}
          onDelete={onDelete}
          onRefreshPreview={file.media_type !== "other" && !previewAvailable ? refreshPreview : undefined}
          onVersions={onVersions}
          refreshingPreview={refreshingPreview}
        />
      }
    />
    {refreshingPreview && <p role="status" className="mt-1 text-xs text-zinc-500">Refreshing preview…</p>}
    {previewError && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{previewError}</p>}
    </div>
  );
}
