import { NextResponse } from "next/server";
import { presignFileViewUrl } from "@/lib/s3";
import { getFile } from "@/lib/db/queries";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const isAttachment = searchParams.get("disposition") === "attachment";

  const file = await getFile(id);
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const url = await presignFileViewUrl(file, { attachment: isAttachment });

  return NextResponse.json({ url, mediaType: file.media_type, displayName: file.display_name });
}
