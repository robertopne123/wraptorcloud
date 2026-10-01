import type { MediaType } from "./db/types";
import { updateFileThumbnail } from "./db/queries";
import { getObjectBuffer, presignKeyUrl, uploadBuffer } from "./s3";
import { generateVideoThumbnail, generateImageThumbnail } from "./thumbnails";
import { createHash } from "node:crypto";

type ThumbnailWork = { active: number; waiting: (() => void)[]; jobs: Map<string, Promise<void>> };
const globalForThumbnails = globalThis as unknown as { thumbnailWork?: ThumbnailWork };
const work: ThumbnailWork = globalForThumbnails.thumbnailWork ??= { active: 0, waiting: [], jobs: new Map() };

// Large upload batches must not launch unbounded FFmpeg processes or image buffers.
export function processThumbnail(fileId: string, s3Key: string, mediaType: MediaType): Promise<void> {
  if (mediaType === "other") return Promise.resolve();
  const jobKey = `${fileId}:${s3Key}`;
  const existing = work.jobs.get(jobKey);
  if (existing) return existing;
  const pending = (async () => {
    if (work.active >= 2) await new Promise<void>((resolve) => work.waiting.push(resolve));
    else work.active++;
    try { await generateThumbnail(fileId, s3Key, mediaType); }
    finally {
      const next = work.waiting.shift();
      if (next) next();
      else work.active--;
    }
  })().finally(() => { work.jobs.delete(jobKey); });
  work.jobs.set(jobKey, pending);
  return pending;
}

async function generateThumbnail(
  fileId: string,
  s3Key: string,
  mediaType: MediaType,
): Promise<void> {
  const thumbnailKey = `thumbnails/${fileId}-${createHash("sha256").update(s3Key).digest("hex").slice(0, 24)}.jpg`;

  if (mediaType === "video") {
    // Pass a presigned URL so ffmpeg can range-request the file without us
    // downloading the whole thing into memory first.
    const sourceUrl = await presignKeyUrl(s3Key);
    const { thumbnailBuffer, durationSeconds, width, height } =
      await generateVideoThumbnail(sourceUrl);
    await uploadBuffer(thumbnailKey, thumbnailBuffer, "image/jpeg");
    await updateFileThumbnail(fileId, { s3Key, thumbnailKey, durationSeconds, width, height });
  } else if (mediaType === "image") {
    const sourceBuffer = await getObjectBuffer(s3Key);
    const thumbnailBuffer = await generateImageThumbnail(sourceBuffer);
    await uploadBuffer(thumbnailKey, thumbnailBuffer, "image/jpeg");
    await updateFileThumbnail(fileId, {
      thumbnailKey,
      s3Key,
      durationSeconds: null,
      width: null,
      height: null,
    });
  }
}
