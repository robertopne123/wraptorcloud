import { NextResponse } from "next/server";
import { moveFile, renameFile, softDeleteFile } from "@/lib/db/queries";
import { isForeignKeyViolation } from "@/lib/db/errors";
import type { FileRecord } from "@/lib/db/types";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { displayName, folderId } = body ?? {};

  if (displayName === undefined && folderId === undefined) {
    return NextResponse.json(
      { error: "displayName or folderId is required" },
      { status: 400 },
    );
  }

  let updated: FileRecord | null = null;

  if (displayName !== undefined) {
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      return NextResponse.json(
        { error: "displayName must be a non-empty string" },
        { status: 400 },
      );
    }
    updated = await renameFile(id, displayName.trim());
    if (!updated) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  }

  if (folderId !== undefined) {
    if (folderId !== null && typeof folderId !== "string") {
      return NextResponse.json({ error: "folderId must be a string or null" }, { status: 400 });
    }

    try {
      updated = await moveFile(id, folderId);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        return NextResponse.json({ error: "folderId does not exist" }, { status: 400 });
      }
      throw error;
    }

    if (!updated) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  }

  return NextResponse.json({ file: updated });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const deleted = await softDeleteFile(id);

  if (!deleted) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  return NextResponse.json({ file: deleted });
}
