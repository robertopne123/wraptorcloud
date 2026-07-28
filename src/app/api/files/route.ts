import { NextResponse } from "next/server";
import { createFile, listFiles } from "@/lib/db/queries";
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
  const { s3Key, displayName, contentType, sizeBytes, folderId } = body ?? {};

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

  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return NextResponse.json(
      { error: "sizeBytes must be a positive number" },
      { status: 400 },
    );
  }

  if (folderId !== null && folderId !== undefined && typeof folderId !== "string") {
    return NextResponse.json({ error: "folderId must be a string or null" }, { status: 400 });
  }

  const file = await createFile({
    s3Key,
    displayName,
    mimeType: contentType,
    mediaType,
    sizeBytes,
    folderId: folderId ?? null,
  });

  // Fire-and-forget — don't hold the response waiting for thumbnail generation.
  processThumbnail(file.id, s3Key, mediaType).catch((err) => {
    console.error("[thumbnail] Failed for file", file.id, err);
  });

  return NextResponse.json({ file }, { status: 201 });
}
