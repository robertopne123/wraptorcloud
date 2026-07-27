import { NextResponse } from "next/server";
import { presignFileViewUrl } from "@/lib/s3";
import { getActiveShareLinkByToken, getFile, isFolderOrDescendant } from "@/lib/db/queries";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; fileId: string }> },
) {
  const { token, fileId } = await params;
  const { searchParams } = new URL(request.url);
  const wantsAttachment = searchParams.get("disposition") === "attachment";

  const share = await getActiveShareLinkByToken(token);
  if (!share) {
    return NextResponse.json(
      { error: "This link has expired or doesn't exist" },
      { status: 404 },
    );
  }

  const file = await getFile(fileId);
  if (!file) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // The file must actually be covered by this share — either it's the
  // shared file itself, or it lives somewhere inside the shared folder's
  // subtree. Never trust the frontend for this: a direct URL swap with an
  // arbitrary fileId must fail here regardless of what the UI shows.
  const isCovered = share.file_id
    ? share.file_id === fileId
    : share.folder_id && file.folder_id
      ? await isFolderOrDescendant(share.folder_id, file.folder_id)
      : false;

  if (!isCovered) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // Same rule for downloads: the share's permission is enforced here, not
  // just by hiding the download button client-side.
  if (wantsAttachment && share.permission !== "download") {
    return NextResponse.json(
      { error: "This share link doesn't allow downloads" },
      { status: 403 },
    );
  }

  const url = await presignFileViewUrl(file, { attachment: wantsAttachment });

  return NextResponse.json({ url, mediaType: file.media_type, displayName: file.display_name });
}
