import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { contentDispositionAttachment } from "@/lib/media";
import type { FileRecord } from "@/lib/db/types";

export const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  },
});

export const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME ?? "";

const VIEW_URL_EXPIRY_SECONDS = 60 * 60;

// Always generates fresh — never cache or persist the result.
export async function presignFileViewUrl(
  file: FileRecord,
  { attachment }: { attachment: boolean },
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: file.s3_key,
    ...(attachment
      ? { ResponseContentDisposition: contentDispositionAttachment(file.display_name) }
      : {}),
  });

  return getSignedUrl(s3Client, command, { expiresIn: VIEW_URL_EXPIRY_SECONDS });
}
