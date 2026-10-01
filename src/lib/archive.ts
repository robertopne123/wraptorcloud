import AdmZip from "adm-zip";
import { gunzipSync } from "node:zlib";
import tar from "tar-stream";
import type { ArchiveItem } from "./preview-types";

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 2000;
export type ArchiveContent = ArchiveItem & { read: () => Buffer };

export function archivePath(value: string): string {
  const path = value.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || path.includes("\0")
    || path.split("/").some((part) => !part.trim() || part === ".." || part === ".")) {
    throw new Error("Archive contains an unsafe path");
  }
  return path;
}

function validateEntries(entries: ArchiveContent[]) {
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("Archive contains more than 2,000 entries");
  let size = 0;
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Invalid archive entry size");
    size += entry.size;
    if (size > MAX_EXPANDED_BYTES) throw new Error("Archive expands beyond the 250 MB preview limit");
    const path = entry.path.toLowerCase();
    if (paths.has(path)) throw new Error("Archive contains duplicate paths");
    paths.add(path);
  }
  // A file cannot also be a parent directory.
  const files = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.path.toLowerCase()));
  for (const entry of entries) {
    const parts = entry.path.toLowerCase().split("/");
    parts.pop();
    while (parts.length) {
      if (files.has(parts.join("/"))) throw new Error("Archive contains conflicting file and folder paths");
      parts.pop();
    }
  }
  return entries;
}

export async function readArchive(buffer: Buffer, name: string): Promise<ArchiveContent[]> {
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds the 100 MB preview limit");
  if (name.toLowerCase().endsWith(".zip") || (buffer.length >= 4 && [0x04034b50, 0x06054b50].includes(buffer.readUInt32LE(0)))) {
    const zip = new AdmZip(buffer);
    return validateEntries(zip.getEntries().map((entry) => {
      if (entry.header.flags & 1) throw new Error("Password-protected archives cannot be previewed");
      const mode = (entry.header.attr >>> 16) & 0xf000;
      if (mode === 0xa000) throw new Error("Archive contains a symbolic link");
      return {
        path: archivePath(entry.entryName), size: entry.header.size, directory: entry.isDirectory,
        read: () => {
          const data = entry.getData();
          if (data.length !== entry.header.size) throw new Error("Archive entry size mismatch");
          return data;
        },
      };
    }));
  }
  const gzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
  const source = gzip
    ? gunzipSync(buffer, { maxOutputLength: MAX_EXPANDED_BYTES }) : buffer;
  if (gzip && !/\.(tar\.gz|tgz)$/i.test(name) && source.subarray(257, 262).toString() !== "ustar") {
    return validateEntries([{ path: archivePath(name.replace(/\.gz$/i, "") || "extracted-file"), size: source.length, directory: false, read: () => source }]);
  }
  const extract = tar.extract();
  const entries: ArchiveContent[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    extract.on("error", reject);
    extract.on("finish", resolve);
    extract.on("entry", (header, stream, next) => {
      try {
        if (header.type !== "file" && header.type !== "directory") throw new Error("Archive contains unsupported links or special files");
        // Many TAR writers include an explicit ./ root entry.
        if (header.type === "directory" && /^(\.\/)*\.?$/.test(header.name)) {
          stream.resume(); stream.on("end", next); return;
        }
        const path = archivePath(header.name);
        total += header.size ?? 0;
        if (total > MAX_EXPANDED_BYTES || entries.length >= MAX_ARCHIVE_ENTRIES) throw new Error("Archive exceeds preview limits");
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => { chunks.push(Buffer.from(chunk as Uint8Array)); });
        stream.on("error", reject);
        stream.on("end", () => {
          const data = Buffer.concat(chunks);
          entries.push({ path, size: data.length, directory: header.type === "directory", read: () => data });
          next();
        });
      } catch (error) { extract.destroy(error as Error); }
    });
    extract.end(source);
  });
  return validateEntries(entries);
}
