"use client";

import { useEffect, useRef, useState } from "react";

type WorkerSlot = { file: string; folder: string | null; pct: number };

type MigrationRun = {
  id: string;
  status: "running" | "done" | "error";
  total: number;
  processed: number;
  migrated: number;
  skipped: number;
  failed: number;
  current_file: string | null;
  current_folder: string | null;
  workers: WorkerSlot[];
  started_at: string;
  updated_at: string;
  finished_at: string | null;
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function eta(run: MigrationRun): string {
  if (run.processed === 0) return "estimating…";
  const elapsed = Date.now() - new Date(run.started_at).getTime();
  const msPerFile = elapsed / run.processed;
  const remaining = (run.total - run.processed) * msPerFile;
  return `~${formatDuration(remaining)} left`;
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-700">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function MigrationProgress() {
  const [run, setRun] = useState<MigrationRun | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunId = useRef<string | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/migration/stream");

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data) as
        | { type: "idle" }
        | { type: "progress"; run: MigrationRun };

      if (msg.type === "idle") return;

      const incoming = msg.run;

      // New run started — reset dismissed state
      if (incoming.id !== lastRunId.current) {
        lastRunId.current = incoming.id;
        setDismissed(false);
        setMinimised(false);
        if (dismissTimer.current) clearTimeout(dismissTimer.current);
      }

      setRun(incoming);

      // Auto-dismiss 8 seconds after completion
      if (incoming.status === "done" || incoming.status === "error") {
        if (dismissTimer.current) clearTimeout(dismissTimer.current);
        dismissTimer.current = setTimeout(() => setDismissed(true), 8000);
      }
    };

    return () => es.close();
  }, []);

  if (!run || dismissed) return null;
  if (run.status === "done" && dismissed) return null;

  const isScanning = run.total === 0;
  const pct = run.total > 0 ? ((run.processed / run.total) * 100).toFixed(1) : "0.0";
  const isDone = run.status === "done";
  const isError = run.status === "error";

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          {!isDone && !isError && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />
          )}
          {isDone && <span className="inline-block h-2 w-2 rounded-full bg-green-400" />}
          {isError && <span className="inline-block h-2 w-2 rounded-full bg-red-400" />}
          <span className="text-sm font-medium text-zinc-100">
            {isDone ? "Migration complete" : isError ? "Migration finished with errors" : isScanning ? "Scanning Drive folder…" : "Migrating from Drive"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMinimised((v) => !v)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label={minimised ? "Expand" : "Minimise"}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
              {minimised
                ? <path d="M3 8h10M8 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                : <path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Dismiss"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
              <path d="M3 3l10 10M13 3 3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {!minimised && (
        <div className="border-t border-zinc-800 px-4 pb-4 pt-3 space-y-3">
          {/* Progress bar */}
          <div className="space-y-1.5">
            <ProgressBar
              value={run.processed}
              max={run.total}
              color={isDone ? "bg-green-500" : isError ? "bg-amber-500" : "bg-blue-500"}
            />
            <div className="flex justify-between text-xs text-zinc-400">
              {isScanning
                ? <span>Scanning folder tree…</span>
                : <span>{pct}% — {run.processed.toLocaleString()} / {run.total.toLocaleString()} files</span>}
              {!isDone && !isError && !isScanning && <span>{eta(run)}</span>}
            </div>
          </div>

          {/* Per-worker upload rows */}
          {!isDone && run.workers.length > 0 && (
            <div className="space-y-1.5">
              {run.workers.map((w, i) => (
                <div key={i} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs text-zinc-300 min-w-0">{w.file}</p>
                    <span className="shrink-0 tabular-nums text-xs text-zinc-500">
                      {w.pct > 0 ? `${w.pct}%` : "…"}
                    </span>
                  </div>
                  {w.folder && (
                    <p className="truncate text-xs text-zinc-600">{w.folder}</p>
                  )}
                  {w.pct > 0
                    ? <ProgressBar value={w.pct} max={100} color="bg-blue-600" />
                    : <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-700"><div className="h-full w-1/3 animate-[slide_1.5s_ease-in-out_infinite] rounded-full bg-blue-600" /></div>
                  }
                </div>
              ))}
            </div>
          )}

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Uploaded" value={run.migrated} color="text-green-400" />
            <Stat label="Skipped" value={run.skipped} color="text-zinc-400" />
            <Stat label="Failed" value={run.failed} color={run.failed > 0 ? "text-red-400" : "text-zinc-400"} />
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg bg-zinc-800 px-2 py-1.5">
      <p className={`text-sm font-semibold tabular-nums ${color}`}>{value.toLocaleString()}</p>
      <p className="text-xs text-zinc-500">{label}</p>
    </div>
  );
}
