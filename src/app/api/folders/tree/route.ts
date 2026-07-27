import { NextResponse } from "next/server";
import { listAllFolders } from "@/lib/db/queries";

// Flat list of every folder, used by the client to build the move-picker
// tree without a round trip per level. Fine at this scale for an internal
// tool; would need pagination if folder counts grew very large.
export async function GET() {
  const folders = await listAllFolders();
  return NextResponse.json({ folders });
}
