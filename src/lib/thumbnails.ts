import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import sharp from "sharp";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

export type VideoThumbnailResult = {
  thumbnailBuffer: Buffer;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
};

function probeFile(
  inputPath: string,
): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      const videoStream = metadata.streams.find((s) => s.codec_type === "video");
      resolve({
        duration: metadata.format.duration,
        width: videoStream?.width,
        height: videoStream?.height,
      });
    });
  });
}

function extractFrame(inputPath: string, outputPath: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(seconds)
      .frames(1)
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

// sourceUrl is a presigned S3 URL — ffmpeg range-requests only what it needs,
// so we never download the entire video file into memory.
export async function generateVideoThumbnail(sourceUrl: string): Promise<VideoThumbnailResult> {
  const id = randomUUID();
  const framePath = path.join(os.tmpdir(), `${id}_frame.jpg`);

  try {
    const meta = await probeFile(sourceUrl);

    // Seek to 1s, or 0 if the video is shorter than 1s
    const seekTo = (meta.duration ?? 0) > 1 ? 1 : 0;
    await extractFrame(sourceUrl, framePath, seekTo);

    const rawFrame = await fs.readFile(framePath);
    const thumbnailBuffer = await sharp(rawFrame)
      .resize({ width: 400, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    return {
      thumbnailBuffer,
      durationSeconds: meta.duration ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
    };
  } finally {
    await fs.rm(framePath, { force: true });
  }
}

export async function generateImageThumbnail(sourceBuffer: Buffer): Promise<Buffer> {
  return sharp(sourceBuffer)
    .resize({ width: 400, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}
