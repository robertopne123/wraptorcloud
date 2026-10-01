import { NextResponse } from "next/server";
import { getFile } from "@/lib/db/queries";
import { archiveEntry, previewFile } from "@/lib/file-preview";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const file = await getFile((await params).id);
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });
  try {
    const entry = new URL(request.url).searchParams.get("entry");
    if (entry !== null) {
      const { data, contentType } = await archiveEntry(file, entry);
      return new Response(new Uint8Array(data), { headers: { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment" } });
    }
    return NextResponse.json(await previewFile(file), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[preview]", file.id, error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not preview this file" }, { status: 422 });
  }
}
