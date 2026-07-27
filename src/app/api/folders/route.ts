import { NextResponse } from "next/server";
import { createFolder, listFiles, listFolders } from "@/lib/db/queries";
import { isForeignKeyViolation } from "@/lib/db/errors";
import { parseNullableIdParam } from "@/lib/id-param";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parentId = parseNullableIdParam(searchParams.get("parentId"));

  const [folders, files] = await Promise.all([listFolders(parentId), listFiles(parentId)]);

  return NextResponse.json({ folders, files });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, parentId } = body ?? {};

  if (typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  if (parentId !== null && parentId !== undefined && typeof parentId !== "string") {
    return NextResponse.json({ error: "parentId must be a string or null" }, { status: 400 });
  }

  try {
    const folder = await createFolder({ name: name.trim(), parentId: parentId ?? null });
    return NextResponse.json({ folder }, { status: 201 });
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return NextResponse.json({ error: "parentId does not exist" }, { status: 400 });
    }
    throw error;
  }
}
