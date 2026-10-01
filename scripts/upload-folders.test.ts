import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareUploadFolders, readDroppedItems } from "../src/lib/uploads/folders";
import type { Folder } from "../src/lib/db/types";

test("folder uploads reuse matching folders, preserve nested paths and create empty directories", async () => {
  const folders: Folder[] = [{ id: "existing", name: "Photos", parent_id: null } as Folder];
  const creates: { name: string; parentId: string | null }[] = [];
  const destinations = await prepareUploadFolders({
    directories: ["Photos/Empty"],
    files: [
      { file: new File(["a"], "one.jpg"), path: "Photos/Trip/one.jpg" },
      { file: new File(["b"], "two.jpg"), path: "Photos/Trip/two.jpg" },
      { file: new File(["c"], "root.txt"), path: "root.txt" },
    ],
  }, { folderId: null, folderName: "Vault" }, async (path, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      creates.push(body);
      const folder = { id: `new-${creates.length}`, name: body.name, parent_id: body.parentId } as Folder;
      folders.push(folder);
      return Response.json({ folder });
    }
    const parent = new URL(path, "https://test.local").searchParams.get("parentId");
    return Response.json({ folders: folders.filter((folder) => folder.parent_id === (parent === "null" ? null : parent)) });
  });
  assert.deepEqual(creates, [{ name: "Empty", parentId: "existing" }, { name: "Trip", parentId: "existing" }]);
  assert.deepEqual(destinations, [
    { folderId: "new-2", folderName: "Vault/Photos/Trip" },
    { folderId: "new-2", folderName: "Vault/Photos/Trip" },
    { folderId: null, folderName: "Vault" },
  ]);
});

test("dropped directories read every batch and keep empty subfolders", async () => {
  const file = new File(["a"], "clip.mp4");
  const batches = [
    [{ name: file.name, isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(file) }],
    [{ name: "Empty", isFile: false, isDirectory: true, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve([]) }) }],
    [],
  ];
  const entry = { name: "Footage", isFile: false, isDirectory: true,
    createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve(batches.shift()!) }) };
  const selection = await readDroppedItems([{
    kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null,
  } as unknown as DataTransferItem], []);
  assert.deepEqual(selection.directories, ["Footage", "Footage/Empty"]);
  assert.equal(selection.files[0].path, "Footage/clip.mp4");
  assert.equal(selection.files[0].file, file);
});
