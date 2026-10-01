import { NextResponse } from "next/server";
import { getFile, getFileVersion } from "@/lib/db/queries";
import { presignFileViewUrl } from "@/lib/s3";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await params;
  const [current, version] = await Promise.all([getFile(id), getFileVersion(id, versionId)]);
  if (!current || !version) return NextResponse.json({ error: "Version not found" }, { status: 404 });
  const attachment = new URL(request.url).searchParams.get("disposition") === "attachment";
  return NextResponse.json({ url: await presignFileViewUrl({ ...current, ...version }, { attachment }) });
}
