import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, S3_BUCKET_NAME } from "@/lib/s3";
import { getFile } from "@/lib/db/queries";
import { contentDispositionAttachment } from "@/lib/media";

const VIEW_URL_EXPIRY_SECONDS = 60 * 60;

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

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: file.s3_key,
    ...(isAttachment
      ? { ResponseContentDisposition: contentDispositionAttachment(file.display_name) }
      : {}),
  });

  // Always generated fresh — never cached or persisted.
  const url = await getSignedUrl(s3Client, command, { expiresIn: VIEW_URL_EXPIRY_SECONDS });

  return NextResponse.json({ url, mediaType: file.media_type, displayName: file.display_name });
}
