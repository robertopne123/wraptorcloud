import { NextResponse } from "next/server";
import { getFile } from "@/lib/db/queries";
import { processThumbnail } from "@/lib/process-thumbnail";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const file = await getFile(id);
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  if (file.media_type !== "image" && file.media_type !== "video") {
    return NextResponse.json({ error: "Only images and videos have previews" }, { status: 400 });
  }

  try {
    await processThumbnail(file.id, file.s3_key, file.media_type);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[thumbnail] Refresh failed for file", file.id, error);
    return NextResponse.json(
      { error: "Could not refresh preview. Please try again." },
      { status: 500 },
    );
  }
}
