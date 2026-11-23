import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { contentDispositionAttachment } from "@/lib/media";
import type { FileRecord } from "@/lib/db/types";
import { createHetznerObjectStorage } from "./storage-config";

let objectStorage: ReturnType<typeof createHetznerObjectStorage> | undefined;
export function getObjectStorage() {
  return objectStorage ??= createHetznerObjectStorage();
}

export async function openObject(key: string, signal?: AbortSignal) {
  const { client, bucket } = getObjectStorage();
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
}

const VIEW_URL_EXPIRY_SECONDS = 60 * 60;

export async function getObjectBuffer(key: string, maxBytes = Infinity): Promise<Buffer> {
  const response = await openObject(key);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("File is too large for this preview");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<void> {
  const { client, bucket } = getObjectStorage();
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }),
  );
}

export async function presignKeyUrl(key: string): Promise<string> {
  const { client, bucket } = getObjectStorage();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn: VIEW_URL_EXPIRY_SECONDS });
}

// Always generates fresh — never cache or persist the result.
export async function presignFileViewUrl(
  file: FileRecord,
  { attachment, contentType }: { attachment: boolean; contentType?: string },
): Promise<string> {
  const { client, bucket } = getObjectStorage();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: file.s3_key,
    ...(contentType ? { ResponseContentType: contentType, ResponseContentDisposition: "inline" } : {}),
    ...(attachment
      ? { ResponseContentDisposition: contentDispositionAttachment(file.display_name) }
      : {}),
  });

  return getSignedUrl(client, command, { expiresIn: VIEW_URL_EXPIRY_SECONDS });
}
