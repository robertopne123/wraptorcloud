import type { Folder } from "../db/types";

export type SelectedFile = { file: File; path: string };
export type UploadSelection = { files: SelectedFile[]; directories: string[] };
export type UploadDestination = { folderId: string | null; folderName: string };

// Directory readers return batches, so keep reading until the empty batch.
export async function readDroppedItems(items: DataTransferItem[], fallback: File[]): Promise<UploadSelection> {
  const selection: UploadSelection = { files: [], directories: [] };
  const entries = items.filter((item) => item.kind === "file").map((item) => ({
    entry: item.webkitGetAsEntry?.(), file: item.getAsFile(),
  }));
  async function visit(entry: FileSystemEntry, parent = ""): Promise<void> {
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      selection.files.push({ file, path });
    } else if (entry.isDirectory) {
      selection.directories.push(path);
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        for (const child of children) await visit(child, path);
      }
    }
  }
  if (!entries.length) {
    selection.files = fallback.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  } else {
    for (const { entry, file } of entries) {
      if (entry) await visit(entry);
      else if (file) selection.files.push({ file, path: file.webkitRelativePath || file.name });
    }
  }
  return selection;
}

export async function prepareUploadFolders(
  selection: UploadSelection,
  destination: UploadDestination,
  request: (path: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<UploadDestination[]> {
  const paths = new Map<string, UploadDestination>([["", destination]]);
  const children = new Map<string | null, Folder[]>();
  async function ensure(path: string): Promise<UploadDestination> {
    const existing = paths.get(path);
    if (existing) return existing;
    const parts = path.split("/");
    if (parts.some((part) => !part.trim() || part === "." || part === "..")) {
      throw new Error("Invalid upload folder path");
    }
    const name = parts.pop()!;
    const parent = await ensure(parts.join("/"));
    let siblings = children.get(parent.folderId);
    if (!siblings) {
      const response = await request(`/api/folders?parentId=${encodeURIComponent(parent.folderId ?? "null")}`);
      if (!response.ok) throw new Error("Could not read destination folders. Please try again.");
      siblings = ((await response.json()) as { folders: Folder[] }).folders;
      children.set(parent.folderId, siblings);
    }
    let folder = siblings.find((folder) => folder.name === name.trim());
    if (!folder) {
      const response = await request("/api/folders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentId: parent.folderId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create upload folder. Please try again.");
      folder = data.folder as Folder;
      siblings.push(folder);
    }
    const result = { folderId: folder.id, folderName: `${parent.folderName}/${folder.name}` };
    paths.set(path, result);
    return result;
  }
  for (const directory of selection.directories) await ensure(directory);
  const destinations: UploadDestination[] = [];
  for (const { path } of selection.files) {
    destinations.push(await ensure(path.split("/").slice(0, -1).join("/")));
  }
  return destinations;
}
