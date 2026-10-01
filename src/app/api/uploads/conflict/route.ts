import { NextResponse } from "next/server";
import { checkUploadConflict } from "@/lib/db/queries";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { id, name, folderId } = body ?? {};
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || typeof name !== "string" || !name.length
    || (folderId !== null && (typeof folderId !== "string" || !/^[0-9a-f-]{36}$/i.test(folderId)))) {
    return NextResponse.json({ error: "Invalid file or folder details" }, { status: 400 });
  }
  return NextResponse.json(await checkUploadConflict(`footage/${id}`, name, folderId));
}
