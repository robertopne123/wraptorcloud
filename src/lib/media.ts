import type { MediaType } from "@/lib/db/types";

export function mediaTypeFromContentType(contentType: string): MediaType | null {
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("image/")) return "image";
  return null;
}

// RFC 5987 encoding: an ASCII-safe fallback plus a UTF-8 extended value, so
// filenames with non-ASCII characters or quotes still download correctly.
export function contentDispositionAttachment(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
