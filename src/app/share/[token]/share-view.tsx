"use client";

import { useState } from "react";
import type { FileRecord, Folder, SharePermission } from "@/lib/db/types";
import { MediaViewer } from "@/app/vault/viewer";
import { PublicFolderBrowser } from "./public-folder-browser";

type ShareData =
  | { type: "file"; file: FileRecord }
  | {
      type: "folder";
      sharedFolder: Folder;
      folder: Folder;
      breadcrumb: Folder[];
      folders: Folder[];
      files: FileRecord[];
    };

export function ShareView({
  token,
  permission,
  data,
}: {
  token: string;
  permission: SharePermission;
  data: ShareData;
}) {
  const [fileViewerClosed, setFileViewerClosed] = useState(false);

  const getViewUrl = (fileId: string) => `/api/share-links/${token}/files/${fileId}/view-url`;
  const getDownloadUrl = (fileId: string) =>
    `/api/share-links/${token}/files/${fileId}/view-url?disposition=attachment`;

  if (data.type === "file") {
    if (fileViewerClosed) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-black">
          <p className="text-sm text-zinc-400">Viewer closed.</p>
          <button
            type="button"
            onClick={() => setFileViewerClosed(false)}
            className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-200"
          >
            View again
          </button>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-black">
        <MediaViewer
          files={[data.file]}
          index={0}
          onClose={() => setFileViewerClosed(true)}
          onIndexChange={() => {}}
          getViewUrl={getViewUrl}
          getDownloadUrl={getDownloadUrl}
          allowDownload={permission === "download"}
        />
      </div>
    );
  }

  return (
    <PublicFolderBrowser
      token={token}
      permission={permission}
      initialData={data}
    />
  );
}
