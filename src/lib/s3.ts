import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { contentDispositionAttachment } from "@/lib/media";
import type { FileRecord } from "@/lib/db/types";
import { createHetznerObjectStorage, createObjectStorage } from "./storage-config";

export const { client: s3Client, bucket: S3_BUCKET_NAME } = createObjectStorage();
const currentStorage = { client: s3Client, bucket: S3_BUCKET_NAME };
let hetznerStorage: ReturnType<typeof createHetznerObjectStorage> | undefined;

export function storageForWrite(key: string) {
  return key.startsWith("hetzner/")
    ? (hetznerStorage ??= createHetznerObjectStorage())
    : currentStorage;
}

async function storageForRead(key: string) {
  const storage = storageForWrite(key);
  if (process.env.VAULT_OBJECT_STORAGE !== "hetzner" || key.startsWith("hetzner/")) return storage;
  const target = hetznerStorage ??= createHetznerObjectStorage();
  try {
    await target.client.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
    return target;
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    return storage;
  }
}

export async function openObject(key: string, signal?: AbortSignal) {
  const { client, bucket } = await storageForRead(key);
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
  const { client, bucket } = storageForWrite(key);
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }),
  );
}

export async function presignKeyUrl(key: string): Promise<string> {
  const { client, bucket } = await storageForRead(key);
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn: VIEW_URL_EXPIRY_SECONDS });
}

// Always generates fresh — never cache or persist the result.
export async function presignFileViewUrl(
  file: FileRecord,
  { attachment, contentType }: { attachment: boolean; contentType?: string },
): Promise<string> {
  const { client, bucket } = await storageForRead(file.s3_key);
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
