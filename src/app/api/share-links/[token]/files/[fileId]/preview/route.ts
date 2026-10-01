import { NextResponse } from "next/server";
import { getActiveShareLinkByToken, getFile, isFolderOrDescendant } from "@/lib/db/queries";
import { archiveEntry, previewFile } from "@/lib/file-preview";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: Request, { params }: { params: Promise<{ token: string; fileId: string }> }) {
  const { token, fileId } = await params;
  const share = await getActiveShareLinkByToken(token);
  if (!share) return NextResponse.json({ error: "This link has expired or doesn't exist" }, { status: 404 });
  const file = await getFile(fileId);
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });
  const covered = share.file_id ? share.file_id === fileId
    : share.folder_id && file.folder_id ? await isFolderOrDescendant(share.folder_id, file.folder_id) : false;
  if (!covered) return NextResponse.json({ error: "File not found" }, { status: 404 });
  const entry = new URL(request.url).searchParams.get("entry");
  if (entry !== null && share.permission !== "download") {
    return NextResponse.json({ error: "This share link doesn't allow downloads" }, { status: 403 });
  }
  try {
    if (entry !== null) {
      const { data, contentType } = await archiveEntry(file, entry);
      return new Response(new Uint8Array(data), { headers: { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment" } });
    }
    return NextResponse.json(await previewFile(file), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[shared-preview]", file.id, error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not preview this file" }, { status: 422 });
  }
}
