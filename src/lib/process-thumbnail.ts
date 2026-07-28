import type { MediaType } from "./db/types";
import { updateFileThumbnail } from "./db/queries";
import { getObjectBuffer, presignKeyUrl, uploadBuffer } from "./s3";
import { generateVideoThumbnail, generateImageThumbnail } from "./thumbnails";

export async function processThumbnail(
  fileId: string,
  s3Key: string,
  mediaType: MediaType,
): Promise<void> {
  const thumbnailKey = `thumbnails/${fileId}.jpg`;

  if (mediaType === "video") {
    // Pass a presigned URL so ffmpeg can range-request the file without us
    // downloading the whole thing into memory first.
    const sourceUrl = await presignKeyUrl(s3Key);
    const { thumbnailBuffer, durationSeconds, width, height } =
      await generateVideoThumbnail(sourceUrl);
    await uploadBuffer(thumbnailKey, thumbnailBuffer, "image/jpeg");
    await updateFileThumbnail(fileId, { thumbnailKey, durationSeconds, width, height });
  } else if (mediaType === "image") {
    const sourceBuffer = await getObjectBuffer(s3Key);
    const thumbnailBuffer = await generateImageThumbnail(sourceBuffer);
    await uploadBuffer(thumbnailKey, thumbnailBuffer, "image/jpeg");
    await updateFileThumbnail(fileId, {
      thumbnailKey,
      durationSeconds: null,
      width: null,
      height: null,
    });
  }
}
