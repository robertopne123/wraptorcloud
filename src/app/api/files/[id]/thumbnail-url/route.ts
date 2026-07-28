import { NextResponse } from "next/server";
import { getFile } from "@/lib/db/queries";
import { presignKeyUrl } from "@/lib/s3";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const file = await getFile(id);
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  if (!file.thumbnail_key) {
    return NextResponse.json({ url: null });
  }

  const url = await presignKeyUrl(file.thumbnail_key);
  return NextResponse.json({ url });
}
