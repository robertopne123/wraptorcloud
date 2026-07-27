"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { Folder } from "@/lib/db/types";

function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-5 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
      >
        {children}
      </div>
    </div>
  );
}

export function TextInputModal({
  title,
  label,
  initialValue = "",
  confirmLabel = "Save",
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  }

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            {label}
          </label>
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Overlay>
  );
}

export function ConfirmModal({
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Overlay onClose={onClose}>
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

type FolderOption = Folder & { depth: number };

function buildFolderOptions(tree: Folder[], excludedIds: Set<string>): FolderOption[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const folder of tree) {
    const key = folder.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(folder);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  const result: FolderOption[] = [];
  function walk(parentId: string | null, depth: number) {
    for (const folder of byParent.get(parentId) ?? []) {
      if (excludedIds.has(folder.id)) continue;
      result.push({ ...folder, depth });
      walk(folder.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}

export function MoveModal({
  folderTree,
  excludedIds,
  onSubmit,
  onClose,
}: {
  folderTree: Folder[];
  excludedIds: Set<string>;
  onSubmit: (targetFolderId: string | null) => void;
  onClose: () => void;
}) {
  const options = buildFolderOptions(folderTree, excludedIds);

  return (
    <Overlay onClose={onClose}>
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Move to…</h2>
        <div className="max-h-72 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => onSubmit(null)}
            className="block w-full px-3 py-2 text-left text-sm text-zinc-800 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Root
          </button>
          {options.map((folder) => (
            <button
              key={folder.id}
              type="button"
              onClick={() => onSubmit(folder.id)}
              style={{ paddingLeft: `${12 + folder.depth * 16}px` }}
              className="block w-full py-2 pr-3 text-left text-sm text-zinc-800 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              {folder.name}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
        </div>
      </div>
    </Overlay>
  );
}
