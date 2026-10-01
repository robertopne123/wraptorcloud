import { after, NextResponse } from "next/server";
import { createFile, FileConflictError, listFiles } from "@/lib/db/queries";
import { mediaTypeFromContentType } from "@/lib/media";
import { parseNullableIdParam } from "@/lib/id-param";
import { processThumbnail } from "@/lib/process-thumbnail";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const folderId = parseNullableIdParam(searchParams.get("folderId"));
  const files = await listFiles(folderId);
  return NextResponse.json({ files });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { s3Key, displayName, contentType, sizeBytes, folderId, conflictAction, targetFileId, expectedS3Key } = body ?? {};

  if (typeof s3Key !== "string" || s3Key.length === 0) {
    return NextResponse.json({ error: "s3Key is required" }, { status: 400 });
  }

  if (typeof displayName !== "string" || displayName.length === 0) {
    return NextResponse.json({ error: "displayName is required" }, { status: 400 });
  }

  if (typeof contentType !== "string" || contentType.length === 0) {
    return NextResponse.json({ error: "contentType is required" }, { status: 400 });
  }
  const mediaType = mediaTypeFromContentType(contentType);

  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return NextResponse.json(
      { error: "sizeBytes must be a non-negative integer" },
      { status: 400 },
    );
  }

  if (folderId !== null && folderId !== undefined && typeof folderId !== "string") {
    return NextResponse.json({ error: "folderId must be a string or null" }, { status: 400 });
  }

  if (conflictAction !== undefined && conflictAction !== "version" && conflictAction !== "replace") {
    return NextResponse.json({ error: "Invalid duplicate-file action" }, { status: 400 });
  }
  if (conflictAction && (typeof targetFileId !== "string" || typeof expectedS3Key !== "string")) {
    return NextResponse.json({ error: "Missing duplicate-file details" }, { status: 400 });
  }
  let file;
  try {
    file = await createFile({
    s3Key,
    displayName,
    mimeType: contentType,
    mediaType,
    sizeBytes,
    folderId: folderId ?? null,
    conflictAction, targetFileId, expectedS3Key,
  });
  } catch (error) {
    if (error instanceof FileConflictError) {
      return NextResponse.json({ error: error.message, code: "FileConflict", file: error.file }, { status: 409 });
    }
    throw error;
  }

  // Keep background work attached to the request lifecycle without delaying uploads.
  if (!file.thumbnail_key && mediaType !== "other") {
    after(() => processThumbnail(file.id, s3Key, mediaType).catch((err) => {
      console.error("[thumbnail] Failed for file", file.id, err);
    }));
  }

  return NextResponse.json({ file }, { status: 201 });
}
