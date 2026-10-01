"use client";

import { useEffect, useRef, useState } from "react";
import type { FileRecord, Folder } from "@/lib/db/types";
import { VaultBrowser } from "./vault-browser";
import { Uploader } from "./uploader";
import { VaultWorkspaceContext, type VaultSelectionKey } from "./vault-workspace-context";

type Contents = { initialFolders: Folder[]; initialFiles: FileRecord[]; initialBreadcrumb: Folder[]; initialFolderTree: Folder[] };
type Tab = { id: string; folderId: string | null; name: string; initial?: Contents };
const emptyContents: Contents = { initialFolders: [], initialFiles: [], initialBreadcrumb: [], initialFolderTree: [] };

export function VaultWorkspace(props: Contents & { currentFolderId: string | null }) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: "initial", folderId: props.currentFolderId, name: props.initialBreadcrumb.at(-1)?.name ?? "Vault root", initial: props }]);
  const [active, setActive] = useState("initial");
  const [split, setSplit] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const activeTab = tabs.find((tab) => tab.id === active)!;
  const dragItems = useRef<VaultSelectionKey[]>([]);
  const sourceFolder = useRef<string | null>(null);
  const movePending = useRef(false);
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelHover() { if (hover.current) clearTimeout(hover.current); hover.current = null; }
  useEffect(() => () => { if (hover.current) clearTimeout(hover.current); }, []);

  function openTab(folderId: string | null, name = "Vault root") {
    const id = crypto.randomUUID();
    setTabs((previous) => [...previous, { id, folderId, name }]);
    setActive(id);
  }
  function activate(id: string) {
    if (id === split) setSplit(active);
    setActive(id);
  }
  function closeTab(id: string) {
    cancelHover();
    if (tabs.length === 1) { openTab(null); }
    else if (active === id) setActive(tabs.find((tab) => tab.id !== id && tab.id !== split)?.id ?? tabs.find((tab) => tab.id !== id)!.id);
    if (split === id || (active === id && tabs.length === 2)) setSplit(null);
    setTabs((previous) => previous.filter((tab) => tab.id !== id));
  }

  return <VaultWorkspaceContext.Provider value={{ dragItems, sourceFolder, movePending, revision, changed: () => setRevision((value) => value + 1) }}>
    <div className="flex h-screen flex-col bg-zinc-50 dark:bg-black" onDragEnd={() => { cancelHover(); dragItems.current = []; }}>
      <header className="flex-none px-6 pt-4">
        <h1 className="mb-3 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Wraptor Vault</h1>
        <Uploader
          folderId={activeTab.folderId}
          folderName={activeTab.name}
          onUploaded={() => setRevision((value) => value + 1)}
          onFoldersCreated={() => setRevision((value) => value + 1)}
        />
      </header>
      <div ref={setHeaderHost} className="flex-none" />
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <div role="tablist" aria-label="Folder tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((tab) => <div key={tab.id} className={`flex shrink-0 items-center rounded-md border ${active === tab.id || split === tab.id ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-zinc-300 dark:border-zinc-700"}`}>
            <button role="tab" id={`tab-${tab.id}`} aria-controls={`pane-${tab.id}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} type="button" className="max-w-48 truncate px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200"
              onClick={() => activate(tab.id)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = tabs.findIndex((candidate) => candidate.id === tab.id);
                const next = tabs[event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
                activate(next.id); document.getElementById(`tab-${next.id}`)?.focus();
              }}
              onDragEnter={() => { if (!dragItems.current.length) return; cancelHover(); hover.current = setTimeout(() => { activate(tab.id); hover.current = null; }, 450); }}
              onDragOver={(event) => { if (dragItems.current.length) { event.preventDefault(); event.dataTransfer.dropEffect = "none"; } }}
              onDragLeave={cancelHover}
              onDrop={(event) => { event.preventDefault(); cancelHover(); }}
            >{tab.name}{split === tab.id ? " · Split" : ""}</button>
            <button type="button" aria-label={`Open ${tab.name} in split view`} title="Open in split view" onClick={() => {
              if (tab.id !== active) setSplit(tab.id);
              else { const id = crypto.randomUUID(); setTabs((previous) => [...previous, { id, folderId: tab.folderId, name: tab.name }]); setSplit(id); }
            }} className="px-2 text-zinc-500">◫</button>
            <button type="button" aria-label={`Close ${tab.name} tab`} onClick={() => closeTab(tab.id)} className="px-2 text-zinc-500">×</button>
          </div>)}
        </div>
        <button type="button" onClick={() => openTab(null)} className="shrink-0 rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:text-zinc-200">+ New tab</button>
        {split && <button type="button" onClick={() => setSplit(null)} className="shrink-0 px-2 text-sm text-zinc-500">Exit split</button>}
      </div>
      <div className="flex min-h-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => <div key={tab.id} id={`pane-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} hidden={tab.id !== active && tab.id !== split}
          onPointerDownCapture={() => { if (tab.id !== active) activate(tab.id); }}
          className={`${tab.id === active || tab.id === split ? "flex" : "hidden"} min-w-0 flex-1 flex-col border-r border-zinc-200 dark:border-zinc-800 ${split ? "min-w-[360px]" : ""}`}>
          <FolderPane tab={tab} headerHost={headerHost} showHeader={tab.id === active} splitView={split !== null} onNavigate={(folderId, name) => setTabs((previous) => previous.map((candidate) => candidate.id === tab.id ? { ...candidate, folderId, name, initial: undefined } : candidate))} onOpenTab={openTab} />
        </div>)}
      </div>
    </div>
  </VaultWorkspaceContext.Provider>;
}

function FolderPane({ tab, onNavigate, onOpenTab, headerHost, showHeader, splitView }: { tab: Tab; onNavigate: (id: string | null, name: string) => void; onOpenTab: (id: string | null, name: string) => void; headerHost: HTMLDivElement | null; showHeader: boolean; splitView: boolean }) {
  const [loaded, setLoaded] = useState<{ folderId: string | null; contents: Contents } | null>(tab.initial ? { folderId: tab.folderId, contents: tab.initial } : null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (tab.initial) return;
    const controller = new AbortController();
    Promise.all([fetch(`/api/folders?parentId=${tab.folderId ?? "null"}`, { signal: controller.signal }), fetch("/api/folders/tree", { signal: controller.signal })])
      .then(async ([contentsResponse, treeResponse]) => {
        if (!contentsResponse.ok || !treeResponse.ok) throw new Error("Could not load folder");
        const [contents, tree] = await Promise.all([contentsResponse.json(), treeResponse.json()]);
        const breadcrumb: Folder[] = []; const visited = new Set<string>();
        let id = tab.folderId;
        while (id && !visited.has(id)) { visited.add(id); const folder = (tree.folders as Folder[]).find((candidate) => candidate.id === id); if (!folder) throw new Error("This folder no longer exists"); breadcrumb.unshift(folder); id = folder.parent_id; }
        if (!controller.signal.aborted) { setError(null); setLoaded({ folderId: tab.folderId, contents: { initialFolders: contents.folders, initialFiles: contents.files, initialFolderTree: tree.folders, initialBreadcrumb: breadcrumb } }); }
      }).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load folder"); });
    return () => controller.abort();
  }, [tab.folderId, tab.initial, retry]);
  const contents = loaded?.folderId === tab.folderId ? loaded.contents : emptyContents;
  const gridStatus = error
    ? <div role="alert" className="text-red-600">{error} <button onClick={() => { setError(null); setRetry((value) => value + 1); }}>Retry</button> <button onClick={() => onNavigate(null, "Vault root")}>Go to root</button></div>
    : !loaded || loaded.folderId !== tab.folderId ? <p role="status" className="text-zinc-500">Loading folder…</p> : undefined;
  return <VaultBrowser key={tab.folderId ?? "root"} currentFolderId={tab.folderId} {...contents} folderName={tab.name} gridStatus={gridStatus} headerHost={headerHost} showHeader={showHeader} splitView={splitView} onNavigate={(id) => onNavigate(id, contents.initialFolderTree.find((folder) => folder.id === id)?.name ?? "Vault root")} onOpenTab={onOpenTab} />;
}
