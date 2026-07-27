"use client";

import { useEffect, useState } from "react";
import type { ShareLink, SharePermission } from "@/lib/db/types";
import { Overlay } from "./modals";

type ExpiryOption = "never" | "1" | "7" | "30";

type ShareTarget = { type: "file" | "folder"; id: string; name: string };

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "Never expires";
  const date = new Date(expiresAt);
  return date < new Date() ? "Expired" : `Expires ${date.toLocaleDateString()}`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function ShareLinkRow({ link, onRevoke }: { link: ShareLink; onRevoke: () => void }) {
  const url = `${window.location.origin}/share/${link.token}`;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={(event) => event.target.select()}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
        />
        <CopyButton text={url} />
      </div>
      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>
          {link.permission === "download" ? "View + Download" : "View only"} ·{" "}
          {formatExpiry(link.expires_at)}
        </span>
        <button
          type="button"
          onClick={onRevoke}
          className="font-medium text-red-600 hover:underline dark:text-red-400"
        >
          Revoke
        </button>
      </div>
    </div>
  );
}

export function ShareModal({
  target,
  onClose,
}: {
  target: ShareTarget;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [permission, setPermission] = useState<SharePermission>("view");
  const [expiry, setExpiry] = useState<ExpiryOption>("never");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = target.type === "file" ? `fileId=${target.id}` : `folderId=${target.id}`;
    fetch(`/api/share-links?${query}`)
      .then((res) => res.json())
      .then((data) => setLinks(data.shareLinks ?? []))
      .catch(() => setLinks([]));
  }, [target.type, target.id]);

  async function handleGenerate() {
    setIsGenerating(true);
    setError(null);

    const res = await fetch("/api/share-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: target.type === "file" ? target.id : null,
        folderId: target.type === "folder" ? target.id : null,
        permission,
        expiresInDays: expiry === "never" ? null : Number(expiry),
      }),
    });

    setIsGenerating(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not generate link");
      return;
    }

    const body = await res.json();
    setLinks((prev) => [body.shareLink, ...(prev ?? [])]);
  }

  async function handleRevoke(token: string) {
    const res = await fetch(`/api/share-links/${token}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Could not revoke link");
      return;
    }
    setLinks((prev) => (prev ?? []).filter((link) => link.token !== token));
  }

  return (
    <Overlay onClose={onClose}>
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Share &ldquo;{target.name}&rdquo;
        </h2>

        {links === null ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
        ) : links.length > 0 ? (
          <div className="flex flex-col gap-2">
            {links.map((link) => (
              <ShareLinkRow key={link.id} link={link} onRevoke={() => handleRevoke(link.token)} />
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Permission
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPermission("view")}
                className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${
                  permission === "view"
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                }`}
              >
                View only
              </button>
              <button
                type="button"
                onClick={() => setPermission("download")}
                className={`flex-1 rounded-md border px-3 py-1.5 text-sm ${
                  permission === "download"
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                }`}
              >
                View + Download
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Expiry
            </label>
            <select
              value={expiry}
              onChange={(event) => setExpiry(event.target.value as ExpiryOption)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              <option value="never">Never</option>
              <option value="1">24 hours</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </select>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {isGenerating ? "Generating…" : "Generate link"}
          </button>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}
