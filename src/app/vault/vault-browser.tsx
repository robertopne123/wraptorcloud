"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { VaultWorkspaceContext } from "./vault-workspace-context";
import { useRouter } from "next/navigation";
import type { FileRecord, Folder } from "@/lib/db/types";
import { FolderCard, FileCard } from "./item-card";
import { ConfirmModal, MoveModal, TextInputModal } from "./modals";
import { ShareModal } from "./share-modal";
import { MediaViewer } from "./viewer";
import { FilePreview } from "./file-preview";
import { useZipDownload } from "./transfer-panel";
import { isZipDownloadActive, zipDownload } from "@/lib/zip-download";
import { VersionsModal } from "./versions-modal";

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
  onNavigate,
  onOpenTab,
  headerHost,
  showHeader = true,
  splitView = false,
  folderName,
  gridStatus,
}: {
  currentFolderId: string | null;
  initialFolders: Folder[];
  initialFiles: FileRecord[];
  initialBreadcrumb: Folder[];
  initialFolderTree: Folder[];
  onNavigate?: (folderId: string | null) => void;
  onOpenTab?: (folderId: string | null, name: string) => void;
  headerHost?: HTMLElement | null;
  showHeader?: boolean;
  splitView?: boolean;
  folderName?: string;
  gridStatus?: ReactNode;
}) {
  const router = useRouter();

  const [folders, setFolders] = useState(initialFolders);
  const [files, setFiles] = useState(initialFiles);
  const [folderTree, setFolderTree] = useState(initialFolderTree);
  const [contentsSource, setContentsSource] = useState(initialFiles);
  // Keep the pane mounted while its asynchronous initial contents arrive.
  if (contentsSource !== initialFiles) {
    setContentsSource(initialFiles);
    setFolders(initialFolders);
    setFiles(initialFiles);
    setFolderTree(initialFolderTree);
  }
  const [selected, setSelected] = useState<Set<SelectionKey>>(new Set());

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [previewTarget, setPreviewTarget] = useState<FileRecord | null>(null);
  const [versionsTarget, setVersionsTarget] = useState<FileRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const downloading = isZipDownloadActive(useZipDownload());
  const [search, setSearch] = useState("");
  const workspace = useContext(VaultWorkspaceContext);
  const localDragItems = useRef<SelectionKey[]>([]);
  const localMovePending = useRef(false);
  const dragItems = workspace?.dragItems ?? localDragItems;
  const movePending = workspace?.movePending ?? localMovePending;
  const [moving, setMoving] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  function dragSource(key: SelectionKey): HTMLAttributes<HTMLDivElement> {
    return {
      draggable: !moving,
      onDragStart: (event) => {
        if (movePending.current) { event.preventDefault(); return; }
        dragItems.current = selected.has(key) ? [...selected] : [key];
        if (workspace) workspace.sourceFolder.current = currentFolderId;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-wraptor-vault-items", JSON.stringify(dragItems.current));
        event.dataTransfer.setDragImage(event.currentTarget, 30, 30);
      },
      onDragEnd: () => { dragItems.current = []; setDropTarget(null); },
    };
  }

  function canDrop(folderId: string | null) {
    if (movePending.current || !dragItems.current.length || folderId === (workspace ? workspace.sourceFolder.current : currentFolderId)) return false;
    const draggedFolders = new Set(dragItems.current.filter((key) => key.startsWith("folder:")).map((key) => key.slice(7)));
    let ancestor = folderId;
    const visited = new Set<string>();
    while (ancestor !== null) {
      if (draggedFolders.has(ancestor) || visited.has(ancestor)) return false;
      visited.add(ancestor);
      ancestor = folderTree.find((folder) => folder.id === ancestor)?.parent_id ?? null;
    }
    return true;
  }

  function dropDestination(folderId: string | null): HTMLAttributes<HTMLElement> {
    const target = folderId ?? "root";
    function dragOver(event: DragEvent<HTMLElement>) {
      if (!dragItems.current.length) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = canDrop(folderId) ? "move" : "none";
      setDropTarget(canDrop(folderId) ? target : null);
    }
    return {
      onDragEnter: dragOver,
      onDragOver: dragOver,
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
      },
      onDrop: (event) => {
        if (!dragItems.current.length) return;
        event.preventDefault();
        event.stopPropagation();
        const items = [...dragItems.current];
        const allowed = canDrop(folderId);
        dragItems.current = [];
        setDropTarget(null);
        if (allowed) void moveItems(items, folderId);
      },
      className: dropTarget === target ? "rounded-lg ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-950/50" : undefined,
    };
  }

  async function moveItems(items: SelectionKey[], targetFolderId: string | null) {
    if (movePending.current) return;
    movePending.current = true;
    setMoving(true);
    setError(null);
    try {
      const results = await Promise.allSettled(items.map(async (key) => {
        const [type, id] = key.split(":");
        const response = await fetch(`/api/${type === "folder" ? "folders" : "files"}/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(type === "folder" ? { parentId: targetFolderId } : { folderId: targetFolderId }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? "Could not move item");
        }
      }));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") setError(failed.reason instanceof Error ? failed.reason.message : "Move failed. Please try again.");
      await refresh();
    } catch {
      setError("Could not refresh after moving. Please reload to check your items.");
    } finally {
      movePending.current = false;
      setMoving(false);
      workspace?.changed();
    }
  }

  const refresh = useCallback(async () => {
    const [contentsRes, treeRes] = await Promise.all([
      fetch(`/api/folders?parentId=${currentFolderId ?? "null"}`),
      fetch("/api/folders/tree"),
    ]);
    const contents = await contentsRes.json();
    const tree = await treeRes.json();
    if (!contentsRes.ok || !treeRes.ok) throw new Error("Could not refresh folder");
    setFolders(contents.folders);
    setFiles(contents.files);
    setFolderTree(tree.folders);
    setSelected(new Set());
  }, [currentFolderId]);

  const lastRevision = useRef(workspace?.revision);
  useEffect(() => {
    if (lastRevision.current === workspace?.revision) return;
    lastRevision.current = workspace?.revision;
    void refresh().catch(() => setError("Could not refresh folder. Please reload."));
  }, [workspace?.revision, refresh]);

  const navigateToFolder = useCallback(
    (folderId: string | null) => {
      if (onNavigate) { onNavigate(folderId); return; }
      router.push(folderId ? `/vault/${folderId}` : "/vault");
    },
    [router, onNavigate],
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

  // Downloads a single file via presigned URL (no server-side zip needed).
  const handleDownloadFile = useCallback(async (fileId: string) => {
    const res = await fetch(`/api/files/${fileId}/view-url?disposition=attachment`);
    if (!res.ok) { setError("Download failed"); return; }
    const { url } = await res.json();
    triggerAnchorDownload(url);
  }, []);

  // Downloads one or more files/folders as a ZIP streamed from the server.
  const handleDownloadZip = useCallback(
    (fileIds: string[], folderIds: string[]) => { void zipDownload.start(fileIds, folderIds); },
    [],
  );

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

  const mediaFiles = useMemo(
    () => files.filter((f) => f.media_type === "video" || f.media_type === "image"),
    [files],
  );

  function handleFileOpen(file: FileRecord) {
    if (file.media_type === "other") {
      setPreviewTarget(file);
      return;
    }
    const index = mediaFiles.findIndex((candidate) => candidate.id === file.id);
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
      [...selected]
        .filter((key) => key.startsWith("file:"))
        .map((key) => key.slice("file:".length)),
    [selected],
  );

  const moveExcludedIds = useMemo(() => new Set(selectedFolderIds), [selectedFolderIds]);

  const query = search.trim().toLowerCase();
  const visibleFolders = query ? folders.filter((f) => f.name.toLowerCase().includes(query)) : folders;
  const visibleFiles = query ? files.filter((f) => f.display_name.toLowerCase().includes(query)) : files;

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50 dark:bg-black">
      {/* ── fixed header ── */}
      <VaultHeader host={headerHost} visible={showHeader}>
      <div className="flex-none border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="mb-3">
          <div className="flex items-center gap-2">
            {(currentFolderId !== null || initialBreadcrumb.length > 0) && (
              <button
                type="button"
                onClick={() => navigateToFolder(initialBreadcrumb.length > 1 ? initialBreadcrumb[initialBreadcrumb.length - 2].id : null)}
                className="flex items-center justify-center rounded-md p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                aria-label="Go back"
              >
                <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5">
                  <path d="M12 5L7 10l5 5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{folderName ?? initialBreadcrumb.at(-1)?.name ?? "Vault root"}</span>
          </div>
          <Breadcrumb breadcrumb={initialBreadcrumb} onNavigate={navigateToFolder} dropDestination={dropDestination} />
        </div>

        <div className="mb-3 relative">
          <svg viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Search files and folders…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white py-1.5 pl-8 pr-3 text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:ring-zinc-600"
          />
        </div>

        {error && (
          <div className="mt-3 flex items-center justify-between rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="font-medium">
              Dismiss
            </button>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between">
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
                disabled={downloading}
                onClick={() => handleDownloadZip(selectedFileIds, selectedFolderIds)}
                className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                {downloading ? "Zipping…" : "Download ZIP"}
              </button>
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
      </div>

      {/* ── scrollable grid ── */}
      </VaultHeader>
      {splitView && <div className="flex-none border-b border-zinc-200 px-6 py-2 dark:border-zinc-800"><Breadcrumb breadcrumb={initialBreadcrumb} onNavigate={navigateToFolder} dropDestination={dropDestination} /></div>}
      <div {...dropDestination(currentFolderId)} className={`flex-1 overflow-y-auto px-6 py-4 ${dropTarget === (currentFolderId ?? "root") ? "ring-2 ring-inset ring-blue-500" : ""}`}>
        <p role="status" className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {moving ? "Moving items…" : "Drag files or folders into a folder, or onto a breadcrumb to move them. Selected items move together."}
        </p>
        {gridStatus ? gridStatus : visibleFolders.length === 0 && visibleFiles.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {query ? `No results for "${search}"` : "This folder is empty."}
          </p>
        ) : (
          <div className={`grid gap-3 ${splitView ? "grid-cols-2 md:grid-cols-3 xl:grid-cols-4" : "grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-9"}`}>
            {visibleFolders.map((folder) => (
              <div key={folder.id} {...dragSource(`folder:${folder.id}`)} {...dropDestination(folder.id)}>
              <FolderCard
                key={folder.id}
                folder={folder}
                selected={selected.has(`folder:${folder.id}`)}
                onToggleSelect={() => toggleSelect(`folder:${folder.id}`)}
                onOpen={() => navigateToFolder(folder.id)}
                onOpenTab={onOpenTab ? () => onOpenTab(folder.id, folder.name) : undefined}
                onDownload={() => handleDownloadZip([], [folder.id])}
                onShare={() =>
                  setShareTarget({ type: "folder", id: folder.id, name: folder.name })
                }
                onRename={() =>
                  setRenameTarget({ type: "folder", id: folder.id, name: folder.name })
                }
                onMove={() => setMoveTarget({ type: "folder", ids: [folder.id] })}
                onDelete={() =>
                  setDeleteTarget({ type: "folder", ids: [folder.id], label: `"${folder.name}"` })
                }
              />
              </div>
            ))}
            {visibleFiles.map((file) => (
              <div key={file.id} {...dragSource(`file:${file.id}`)}>
              <FileCard
                key={file.id}
                file={file}
                selected={selected.has(`file:${file.id}`)}
                onToggleSelect={() => toggleSelect(`file:${file.id}`)}
                onOpen={() => handleFileOpen(file)}
                onDownload={() => handleDownloadFile(file.id)}
                onVersions={() => setVersionsTarget(file)}
                onShare={() =>
                  setShareTarget({ type: "file", id: file.id, name: file.display_name })
                }
                onRename={() =>
                  setRenameTarget({ type: "file", id: file.id, name: file.display_name })
                }
                onMove={() => setMoveTarget({ type: "file", ids: [file.id] })}
                onDelete={() =>
                  setDeleteTarget({
                    type: "file",
                    ids: [file.id],
                    label: `"${file.display_name}"`,
                  })
                }
              />
              </div>
            ))}
          </div>
        )}
      </div>

      {viewerIndex !== null && (
        <MediaViewer
          files={mediaFiles}
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
      {versionsTarget && <VersionsModal file={versionsTarget} onClose={() => setVersionsTarget(null)} />}
      {previewTarget && <FilePreview key={previewTarget.id} file={previewTarget} onClose={() => setPreviewTarget(null)}
        folderTree={folderTree} destinationId={currentFolderId} onExtracted={() => { void refresh(); }} />}

    </div>
  );
}

function VaultHeader({ host, visible, children }: { host?: HTMLElement | null; visible: boolean; children: ReactNode }) {
  if (!visible) return null;
  return host ? createPortal(children, host) : children;
}

function triggerAnchorDownload(url: string, filename?: string) {
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function Breadcrumb({
  breadcrumb,
  onNavigate,
  dropDestination,
}: {
  breadcrumb: Folder[];
  onNavigate: (folderId: string | null) => void;
  dropDestination: (folderId: string | null) => HTMLAttributes<HTMLElement>;
}) {
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
      <button type="button" onClick={() => onNavigate(null)} {...dropDestination(null)}>
        Root
      </button>
      {breadcrumb.map((folder, index) => {
        const isLast = index === breadcrumb.length - 1;
        return (
          <span key={folder.id} {...dropDestination(folder.id)}>
            <span>/</span>
            {isLast ? (
              <span className="font-medium text-zinc-800 dark:text-zinc-200">{folder.name}</span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(folder.id)}
                className="hover:underline"
              >
                {folder.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
