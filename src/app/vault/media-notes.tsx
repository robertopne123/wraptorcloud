"use client";

import { useEffect, useState } from "react";

type Entry = { draft: string; saved: string; loaded: boolean; loading: boolean; saving: boolean; error: string | null };

export function MediaNotes({ fileId }: { fileId: string }) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [retry, setRetry] = useState(0);
  const entry = entries[fileId];

  function update(id: string, patch: Partial<Entry>) {
    setEntries((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  useEffect(() => {
    let cancelled = false;
    setEntries((current) => ({ ...current, [fileId]: current[fileId] ?? {
      draft: "", saved: "", loaded: false, loading: true, saving: false, error: null,
    } }));
    fetch(`/api/files/${fileId}/notes`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load notes");
        return response.json() as Promise<{ notes: string }>;
      })
      .then(({ notes }) => {
        if (cancelled) return;
        setEntries((current) => {
          const previous = current[fileId];
          return { ...current, [fileId]: { ...previous,
            draft: previous.draft !== previous.saved ? previous.draft : notes,
            saved: notes, loaded: true, loading: false, error: null,
          } };
        });
      })
      .catch(() => {
        if (!cancelled) update(fileId, { loading: false, error: "Could not load notes. Try again." });
      });
    return () => { cancelled = true; };
  }, [fileId, retry]);

  async function save() {
    if (!entry?.loaded || entry.saving) return;
    const draft = entry.draft;
    update(fileId, { saving: true, error: null });
    try {
      const response = await fetch(`/api/files/${fileId}/notes`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: draft }),
      });
      if (!response.ok) throw new Error("Could not save notes");
      update(fileId, { saved: draft, saving: false });
    } catch {
      update(fileId, { saving: false, error: "Could not save notes. Try again." });
    }
  }

  return (
    <div
      className="absolute inset-y-0 left-full z-10 flex w-[min(360px,45vw)] flex-col gap-3 border-l border-zinc-700 bg-zinc-900 p-3 text-white sm:p-5"
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <label htmlFor="media-notes" className="block text-sm font-medium">Notes</label>
      <textarea
        id="media-notes" value={entry?.draft ?? ""} maxLength={10000}
        disabled={!entry?.loaded || entry.loading}
        onChange={(event) => update(fileId, { draft: event.target.value })}
        placeholder={entry?.loading ? "Loading notes…" : "Add a note about this image or video…"}
        className="min-h-0 w-full flex-1 resize-none rounded border border-zinc-600 bg-zinc-800 p-2 text-sm focus:border-blue-400 focus:outline-none"
      />
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 text-xs">
        <span role="status">{entry?.error ?? (!entry || entry.loading ? "Loading…" : entry.saving ? "Saving…" : entry.draft !== entry.saved ? "Unsaved changes" : "Saved")}</span>
        <div className="flex flex-wrap gap-2">
          {entry?.error && <button type="button" onClick={() => setRetry((value) => value + 1)} className="rounded px-3 py-1.5 hover:bg-zinc-700">Retry loading</button>}
          <button type="button" onClick={save} disabled={!entry?.loaded || entry.loading || entry.saving || entry.draft === entry.saved} className="rounded bg-blue-600 px-3 py-1.5 font-medium disabled:opacity-50">Save notes</button>
        </div>
      </div>
    </div>
  );
}
