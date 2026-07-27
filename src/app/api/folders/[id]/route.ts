import { NextResponse } from "next/server";
import {
  deleteFolder,
  getFolder,
  isFolderOrDescendant,
  moveFolder,
  renameFolder,
} from "@/lib/db/queries";
import { isForeignKeyViolation } from "@/lib/db/errors";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { name, parentId } = body ?? {};

  const existing = await getFolder(id);
  if (!existing) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  if (name === undefined && parentId === undefined) {
    return NextResponse.json({ error: "name or parentId is required" }, { status: 400 });
  }

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    await renameFolder(id, name.trim());
  }

  if (parentId !== undefined) {
    if (parentId !== null && typeof parentId !== "string") {
      return NextResponse.json({ error: "parentId must be a string or null" }, { status: 400 });
    }

    if (parentId !== null && (await isFolderOrDescendant(id, parentId))) {
      return NextResponse.json(
        { error: "Cannot move a folder into itself or one of its own subfolders" },
        { status: 400 },
      );
    }

    try {
      await moveFolder(id, parentId);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        return NextResponse.json({ error: "parentId does not exist" }, { status: 400 });
      }
      throw error;
    }
  }

  const updated = await getFolder(id);
  return NextResponse.json({ folder: updated });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const existing = await getFolder(id);
  if (!existing) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  await deleteFolder(id);
  return new NextResponse(null, { status: 204 });
}
