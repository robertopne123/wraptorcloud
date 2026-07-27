"use client";

import { useEffect, useRef, useState } from "react";
import { DotsIcon } from "./icons";

export function ItemMenu({
  onShare,
  onRename,
  onMove,
  onDelete,
}: {
  onShare: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className="rounded-md p-1 text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
        aria-label="Item actions"
      >
        <DotsIcon className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-1 w-32 overflow-hidden rounded-md border border-zinc-200 bg-white text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onShare();
            }}
            className="block w-full px-3 py-2 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Share
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onRename();
            }}
            className="block w-full px-3 py-2 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onMove();
            }}
            className="block w-full px-3 py-2 text-left text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Move
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onDelete();
            }}
            className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
