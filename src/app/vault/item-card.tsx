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
          ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-900"
          : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50"
      }`}
    >
      <div className="flex items-start justify-between">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(event) => event.stopPropagation()}
          className="h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
          aria-label="Select"
        />
        {menu}
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-col items-center gap-2 py-2 text-center"
      >
        {icon}
        <span className="line-clamp-2 w-full text-sm text-zinc-800 dark:text-zinc-200">
          {title}
        </span>
      </button>
      <span className="text-center text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</span>
    </div>
  );
}

export function FolderCard({
  folder,
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
      icon={<FolderIcon className="h-10 w-10 text-zinc-400 dark:text-zinc-500" />}
      title={folder.name}
      subtitle="Folder"
      menu={
        <ItemMenu
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
}: {
  fileId: string;
  hasThumbnailKey: boolean;
  mediaType: "video" | "image" | "other";
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const Icon = mediaType === "video" ? VideoIcon : mediaType === "image" ? ImageIcon : FileIcon;

  useEffect(() => {
    if (!hasThumbnailKey || mediaType === "other") return;
    let cancelled = false;
    fetch(`/api/files/${fileId}/thumbnail-url`)
      .then((r) => r.json())
      .then((data: { url: string | null }) => {
        if (!cancelled && data.url) setThumbnailUrl(data.url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fileId, hasThumbnailKey, mediaType]);

  if (thumbnailUrl) {
    return (
      <img
        src={thumbnailUrl}
        alt=""
        className="h-20 w-full rounded object-cover"
        onError={() => setThumbnailUrl(null)}
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
}) {
  return (
    <Tile
      selected={selected}
      onToggleSelect={onToggleSelect}
      onOpen={onOpen}
      icon={
        <FileThumbnail
          fileId={file.id}
          hasThumbnailKey={file.thumbnail_key !== null}
          mediaType={file.media_type}
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
        />
      }
    />
  );
}
