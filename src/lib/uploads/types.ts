import type { FileRecord } from "../db/types";
export type ConflictAction = "version" | "replace" | "skip";

export type UploadJob = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  folderId: string | null;
  folderName: string;
  createdAt: number;
  status: "queued" | "uploading" | "conflict" | "done" | "failed" | "skipped";
  progress: number;
  uploadId?: string;
  partSize: number;
  error?: string;
  result?: FileRecord;
  batchId?: string;
  defaultConflictAction?: ConflictAction;
  conflictAction?: ConflictAction;
  conflict?: FileRecord;
};

export function uploadPartSize(size: number): number {
  // S3 permits at most 10,000 parts; round up to whole MiB.
  return Math.max(10, Math.ceil(size / 9999 / 1024 / 1024)) * 1024 * 1024;
}
