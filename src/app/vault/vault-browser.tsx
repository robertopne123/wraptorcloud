"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { FileRecord, Folder } from "@/lib/db/types";
import { FolderCard, FileCard } from "./item-card";
import { ConfirmModal, MoveModal, TextInputModal } from "./modals";
import { ShareModal } from "./share-modal";
import { Uploader } from "./uploader";
import { MediaViewer } from "./viewer";

type SelectionKey = `folder:${string}` | `file:${string}`;

type RenameTarget = { type: "folder" | "file"; id: string; name: string };
type MoveTarget = { type: "folder" | "file"; ids: string[] };
type DeleteTarget = { type: "folder" | "file"; ids: string[]; label: string };
type ShareTarget = { type: "folder" | "file"; id: string; name: string };

export function VaultBrowser({
  currentFolderId,
  initialFolders,
  initialFiles,
  initialBreadcrumb,
  initialFolderTree,
}: {
  currentFolderId: string | null;
  initialFolders: Folder[];
  initialFiles: FileRecord[];
  initialBreadcrumb: Folder[];
  initialFolderTree: Folder[];
}) {
  const router = useRouter();

  const [folders, setFolders] = useState(initialFolders);
  const [files, setFiles] = useState(initialFiles);
  const [folderTree, setFolderTree] = useState(initialFolderTree);
  const [selected, setSelected] = useState<Set<SelectionKey>>(new Set());

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [contentsRes, treeRes] = await Promise.all([
      fetch(`/api/folders?parentId=${currentFolderId ?? "null"}`),
      fetch("/api/folders/tree"),
    ]);
    const contents = await contentsRes.json();
    const tree = await treeRes.json();
    setFolders(contents.folders);
    setFiles(contents.files);
    setFolderTree(tree.folders);
    setSelected(new Set());
  }, [currentFolderId]);

  const navigateToFolder = useCallback(
    (folderId: string | null) => {
      router.push(folderId ? `/vault/${folderId}` : "/vault");
    },
    [router],
  );

  const toggleSelect = useCallback((key: SelectionKey) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  async function handleCreateFolder(name: string) {
    setNewFolderOpen(false);
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentId: currentFolderId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not create folder");
      return;
    }
    await refresh();
  }

  async function handleRename(name: string) {
    if (!renameTarget) return;
    const { type, id } = renameTarget;
    setRenameTarget(null);

    const res =
      type === "folder"
        ? await fetch(`/api/folders/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          })
        : await fetch(`/api/files/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName: name }),
          });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Rename failed");
      return;
    }
    await refresh();
  }

  async function handleMove(targetFolderId: string | null) {
    if (!moveTarget) return;
    const { type, ids } = moveTarget;
    setMoveTarget(null);

    const results = await Promise.all(
      ids.map((id) =>
        type === "folder"
          ? fetch(`/api/folders/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parentId: targetFolderId }),
            })
          : fetch(`/api/files/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ folderId: targetFolderId }),
            }),
      ),
    );

    const failed = results.find((res) => !res.ok);
    if (failed) {
      const body = await failed.json().catch(() => ({}));
      setError(body.error ?? "Move failed");
    }
    await refresh();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const { type, ids } = deleteTarget;
    setDeleteTarget(null);

    const results = await Promise.all(
      ids.map((id) =>
        fetch(type === "folder" ? `/api/folders/${id}` : `/api/files/${id}`, {
          method: "DELETE",
        }),
      ),
    );

    const failed = results.find((res) => !res.ok);
    if (failed) {
      const body = await failed.json().catch(() => ({}));
      setError(body.error ?? "Delete failed");
    }
    await refresh();
  }

  function handleFileOpen(file: FileRecord) {
    const index = files.findIndex((candidate) => candidate.id === file.id);
    if (index !== -1) setViewerIndex(index);
  }

  const selectedFolderIds = useMemo(
    () =>
      [...selected]
        .filter((key) => key.startsWith("folder:"))
        .map((key) => key.slice("folder:".length)),
    [selected],
  );
  const selectedFileIds = useMemo(
    () =>
      [...selected].filter((key) => key.startsWith("file:")).map((key) => key.slice("file:".length)),
    [selected],
  );

  // Folders currently selected can't be valid move targets for themselves.
  const moveExcludedIds = useMemo(() => new Set(selectedFolderIds), [selectedFolderIds]);

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 bg-zinc-50 px-4 py-8 dark:bg-black">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Wraptor Vault</h1>
        <Breadcrumb breadcrumb={initialBreadcrumb} onNavigate={navigateToFolder} />
      </div>

      <Uploader
        folderId={currentFolderId}
        onUploaded={(file) => setFiles((prev) => [file, ...prev])}
      />

      {error && (
        <div className="flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="font-medium">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setNewFolderOpen(true)}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          New folder
        </button>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">{selected.size} selected</span>
            <button
              type="button"
              onClick={() =>
                setMoveTarget({
                  type: selectedFolderIds.length > 0 ? "folder" : "file",
                  ids: [...selectedFolderIds, ...selectedFileIds],
                })
              }
              className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Move
            </button>
            <button
              type="button"
              onClick={() =>
                setDeleteTarget({
                  type: selectedFolderIds.length > 0 ? "folder" : "file",
                  ids: [...selectedFolderIds, ...selectedFileIds],
                  label: `${selected.size} item${selected.size > 1 ? "s" : ""}`,
                })
              }
              className="rounded-md border border-red-300 px-3 py-1.5 font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-zinc-500 hover:underline dark:text-zinc-400"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {folders.length === 0 && files.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">This folder is empty.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {folders.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              selected={selected.has(`folder:${folder.id}`)}
              onToggleSelect={() => toggleSelect(`folder:${folder.id}`)}
              onOpen={() => navigateToFolder(folder.id)}
              onShare={() => setShareTarget({ type: "folder", id: folder.id, name: folder.name })}
              onRename={() => setRenameTarget({ type: "folder", id: folder.id, name: folder.name })}
              onMove={() => setMoveTarget({ type: "folder", ids: [folder.id] })}
              onDelete={() =>
                setDeleteTarget({ type: "folder", ids: [folder.id], label: `"${folder.name}"` })
              }
            />
          ))}
          {files.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              selected={selected.has(`file:${file.id}`)}
              onToggleSelect={() => toggleSelect(`file:${file.id}`)}
              onOpen={() => handleFileOpen(file)}
              onShare={() =>
                setShareTarget({ type: "file", id: file.id, name: file.display_name })
              }
              onRename={() =>
                setRenameTarget({ type: "file", id: file.id, name: file.display_name })
              }
              onMove={() => setMoveTarget({ type: "file", ids: [file.id] })}
              onDelete={() =>
                setDeleteTarget({ type: "file", ids: [file.id], label: `"${file.display_name}"` })
              }
            />
          ))}
        </div>
      )}

      {viewerIndex !== null && (
        <MediaViewer
          files={files}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
        />
      )}

      {newFolderOpen && (
        <TextInputModal
          title="New folder"
          label="Folder name"
          confirmLabel="Create"
          onSubmit={handleCreateFolder}
          onClose={() => setNewFolderOpen(false)}
        />
      )}

      {renameTarget && (
        <TextInputModal
          title={`Rename ${renameTarget.type}`}
          label="Name"
          initialValue={renameTarget.name}
          confirmLabel="Rename"
          onSubmit={handleRename}
          onClose={() => setRenameTarget(null)}
        />
      )}

      {moveTarget && (
        <MoveModal
          folderTree={folderTree}
          excludedIds={moveExcludedIds}
          onSubmit={handleMove}
          onClose={() => setMoveTarget(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title={`Delete ${deleteTarget.label}?`}
          description={
            deleteTarget.type === "folder"
              ? "This permanently deletes the folder and everything inside it, including subfolders and files. This cannot be undone."
              : "This removes the file from Wraptor Vault. This cannot be undone."
          }
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {shareTarget && <ShareModal target={shareTarget} onClose={() => setShareTarget(null)} />}
    </div>
  );
}

function Breadcrumb({
  breadcrumb,
  onNavigate,
}: {
  breadcrumb: Folder[];
  onNavigate: (folderId: string | null) => void;
}) {
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
      <button type="button" onClick={() => onNavigate(null)} className="hover:underline">
        Root
      </button>
      {breadcrumb.map((folder, index) => {
        const isLast = index === breadcrumb.length - 1;
        return (
          <span key={folder.id} className="flex items-center gap-1">
            <span>/</span>
            {isLast ? (
              <span className="font-medium text-zinc-800 dark:text-zinc-200">{folder.name}</span>
            ) : (
              <button type="button" onClick={() => onNavigate(folder.id)} className="hover:underline">
                {folder.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
