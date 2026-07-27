import { notFound } from "next/navigation";
import {
  getFolder,
  getFolderPath,
  listAllFolders,
  listFiles,
  listFolders,
} from "@/lib/db/queries";
import { VaultBrowser } from "../vault-browser";

export const dynamic = "force-dynamic";

export default async function VaultFolderPage({
  params,
}: {
  params: Promise<{ folderId: string }>;
}) {
  const { folderId } = await params;

  const folder = await getFolder(folderId);
  if (!folder) {
    notFound();
  }

  const [folders, files, breadcrumb, folderTree] = await Promise.all([
    listFolders(folderId),
    listFiles(folderId),
    getFolderPath(folderId),
    listAllFolders(),
  ]);

  return (
    <VaultBrowser
      key={folderId}
      currentFolderId={folderId}
      initialFolders={folders}
      initialFiles={files}
      initialBreadcrumb={breadcrumb}
      initialFolderTree={folderTree}
    />
  );
}
