import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  createShareLink,
  getFile,
  getFolder,
  listShareLinksForFile,
  listShareLinksForFolder,
} from "@/lib/db/queries";
import type { SharePermission } from "@/lib/db/types";

const VALID_PERMISSIONS: SharePermission[] = ["view", "download"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get("fileId");
  const folderId = searchParams.get("folderId");

  if ((fileId && folderId) || (!fileId && !folderId)) {
    return NextResponse.json(
      { error: "Provide exactly one of fileId or folderId" },
      { status: 400 },
    );
  }

  const shareLinks = fileId
    ? await listShareLinksForFile(fileId)
    : await listShareLinksForFolder(folderId!);

  return NextResponse.json({ shareLinks });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { fileId, folderId, permission, expiresInDays } = body ?? {};

  if ((fileId && folderId) || (!fileId && !folderId)) {
    return NextResponse.json(
      { error: "Provide exactly one of fileId or folderId" },
      { status: 400 },
    );
  }

  if (fileId !== undefined && fileId !== null && typeof fileId !== "string") {
    return NextResponse.json({ error: "fileId must be a string" }, { status: 400 });
  }
  if (folderId !== undefined && folderId !== null && typeof folderId !== "string") {
    return NextResponse.json({ error: "folderId must be a string" }, { status: 400 });
  }

  if (!VALID_PERMISSIONS.includes(permission)) {
    return NextResponse.json(
      { error: "permission must be 'view' or 'download'" },
      { status: 400 },
    );
  }

  if (expiresInDays !== null && (typeof expiresInDays !== "number" || expiresInDays <= 0)) {
    return NextResponse.json(
      { error: "expiresInDays must be a positive number or null" },
      { status: 400 },
    );
  }

  if (fileId) {
    const file = await getFile(fileId);
    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  } else {
    const folder = await getFolder(folderId);
    if (!folder) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }
  }

  const expiresAt =
    expiresInDays === null ? null : new Date(Date.now() + expiresInDays * MS_PER_DAY).toISOString();

  const shareLink = await createShareLink({
    token: randomUUID(),
    fileId: fileId ?? null,
    folderId: folderId ?? null,
    permission,
    expiresAt,
  });

  return NextResponse.json({ shareLink }, { status: 201 });
}
