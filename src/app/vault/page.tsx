import { listAllFolders, listFiles, listFolders } from "@/lib/db/queries";
import { VaultWorkspace } from "./vault-workspace";

export const dynamic = "force-dynamic";

export default async function VaultRootPage() {
  const [folders, files, folderTree] = await Promise.all([
    listFolders(null),
    listFiles(null),
    listAllFolders(),
  ]);

  return (
    <VaultWorkspace
      key="root"
      currentFolderId={null}
      initialFolders={folders}
      initialFiles={files}
      initialBreadcrumb={[]}
      initialFolderTree={folderTree}
    />
  );
}
