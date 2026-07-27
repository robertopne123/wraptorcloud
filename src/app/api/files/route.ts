import { NextResponse } from "next/server";
import { createFile, listFiles } from "@/lib/db/queries";
import { mediaTypeFromContentType } from "@/lib/media";

export async function GET() {
  const files = await listFiles();
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

  const mediaType = typeof contentType === "string" ? mediaTypeFromContentType(contentType) : null;
  if (!mediaType) {
    return NextResponse.json(
      { error: "contentType must be video/* or image/*" },
      { status: 400 },
    );
  }

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

  return NextResponse.json({ file }, { status: 201 });
}
