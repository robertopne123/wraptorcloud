import { NextResponse } from "next/server";
import { deleteShareLinkByToken } from "@/lib/db/queries";
import { resolveShare } from "@/lib/share";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const { searchParams } = new URL(request.url);
  const requestedFolderId = searchParams.get("folderId");

  const resolution = await resolveShare(token, requestedFolderId);

  switch (resolution.kind) {
    case "not-found":
      return NextResponse.json(
        { error: "This link has expired or doesn't exist" },
        { status: 404 },
      );
    case "forbidden":
      return NextResponse.json({ error: "That folder isn't part of this share" }, { status: 403 });
    case "file":
      return NextResponse.json({
        type: "file",
        permission: resolution.permission,
        file: resolution.file,
      });
    case "folder":
      return NextResponse.json({
        type: "folder",
        permission: resolution.permission,
        sharedFolder: resolution.sharedFolder,
        folder: resolution.folder,
        breadcrumb: resolution.breadcrumb,
        folders: resolution.folders,
        files: resolution.files,
      });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const deleted = await deleteShareLinkByToken(token);

  if (!deleted) {
    return NextResponse.json({ error: "Share link not found" }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}
