import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

const nextConfig: NextConfig = {
  allowedDevOrigins: Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).filter((address) => address.family === "IPv4" && !address.internal).map((address) => address.address),
  ),
  serverExternalPackages: ["fluent-ffmpeg", "@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe", "sharp", "archiver", "adm-zip", "mammoth", "exceljs", "tar-stream"],
};

export default nextConfig;
