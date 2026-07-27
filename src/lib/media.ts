import type { MediaType } from "@/lib/db/types";

export function mediaTypeFromContentType(contentType: string): MediaType | null {
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("image/")) return "image";
  return null;
}
