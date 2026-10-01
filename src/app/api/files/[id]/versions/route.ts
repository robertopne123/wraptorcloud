import { NextResponse } from "next/server";
import { getFile, listFileVersions } from "@/lib/db/queries";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = await getFile(id);
  if (!current) return NextResponse.json({ error: "File not found" }, { status: 404 });
  return NextResponse.json({ current, versions: await listFileVersions(id) });
}
