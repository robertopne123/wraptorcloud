import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["fluent-ffmpeg", "@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe", "sharp", "archiver", "adm-zip", "mammoth", "exceljs", "tar-stream"],
};

export default nextConfig;
