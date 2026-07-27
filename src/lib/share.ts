import {
  getActiveShareLinkByToken,
  getFile,
  getFolder,
  getFolderPath,
  isFolderOrDescendant,
  listFiles,
  listFolders,
} from "@/lib/db/queries";
import type { FileRecord, Folder, SharePermission } from "@/lib/db/types";

export type ShareResolution =
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "file"; permission: SharePermission; file: FileRecord }
  | {
      kind: "folder";
      permission: SharePermission;
      sharedFolder: Folder;
      folder: Folder;
      breadcrumb: Folder[];
      folders: Folder[];
      files: FileRecord[];
    };

// Shared by the public GET /api/share-links/:token route and the
// server-rendered /share/:token page, so both apply the exact same
// containment/expiry rules rather than two hand-maintained copies of them.
export async function resolveShare(
  token: string,
  requestedFolderId?: string | null,
): Promise<ShareResolution> {
  const share = await getActiveShareLinkByToken(token);
  if (!share) {
    return { kind: "not-found" };
  }

  if (share.file_id) {
    const file = await getFile(share.file_id);
    if (!file) {
      return { kind: "not-found" };
    }
    return { kind: "file", permission: share.permission, file };
  }

  const sharedFolder = await getFolder(share.folder_id!);
  if (!sharedFolder) {
    return { kind: "not-found" };
  }

  let currentFolderId = share.folder_id!;
  if (requestedFolderId) {
    const withinShare = await isFolderOrDescendant(share.folder_id!, requestedFolderId);
    if (!withinShare) {
      return { kind: "forbidden" };
    }
    currentFolderId = requestedFolderId;
  }

  const currentFolder = await getFolder(currentFolderId);
  if (!currentFolder) {
    return { kind: "not-found" };
  }

  const [folders, files, fullPath] = await Promise.all([
    listFolders(currentFolderId),
    listFiles(currentFolderId),
    getFolderPath(currentFolderId),
  ]);

  // Relative to the share root — ancestors above the shared folder aren't
  // part of the share and shouldn't be shown or reachable.
  const shareRootIndex = fullPath.findIndex((folder) => folder.id === share.folder_id);
  const breadcrumb = shareRootIndex === -1 ? [] : fullPath.slice(shareRootIndex);

  return {
    kind: "folder",
    permission: share.permission,
    sharedFolder,
    folder: currentFolder,
    breadcrumb,
    folders,
    files,
  };
}
