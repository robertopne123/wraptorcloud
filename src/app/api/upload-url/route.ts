import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client, S3_BUCKET_NAME } from "@/lib/s3";
import { mediaTypeFromContentType } from "@/lib/media";

const PRESIGNED_URL_EXPIRY_SECONDS = 10 * 60;

function extensionFromFilename(filename: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
  return match ? `.${match[1]}` : "";
}

export async function POST(request: Request) {
  const body = await request.json();
  const { filename, contentType, sizeBytes } = body ?? {};

  if (typeof filename !== "string" || filename.length === 0) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }

  if (typeof contentType !== "string" || !mediaTypeFromContentType(contentType)) {
    return NextResponse.json(
      { error: "contentType must be video/* or image/*" },
      { status: 400 },
    );
  }

  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return NextResponse.json(
      { error: "sizeBytes must be a positive number" },
      { status: 400 },
    );
  }

  const fileId = randomUUID();
  const s3Key = `footage/${fileId}${extensionFromFilename(filename)}`;

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: s3Key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  });

  return NextResponse.json({ uploadUrl, s3Key, fileId });
}
