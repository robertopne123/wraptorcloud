"use client";

import { useCallback, useState } from "react";
import type { FileRecord, Folder, SharePermission } from "@/lib/db/types";
import { FolderIcon, VideoIcon, ImageIcon } from "@/app/vault/icons";
import { formatBytes, formatDate } from "@/app/vault/format";
import { MediaViewer } from "@/app/vault/viewer";

type FolderData = {
  sharedFolder: Folder;
  folder: Folder;
  breadcrumb: Folder[];
  folders: Folder[];
  files: FileRecord[];
};

export function PublicFolderBrowser({
  token,
  permission,
  initialData,
}: {
  token: string;
  permission: SharePermission;
  initialData: FolderData;
}) {
  const [data, setData] = useState(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const navigateToFolder = useCallback(
    async (folderId: string) => {
      setIsLoading(true);
      setError(null);

      const res = await fetch(`/api/share-links/${token}?folderId=${folderId}`);

      setIsLoading(false);

      if (!res.ok) {
        setError("Could not open that folder.");
        return;
      }

      const body = await res.json();
      if (body.type === "folder") {
        setData(body);
      }
    },
    [token],
  );

  const getViewUrl = (fileId: string) => `/api/share-links/${token}/files/${fileId}/view-url`;
  const getDownloadUrl = (fileId: string) =>
    `/api/share-links/${token}/files/${fileId}/view-url?disposition=attachment`;

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 bg-zinc-50 px-4 py-8 dark:bg-black">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {data.sharedFolder.name}
        </h1>
        <nav className="flex flex-wrap items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
          {data.breadcrumb.map((folder, index) => {
            const isLast = index === data.breadcrumb.length - 1;
            return (
              <span key={folder.id} className="flex items-center gap-1">
                {index > 0 && <span>/</span>}
                {isLast ? (
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">
                    {folder.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => navigateToFolder(folder.id)}
                    className="hover:underline"
                  >
                    {folder.name}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {isLoading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
      ) : data.folders.length === 0 && data.files.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">This folder is empty.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {data.folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              onClick={() => navigateToFolder(folder.id)}
              className="flex flex-col items-center gap-2 rounded-lg border border-zinc-200 p-3 py-4 text-center hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50"
            >
              <FolderIcon className="h-10 w-10 text-zinc-400 dark:text-zinc-500" />
              <span className="line-clamp-2 w-full text-sm text-zinc-800 dark:text-zinc-200">
                {folder.name}
              </span>
            </button>
          ))}
          {data.files.map((file, fileIndex) => {
            const Icon = file.media_type === "video" ? VideoIcon : ImageIcon;
            return (
              <button
                key={file.id}
                type="button"
                onClick={() => setViewerIndex(fileIndex)}
                className="flex flex-col items-center gap-2 rounded-lg border border-zinc-200 p-3 py-4 text-center hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50"
              >
                <Icon className="h-10 w-10 text-zinc-400 dark:text-zinc-500" />
                <span className="line-clamp-2 w-full text-sm text-zinc-800 dark:text-zinc-200">
                  {file.display_name}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {formatBytes(Number(file.size_bytes))} · {formatDate(file.created_at)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {viewerIndex !== null && (
        <MediaViewer
          files={data.files}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          getViewUrl={getViewUrl}
          getDownloadUrl={getDownloadUrl}
          allowDownload={permission === "download"}
        />
      )}
    </div>
  );
}
