import { listAllFolders, listFiles, listFolders } from "@/lib/db/queries";
import { VaultBrowser } from "./vault-browser";

export const dynamic = "force-dynamic";

export default async function VaultRootPage() {
  const [folders, files, folderTree] = await Promise.all([
    listFolders(null),
    listFiles(null),
    listAllFolders(),
  ]);

  return (
    <VaultBrowser
      key="root"
      currentFolderId={null}
      initialFolders={folders}
      initialFiles={files}
      initialBreadcrumb={[]}
      initialFolderTree={folderTree}
    />
  );
}
