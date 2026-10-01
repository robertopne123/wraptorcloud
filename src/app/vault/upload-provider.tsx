"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { uploadQueue } from "@/lib/uploads/queue";

export function useUploads() {
  return useSyncExternalStore(uploadQueue.subscribe, uploadQueue.getSnapshot, uploadQueue.getServerSnapshot);
}

export function UploadProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void uploadQueue.start().then(() => uploadQueue.pump());
    const resume = () => uploadQueue.pump();
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, []);
  return children;
}
